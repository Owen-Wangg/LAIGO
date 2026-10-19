import os
import json
import boto3
import psycopg
import time
import re
from botocore.exceptions import ClientError
from aws_lambda_powertools import Logger, Metrics
from bedrock_client import get_bedrock_runtime_client

from helpers.usage import check_and_increment_usage, is_disclaimer_accepted

# Set up logging and metrics for the Lambda function
logger = Logger(service="AssessProgress")
metrics = Metrics(namespace="LAIGO", service="AssessProgress")

# Environment variables
DB_SECRET_NAME = os.environ["SM_DB_CREDENTIALS"]
REGION = os.environ["REGION"]
RDS_PROXY_ENDPOINT = os.environ["RDS_PROXY_ENDPOINT"]
BEDROCK_LLM_PARAM = os.environ["BEDROCK_LLM_PARAM"]
TABLE_NAME_PARAM = os.environ["TABLE_NAME_PARAM"]
BEDROCK_TEMP_PARAM = os.environ.get("BEDROCK_TEMP_PARAM")
BEDROCK_TOP_P_PARAM = os.environ.get("BEDROCK_TOP_P_PARAM")
BEDROCK_MAX_TOKENS_PARAM = os.environ.get("BEDROCK_MAX_TOKENS_PARAM")
MESSAGE_LIMIT_PARAM = os.environ["MESSAGE_LIMIT_PARAM"]

# AWS Clients
secrets_manager_client = boto3.client("secretsmanager")
ssm_client = boto3.client("ssm", region_name=REGION)
dynamodb_client = boto3.client("dynamodb")
bedrock_runtime = get_bedrock_runtime_client(region_name=REGION)

# Cached resources
connection = None
db_secret = None
BEDROCK_LLM_ID = None
TABLE_NAME = None
BEDROCK_TEMP = 0.0
BEDROCK_TOP_P = 0.9
BEDROCK_MAX_TOKENS = 512
MESSAGE_LIMIT = None
PLAYGROUND_TABLE_NAME = os.environ.get("PLAYGROUND_TABLE_NAME")


def _is_anthropic_model(model_id: str) -> bool:
    """Check if a model ID refers to an Anthropic model (direct or inference profile)."""
    return model_id.startswith("anthropic.") or "anthropic" in model_id


def _is_meta_model(model_id: str) -> bool:
    """Check if a model ID refers to a Meta model (direct or inference profile)."""
    return model_id.startswith("meta.") or "meta" in model_id


def _sampling_params_mode(model_id: str) -> str:
    """Return which sampling params a model accepts: 'both', 'single', or 'none'.

    - Meta/Llama and Claude 3.x accept both temperature and top_p.
    - Claude 4.x (e.g. Sonnet 4.5/4.6) accept only ONE of temperature/top_p.
    - Claude 5.x+ (e.g. Sonnet 5/5.5) accept NEITHER.
    """
    mid = (model_id or "").lower()
    if not (("anthropic" in mid) or ("claude" in mid)):
        return "both"
    for fam in ("sonnet", "opus", "haiku", "fable"):
        if f"claude-{fam}-5" in mid:
            return "none"
    for fam in ("sonnet", "opus", "haiku"):
        if f"claude-{fam}-4" in mid:
            return "single"
    return "both"


def _apply_sampling_params(body: dict, model_id: str, temperature, top_p) -> None:
    """Add temperature/top_p to an InvokeModel body according to the model's rules."""
    mode = _sampling_params_mode(model_id)
    if mode == "both":
        body["temperature"] = temperature
        body["top_p"] = top_p
    elif mode == "single":
        body["temperature"] = temperature
    # 'none': add neither


def _build_invoke_body(model_id, system_instructions, human_context):
    if _is_anthropic_model(model_id):
        body = {
            "anthropic_version": "bedrock-2023-05-31",
            "system": system_instructions,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": human_context,
                        }
                    ],
                }
            ],
            "max_tokens": BEDROCK_MAX_TOKENS,
        }
        _apply_sampling_params(body, model_id, BEDROCK_TEMP, BEDROCK_TOP_P)
        return body

    if _is_meta_model(model_id):
        # Llama 3 requires special chat template tokens for instruction following
        formatted_prompt = (
            f"<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n"
            f"{system_instructions}<|eot_id|>"
            f"<|start_header_id|>user<|end_header_id|>\n\n"
            f"{human_context}<|eot_id|>"
            f"<|start_header_id|>assistant<|end_header_id|>\n\n"
        )
        return {
            "prompt": formatted_prompt,
            "max_gen_len": BEDROCK_MAX_TOKENS,
            "temperature": BEDROCK_TEMP,
            "top_p": BEDROCK_TOP_P,
        }

    raise ValueError(f"Unsupported Bedrock model for InvokeModel: {model_id}")


def _extract_text_from_invoke_response(model_id, response):
    body = json.loads(response["body"].read())

    if _is_anthropic_model(model_id):
        parts = body.get("content", [])
        text_parts = [part.get("text", "") for part in parts if part.get("type") == "text"]
        return "".join(text_parts)

    if _is_meta_model(model_id):
        return body.get("generation") or body.get("output_text") or ""

    return body.get("outputText") or ""


def invoke_model_text(system_instructions, human_context):
    request_body = _build_invoke_body(BEDROCK_LLM_ID, system_instructions, human_context)
    
    response = bedrock_runtime.invoke_model(
        modelId=BEDROCK_LLM_ID,
        body=json.dumps(request_body),
        contentType="application/json",
        accept="application/json",
    )
    return _extract_text_from_invoke_response(BEDROCK_LLM_ID, response)


def _normalize_assessment_result(result):
    """Normalize parsed result into a safe {progress, reasoning} shape."""
    if not isinstance(result, dict):
        return None

    try:
        progress = int(result.get("progress", 0))
    except Exception:
        progress = 0

    progress = max(0, min(5, progress))
    reasoning = str(result.get("reasoning", "") or "").strip()
    if not reasoning:
        reasoning = "No reasoning provided."

    return {"progress": progress, "reasoning": reasoning}


def _try_parse_assessment_json(response_text):
    """
    Parse model output into assessment JSON with tolerant fallbacks.
    Returns normalized dict or None if parsing fails.
    """
    if not response_text:
        return None

    text = response_text.strip()

    # 1) Direct JSON parse.
    try:
        parsed = json.loads(text)
        return _normalize_assessment_result(parsed)
    except Exception:
        pass

    # 2) Strip markdown code fences and retry.
    fenced = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    fenced = re.sub(r"\s*```$", "", fenced)
    if fenced != text:
        try:
            parsed = json.loads(fenced.strip())
            return _normalize_assessment_result(parsed)
        except Exception:
            pass

    # 3) Extract first JSON object span and parse.
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        candidate = text[start : end + 1]
        try:
            parsed = json.loads(candidate)
            return _normalize_assessment_result(parsed)
        except Exception:
            pass

    # 4) Last resort: regex extraction for near-JSON outputs.
    progress_match = re.search(r'"?progress"?\s*[:=]\s*([0-9]+)', text, flags=re.IGNORECASE)
    reasoning_match = re.search(r'"?reasoning"?\s*[:=]\s*"([\s\S]*?)"', text, flags=re.IGNORECASE)
    if progress_match and reasoning_match:
        try:
            parsed = {
                "progress": int(progress_match.group(1)),
                "reasoning": reasoning_match.group(1).strip(),
            }
            return _normalize_assessment_result(parsed)
        except Exception:
            return None

    return None


def _invoke_assessment_with_retry(system_instructions, human_context, max_attempts=2):
    """
    Invoke model and parse assessment with bounded retries.
    Returns tuple: (normalized_result_or_none, final_response_text)
    """
    last_response_text = ""
    strict_suffix = "\n\nReturn ONLY strict JSON with exactly these keys: progress (integer 0-5) and reasoning (string)."

    for attempt in range(1, max_attempts + 1):
        prompt_context = human_context if attempt == 1 else f"{human_context}{strict_suffix}"
        response_text = invoke_model_text(system_instructions, prompt_context)
        last_response_text = response_text
        parsed = _try_parse_assessment_json(response_text)
        if parsed is not None:
            if attempt > 1:
                logger.info(f"Assessment parse succeeded on retry attempt {attempt}")
            return parsed, response_text
        logger.warning(f"Assessment parse failed on attempt {attempt}/{max_attempts}")

    return None, last_response_text


LOW_EFFORT_PATTERNS = [
    re.compile(r"^\s*(please\s+)?(analy[sz]e|summari[sz]e|review|evaluate|assess)\b", flags=re.IGNORECASE),
    re.compile(r"^\s*(what\s+are|tell\s+me|give\s+me)\b.*\b(facts|issues|summary|analysis)\b", flags=re.IGNORECASE),
]

SUBSTANTIVE_HINT_TOKENS = {
    "evidence",
    "timeline",
    "missing",
    "contradiction",
    "inconsisten",
    "source",
    "corroborat",
    "bias",
    "jurisdiction",
    "issue",
    "element",
    "counter",
    "assumption",
    "policy",
    "charter",
    "fairness",
    "standard",
    "burden",
    "liability",
    "defence",
    "defense",
    "damages",
}


def _parse_chat_history_lines(chat_history):
    """Parse formatted chat history into an ordered list of messages."""
    messages = []
    if not chat_history:
        return messages

    chunks = re.split(r"\n\n(?=(?:HUMAN|AI):)", chat_history)
    for raw in chunks:
        line = (raw or "").strip()
        if not line or ":" not in line:
            continue
        role, content = line.split(":", 1)
        role = role.strip().upper()
        content = content.strip()
        if role in {"HUMAN", "AI"} and content:
            messages.append({"role": role, "content": content})
    return messages


def _is_low_effort_prompt(message):
    text = (message or "").strip()
    if not text:
        return True

    lowered = text.lower()
    if len(lowered.split()) <= 3:
        return True

    return any(pattern.search(lowered) for pattern in LOW_EFFORT_PATTERNS)


def _is_substantive_human_message(message):
    text = (message or "").strip()
    if not text:
        return False

    if _is_low_effort_prompt(text):
        return False

    lowered = text.lower()
    word_count = len(lowered.split())
    has_question = "?" in text
    has_hint_token = any(token in lowered for token in SUBSTANTIVE_HINT_TOKENS)

    if word_count >= 12:
        return True
    if word_count >= 6 and (has_question or has_hint_token):
        return True
    return False


def _build_assessment_context(chat_history):
    """
    Build an assessment payload that preserves chronology while separating
    creditable human effort from assistant context.
    """
    parsed = _parse_chat_history_lines(chat_history)
    if not parsed:
        return {
            "formatted_context": "",
            "signals": {
                "total_turns": 0,
                "human_turns": 0,
                "assistant_turns": 0,
                "substantive_human_turns": 0,
                "has_meaningful_human_effort": False,
            },
        }

    ordered_lines = []
    human_lines = []
    assistant_lines = []
    substantive_human_turns = 0

    for idx, msg in enumerate(parsed, start=1):
        role = msg["role"]
        content = msg["content"]
        ordered_lines.append(f"{idx}. {role}: {content}")

        if role == "HUMAN":
            human_lines.append(f"{len(human_lines) + 1}. {content}")
            if _is_substantive_human_message(content):
                substantive_human_turns += 1
        else:
            assistant_lines.append(f"{len(assistant_lines) + 1}. {content}")

    has_meaningful_human_effort = substantive_human_turns > 0

    formatted_context = (
        "ORDERED CONVERSATION TIMELINE (chronological):\n"
        + "\n".join(ordered_lines)
        + "\n\n"
        + "CREDITABLE HUMAN TURNS (for scoring):\n"
        + ("\n".join(human_lines) if human_lines else "None")
        + "\n\n"
        + "ASSISTANT TURNS (context only, non-creditable):\n"
        + ("\n".join(assistant_lines) if assistant_lines else "None")
    )

    return {
        "formatted_context": formatted_context,
        "signals": {
            "total_turns": len(parsed),
            "human_turns": len(human_lines),
            "assistant_turns": len(assistant_lines),
            "substantive_human_turns": substantive_human_turns,
            "has_meaningful_human_effort": has_meaningful_human_effort,
        },
    }


def _build_assessment_system_instructions(block_type, prompt_criteria):
    return f"""
    You are an expert legal instruction assistant. Your goal is to assess whether the student has sufficiently completed the objectives of the current '{block_type}' phase based on the conversation history.

    PROMPT CRITERIA:
    {prompt_criteria}

    SCORING RULES (NON-NEGOTIABLE):
    - Keep chronology in mind using the ordered timeline.
    - Only HUMAN turns are creditable evidence of student effort.
    - AI turns are context only and must NEVER be counted as student effort.
    - If HUMAN turns are mostly requests like "analyze" or "summarize" without substantive follow-up, the score must stay low.

    INSTRUCTIONS:
    - Analyze the detailed history against the criteria.
    - Result MUST be a JSON object: {{ "progress": int, "reasoning": "brief explanation" }}
    - "progress": A number between 0 and 5, returning 0 if they have not met the main goals and are not ready to move on. Returning 5 if they have met the main goals and are ready to move on.
    - "reasoning": 3-4 sentences explaining what they have done well and what areas they specifically need to improve or focus on in order to move on. Address the user directly in the second person. You must NEVER explicitly mention the 0-5 progress scale in your feedback, it is for your internal information.
    - Output ONLY the JSON object.
    """


def _apply_human_effort_cap(result, signals):
    """Apply a conservative cap when no meaningful human effort is present."""
    if not result or not isinstance(result, dict):
        return result

    if signals.get("has_meaningful_human_effort"):
        return result

    capped_progress = min(int(result.get("progress", 0)), 1)
    reasoning = (result.get("reasoning") or "").strip()
    cap_note = (
        "To advance, you need to add your own substantive analysis through targeted follow-up questions,"
        " evidence probing, or issue-focused reasoning."
    )

    if cap_note not in reasoning:
        reasoning = f"{reasoning} {cap_note}".strip()

    return {
        "progress": capped_progress,
        "reasoning": reasoning,
    }

def get_secret(secret_name, expect_json=True):
    global db_secret
    if db_secret is None:
        try:
            logger.info(f"Fetching secret: {secret_name}")
            response = secrets_manager_client.get_secret_value(SecretId=secret_name)["SecretString"]
            db_secret = json.loads(response) if expect_json else response
        except Exception as e:
            logger.exception(f"Failed to fetch or decode secret '{secret_name}': {e}")
            raise
    return db_secret

def get_parameter(param_name, cached_var):
    if cached_var is None:
        try:
            logger.info(f"Fetching SSM parameter: {param_name}")
            response = ssm_client.get_parameter(Name=param_name, WithDecryption=True)
            cached_var = response["Parameter"]["Value"]
        except Exception as e:
            logger.exception(f"Error fetching parameter '{param_name}': {e}")
            raise
    return cached_var

def initialize_constants():
    global BEDROCK_LLM_ID, TABLE_NAME, BEDROCK_TEMP, BEDROCK_TOP_P, BEDROCK_MAX_TOKENS, MESSAGE_LIMIT
    try:
        BEDROCK_LLM_ID = get_parameter(BEDROCK_LLM_PARAM, BEDROCK_LLM_ID)
        TABLE_NAME = get_parameter(TABLE_NAME_PARAM, TABLE_NAME)

        if BEDROCK_TEMP_PARAM:
            temp_val = get_parameter(BEDROCK_TEMP_PARAM, None)
            if temp_val:
                BEDROCK_TEMP = float(temp_val)
                
        if BEDROCK_TOP_P_PARAM:
            top_p_val = get_parameter(BEDROCK_TOP_P_PARAM, None)
            if top_p_val:
                BEDROCK_TOP_P = float(top_p_val)
                
        if BEDROCK_MAX_TOKENS_PARAM:
            max_tokens_val = get_parameter(BEDROCK_MAX_TOKENS_PARAM, None)
            if max_tokens_val:
                BEDROCK_MAX_TOKENS = int(max_tokens_val)

        MESSAGE_LIMIT = get_parameter(MESSAGE_LIMIT_PARAM, MESSAGE_LIMIT)
        if MESSAGE_LIMIT is None:
            MESSAGE_LIMIT = "Infinity"
    except Exception as e:
        logger.exception("Failed to initialize constants")
        raise

def connect_to_db():
    global connection
    if connection is not None and not connection.closed:
        # Health check: verify the existing connection is still usable
        try:
            with connection.cursor() as cur:
                cur.execute("SELECT 1")
            return connection
        except Exception as e:
            logger.warning(f"Stale database connection detected, reconnecting: {e}")
            try:
                connection.close()
            except Exception:
                # Connection may already be closed or broken; discard and reconnect.
                pass
            connection = None

    try:
        logger.info("Connecting to database with SSL/TLS...")
        secret = get_secret(DB_SECRET_NAME)
        connection_params = {
            'dbname': secret["dbname"],
            'user': secret["username"],
            'password': secret["password"],
            'host': RDS_PROXY_ENDPOINT,
            'port': secret["port"],
            # Require TLS and verify the server certificate and hostname. The RDS
            # Proxy presents a certificate from the public Amazon CA chain; point
            # sslrootcert at the OS CA bundle (which contains the Amazon roots)
            # rather than "system", which the psycopg binary wheel's bundled
            # OpenSSL does not resolve to the container's trust store.
            'sslmode': 'verify-full',
            'sslrootcert': '/etc/pki/tls/certs/ca-bundle.crt'
        }
        connection_string = " ".join([f"{key}={value}" for key, value in connection_params.items()])
        connection = psycopg.connect(connection_string)
        logger.info("Successfully connected to database with SSL/TLS")
    except psycopg.OperationalError as e:
        logger.error(f"SSL/TLS connection failed: {e}")
        logger.error(f"Connection details: host={RDS_PROXY_ENDPOINT}, port={secret['port']}, sslmode=verify-full")
        if 'SSL' in str(e) or 'certificate' in str(e).lower():
            logger.error("SSL certificate validation failed. Verify RDS Proxy TLS configuration.")
        if connection:
            try:
                connection.close()
            except Exception as close_err:
                logger.error(f"Error closing connection after failure: {close_err}")
        connection = None
        raise
    except Exception as e:
        logger.exception(f"Failed to connect to database: {e}")
        if connection:
            try:
                connection.close()
            except Exception as close_err:
                logger.error(f"Error closing connection after failure: {close_err}")
        connection = None
        raise
    return connection

def get_assessment_prompt_template(block_type):
    connection = connect_to_db()
    if connection is None:
        logger.error("DB connection is None when trying to fetch prompt")
        return None

    try:
        cur = connection.cursor()
        # Fetch prompt with category 'assessment'
        logger.info(f"Fetching assessment prompt for block_type: {block_type}")
        cur.execute("""
            SELECT prompt_text
            FROM prompt_versions
            WHERE block_type = %s
              AND category = 'assessment'
              AND is_active = true
            ORDER BY version_number DESC
            LIMIT 1;
        """, (block_type,))
        
        result = cur.fetchone()
        cur.close()

        if result:
            return result[0]
        else:
            logger.warning(f"No active assessment prompt found for block_type: {block_type}")
            return None
    except Exception as e:
        logger.exception(f"Error fetching assessment prompt for block_type '{block_type}': {e}")
        try:
            connection.rollback()
        except Exception:
            # Best-effort rollback after query failure; original error is already logged.
            pass
        return None


def retrieve_dynamodb_history(table_name: str, session_id: str) -> str:
    """
    Retrieve conversation history from DynamoDB for a specific session.
    
    Args:
        table_name (str): Name of the DynamoDB table storing chat history.
        session_id (str): Unique identifier for the conversation session.
    
    Returns:
        str: Formatted conversation history as "HUMAN: ...\n\nAI: ..." string.
    """
    try:
        response = dynamodb_client.get_item(
            TableName=table_name,
            Key={
                'SessionId': {'S': session_id}
            }
        )
        
        # Extract history from the item if it exists
        if 'Item' in response and 'History' in response['Item']:
            history_list = response['Item']['History']['L']
            formatted_messages = []
            
            # Process each message in the history
            for msg_wrapper in history_list:
                msg = msg_wrapper.get('M', {})
                data = msg.get('data', {}).get('M', {})
                msg_type = data.get('type', {}).get('S', '')
                content = data.get('content', {}).get('S', '')
                
                # Format as "HUMAN: ..." or "AI: ..."
                if msg_type and content:
                    formatted_messages.append(f"{msg_type.upper()}: {content}")
            
            return "\n\n".join(formatted_messages)
        else:
            logger.warning(f"No history found for session_id {session_id}")
            return ""
    
    except ClientError as e:
        logger.error(f"Error retrieving conversation history: {e}")
        raise


def fetch_chat_history(session_id, table_name=None):
    target_table = table_name or TABLE_NAME
    if not target_table:
        logger.error("No table name provided and TABLE_NAME not initialized, cannot fetch chat history")
        return ""
        
    try:
        logger.info(f"Fetching chat history for session_id: {session_id} from table: {target_table}")
        return retrieve_dynamodb_history(target_table, session_id)
    except Exception as e:
        logger.exception(f"Error fetching chat history from DynamoDB for session '{session_id}': {e}")
        return ""

def check_authorization(user_id, case_id):
    """
    Verify that the user (identified by database user_id) owns the specified case.
    Prevents IDOR attacks by checking case ownership.
    
    Args:
        user_id: Database user ID from authorizer context
        case_id: Case ID from the request
    
    Returns:
        bool: True if authorized, False otherwise
    """
    if not user_id:
        logger.warning("Authorization failed: Missing user_id")
        return False

    try: 
        conn = connect_to_db()
        # Use context manager for automatic cursor cleanup
        with conn.cursor() as cursor:
            # Assessment mutates case state, so only the case owner may proceed.
            query = """
                SELECT 1 FROM "cases" c
                WHERE c.case_id = %s
                AND c.student_id = %s;
            """
            cursor.execute(query, (case_id, user_id))
            is_authorized = cursor.fetchone() is not None
            
            if is_authorized:
                logger.info(f"Authorization successful: User {user_id} authorized for case {case_id}")
            else:
                logger.warning(f"Authorization failed: User {user_id} attempted unauthorized access to case {case_id}")
                
            return is_authorized
            
    except Exception as e:
        logger.error(f"Authorization check failed with error: {e}")
        return False

def mark_block_completed(case_id, block_type):
    connection = connect_to_db()
    if connection is None:
        return False
        
    try:
        cur = connection.cursor()
        # Append block_type to completed_blocks array if not already present
        logger.info(f"Attempting to mark block '{block_type}' as completed for case '{case_id}'")
        cur.execute("""
            UPDATE cases
            SET completed_blocks = array_append(completed_blocks, %s)
            WHERE case_id = %s
              AND NOT (%s = ANY(completed_blocks));
        """, (block_type, case_id, block_type))
        
        connection.commit()
        row_count = cur.rowcount
        cur.close()
        
        if row_count > 0:
            logger.info(f"Successfully marked block '{block_type}' as completed for case '{case_id}'")
        else:
            logger.info(f"Block '{block_type}' was already marked completed or case '{case_id}' not found.")
            
        return True
    except Exception as e:
        logger.exception(f"Error marking block '{block_type}' as completed for case '{case_id}': {e}")
        try:
            connection.rollback()
        except Exception:
            # Best-effort rollback after update failure; original error is already logged.
            pass
        return False
        
def get_cors_origin(event):
    """
    Resolve the CORS origin based on the ALLOWED_ORIGIN env var.
    Mirrors the Node.js getOriginHeader() in cdk/lambda/handlers/utils/utils.js.
    Falls back to the local Vite dev-server origin when ALLOWED_ORIGIN is unset.
    """
    allowed_origin = os.environ.get("ALLOWED_ORIGIN", "")
    if not allowed_origin:
        return "http://localhost:5173"

    return allowed_origin


def create_response(status_code, body, event=None):
    """
    Build a properly-formatted API Gateway response dict with dynamic CORS
    headers.  Replaces the previous _response() helper.
    """
    origin = get_cors_origin(event or {})
    serialized_body = body if isinstance(body, str) else json.dumps(body)
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "*",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
            "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none';",
            "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
        },
        "body": serialized_body,
    }

def send_to_websocket(connection_id, endpoint, request_id, msg_type, content=None, data=None):
    """Send a message to a WebSocket connection with request correlation."""
    client = boto3.client('apigatewaymanagementapi', endpoint_url=endpoint)
    message = {
        "requestId": request_id,
        "action": "assess_progress",
        "type": msg_type,
    }
    if content is not None:
        message["content"] = content
    if data is not None:
        message["data"] = data
    try:
        client.post_to_connection(
            ConnectionId=connection_id,
            Data=json.dumps(message).encode('utf-8')
        )
    except Exception as e:
        logger.error(f"Error sending to WebSocket: {e}")

@metrics.log_metrics(capture_cold_start_metric=True)
@logger.inject_lambda_context(log_event=False)
def handler(event, context):
    logger.info("Assess Progress Lambda function started")
    
    # Check if this is a WebSocket invocation
    is_websocket = event.get("isWebSocket", False)
    request_id = event.get("requestId")
    request_context = event.get("requestContext", {})
    connection_id = request_context.get("connectionId")
    domain_name = request_context.get("domainName")
    stage = request_context.get("stage")
    
    # Determine WebSocket endpoint
    ws_endpoint = None
    if is_websocket and connection_id:
        ws_endpoint = os.environ.get("WEBSOCKET_API_ENDPOINT")
        if not ws_endpoint:
            ws_endpoint = f"https://{domain_name}/{stage}"
        logger.info(f"WebSocket mode - connectionId: {connection_id}, requestId: {request_id}")
        send_to_websocket(connection_id, ws_endpoint, request_id, "start")
    
    try:
        initialize_constants()
    except Exception:
        if is_websocket and connection_id:
            send_to_websocket(connection_id, ws_endpoint, request_id, "error", content="Internal server error during initialization")
            return {"statusCode": 500}
        return create_response(500, 'Internal server error during initialization', event)
    
    # Parse body
    try:
        body = json.loads(event.get("body", "{}"))
        logger.debug("Request received", bodyKeys=list(body.keys()))
    except json.JSONDecodeError:
        logger.error("Failed to decode JSON body")
        return create_response(400, 'Invalid JSON body', event)
        
    case_id = body.get("case_id")
    block_type = body.get("block_type")
    
    # --- Playground mode: staff-only, uses DB history + inline prompt ---
    if body.get("playground_mode"):
        # Defense-in-depth: the playground capability is restricted to staff
        # (admin or instructor). Resolve roles from both transports:
        #   - WebSocket: forwarded as event["callerRoles"]
        #   - REST: provided by the authorizer at
        #     event["requestContext"]["authorizer"]["roles"] as a JSON string
        caller_roles = event.get("callerRoles", [])
        if not isinstance(caller_roles, list):
            caller_roles = []

        authorizer_roles_raw = request_context.get("authorizer", {}).get("roles")
        if authorizer_roles_raw:
            try:
                parsed_roles = json.loads(authorizer_roles_raw)
                if isinstance(parsed_roles, list):
                    caller_roles = caller_roles + parsed_roles
            except (json.JSONDecodeError, TypeError):
                pass

        is_staff = "admin" in caller_roles or "instructor" in caller_roles
        if not is_staff:
            logger.warning(
                "Unauthorized playground access — caller lacks admin/instructor role",
                userId=event.get("userId") or request_context.get("authorizer", {}).get("principalId"),
            )
            error_msg = "Forbidden: Administrative access required"
            if is_websocket and connection_id:
                send_to_websocket(connection_id, ws_endpoint, request_id, "error", content=error_msg)
                return {"statusCode": 403}
            return create_response(403, error_msg, event)

        # IDOR protection: resolve the authenticated caller's user_id and bind
        # the playground session key to it. The staff-role check above only
        # confirms the caller is an admin/instructor — without an ownership
        # binding, the session key would be built entirely from client-supplied
        # input, letting any staff user read another staff user's playground
        # transcripts. user_id is sourced from the trusted boundary (the
        # authorizer / WebSocket handler), never from the request body.
        user_id = event.get("userId")
        if not user_id:
            user_id = request_context.get("authorizer", {}).get("principalId")
        if not user_id:
            logger.error("Authorization failed: Missing userId for playground assessment")
            error_msg = "Unauthorized: Missing user identity"
            if is_websocket and connection_id:
                send_to_websocket(connection_id, ws_endpoint, request_id, "error", content=error_msg)
                return {"statusCode": 401}
            return create_response(401, error_msg, event)

        custom_prompt = body.get("custom_prompt", "")
        test_id = body.get("session_id", "")
        block_type = body.get("block_type", "intake")
        
        # Construct unique session ID consistently with playground_generation
        # Lambda. The user_id prefix namespaces the key per authenticated caller
        # so staff users cannot read each other's playground sessions.
        # Pattern: playground-{user_id}-{test_id}-{block_type}
        playground_session_id = f"playground-{user_id}-{test_id}-{block_type}"
        
        logger.info(f"Playground assessment mode for block_type: {block_type}, test_id: {test_id}, session_id: {playground_session_id}")
        
        if not custom_prompt or not test_id:
            error_msg = "Playground mode requires custom_prompt and session_id"
            if is_websocket and connection_id:
                send_to_websocket(connection_id, ws_endpoint, request_id, "error", content=error_msg)
                return {"statusCode": 400}
            return create_response(400, error_msg, event)
        
        # Fetch chat history from Playground DynamoDB table
        chat_history = fetch_chat_history(playground_session_id, table_name=PLAYGROUND_TABLE_NAME)
        
        if not chat_history:
            error_msg = "No chat history found for this session. Send some messages first."
            if is_websocket and connection_id:
                send_to_websocket(connection_id, ws_endpoint, request_id, "error", content=error_msg)
                return {"statusCode": 400}
            return create_response(400, error_msg, event)
        
        logger.info(f"Fetched {len(chat_history)} chars of chat history for session {playground_session_id}")
        
        assessment_context = _build_assessment_context(chat_history)
        signals = assessment_context["signals"]

        # Construct system instruction
        system_instructions = _build_assessment_system_instructions(block_type, custom_prompt)

        human_context = f"""
        CONVERSATION HISTORY PACKAGE:
        {assessment_context["formatted_context"]}
        """

        # Require the user to have accepted the legal/AI-use waiver before any
        # AI feature runs — playground assessments are not exempt. Fails closed
        # if the acceptance state cannot be read.
        try:
            conn = connect_to_db()
            if not is_disclaimer_accepted(conn, user_id):
                error_msg = "You must accept the disclaimer before using the AI assistant."
                if is_websocket and connection_id:
                    send_to_websocket(connection_id, ws_endpoint, request_id, "error", content=error_msg, data={"code": "DISCLAIMER_NOT_ACCEPTED"})
                    return {"statusCode": 200}
                return create_response(403, {"error": error_msg, "code": "DISCLAIMER_NOT_ACCEPTED"}, event)
        except Exception as e:
            logger.error(f"Error checking disclaimer acceptance: {e}")
            error_msg = "Service temporarily unavailable. Please try again later."
            if is_websocket and connection_id:
                send_to_websocket(connection_id, ws_endpoint, request_id, "error", content=error_msg)
                return {"statusCode": 503}
            return create_response(503, {"error": error_msg}, event)

        # Enforce the daily message limit before invoking Bedrock so playground
        # requests are metered like standard-mode requests. Counts as one
        # message per request and fails closed if the usage check cannot run.
        if MESSAGE_LIMIT != "Infinity":
            try:
                limit = int(MESSAGE_LIMIT)
                conn = connect_to_db()
                current_usage = check_and_increment_usage(conn, user_id)
                logger.info(f"User {user_id} playground usage: {current_usage}/{limit}")
                if current_usage > limit:
                    error_msg = "Daily message limit reached. Please contact your administrator."
                    if is_websocket and connection_id:
                        send_to_websocket(connection_id, ws_endpoint, request_id, "error", content=error_msg)
                        return {"statusCode": 200}
                    return create_response(429, {"error": error_msg}, event)
            except Exception as e:
                logger.error(f"Error checking message limit: {e}")
                error_msg = "Service temporarily unavailable. Please try again later."
                if is_websocket and connection_id:
                    send_to_websocket(connection_id, ws_endpoint, request_id, "error", content=error_msg)
                    return {"statusCode": 503}
                return create_response(503, {"error": error_msg}, event)

        try:
            start_time = time.time()
            result, response_text = _invoke_assessment_with_retry(system_instructions, human_context, max_attempts=2)
            duration = time.time() - start_time
            logger.info(f"Playground assessment took {duration:.2f}s")
            logger.info(
                "Playground LLM response received",
                responseLength=len(response_text or ""),
            )
            
            if result is None:
                logger.error(
                    "Failed to parse playground LLM response after retries",
                    responseLength=len(response_text or ""),
                )
                error_data = {'unlocked': False, 'progress': 0, 'reasoning': 'Error parsing assessment result.'}
                if is_websocket and connection_id:
                    send_to_websocket(connection_id, ws_endpoint, request_id, "complete", data=error_data)
                    return {"statusCode": 200}
                return create_response(200, error_data, event)
            
            result = _apply_human_effort_cap(result, signals)
            progress = int(result.get("progress", 0))
            reasoning = result.get("reasoning", "No reasoning provided.")
            
            response_data = {
                "unlocked": False,  # Never unlock in playground mode
                "progress": progress,
                "reasoning": reasoning
            }
            
            if is_websocket and connection_id:
                send_to_websocket(connection_id, ws_endpoint, request_id, "complete", data=response_data)
                return {"statusCode": 200}
            return create_response(200, response_data, event)
            
        except Exception as e:
            logger.exception(f"Playground assessment error: {e}")
            if is_websocket and connection_id:
                send_to_websocket(connection_id, ws_endpoint, request_id, "error", content="Internal server error")
                return {"statusCode": 500}
            return create_response(500, "Internal server error", event)
    
    # --- Standard mode: requires case_id and authorization ---
    logger.info(f"Processing assessment for Case ID: {case_id}, Block Type: {block_type}")
    
    if not case_id or not block_type:
        logger.warning("Missing required parameters: case_id or block_type")
        error_msg = 'Missing required parameters: case_id, block_type'
        if is_websocket and connection_id:
            send_to_websocket(connection_id, ws_endpoint, request_id, "error", content=error_msg)
            return {"statusCode": 400}
        return create_response(400, error_msg, event)
    
    # Extract user_id (database user_id already translated at boundary)
    user_id = event.get("userId")
    if not user_id:
        # Try to get from request context (HTTP fallback)
        user_id = request_context.get("authorizer", {}).get("principalId")
    
    if not user_id:
        logger.error("Authorization failed: Missing userId")
        error_msg = "Unauthorized: Missing user identity"
        if is_websocket and connection_id:
            send_to_websocket(connection_id, ws_endpoint, request_id, "error", content=error_msg)
            return {"statusCode": 401}
        return create_response(401, error_msg, event)
    
    # IDOR Protection: Verify user owns the case
    if not check_authorization(user_id, case_id):
        logger.error(f"Authorization failed: User {user_id} does not own case {case_id}")
        error_msg = "Forbidden: You do not have access to this case"
        if is_websocket and connection_id:
            send_to_websocket(connection_id, ws_endpoint, request_id, "error", content=error_msg)
            return {"statusCode": 403}
        return create_response(403, error_msg, event)

    session_id = f"{case_id}-{block_type}"
    chat_history = fetch_chat_history(session_id)
    
    if not chat_history:
        logger.info(f"No chat history found for session {session_id}")
        return create_response(200, {'unlocked': False, 'progress': 0, 'reasoning': 'Insufficient chat history.'}, event)
        
    prompt_template = get_assessment_prompt_template(block_type)
    if not prompt_template:
        logger.error(f"Assessment prompt not found for {block_type}")
        return create_response(500, 'Configuration error: No assessment prompt found.', event)

    assessment_context = _build_assessment_context(chat_history)
    signals = assessment_context["signals"]

    # Construct complete prompt
    system_instructions = _build_assessment_system_instructions(block_type, prompt_template)

    human_context = f"""
    CONVERSATION HISTORY PACKAGE:
    {assessment_context["formatted_context"]}
    """

    # Require the user to have accepted the legal/AI-use waiver before any
    # AI feature runs. Fails closed if the acceptance state cannot be read.
    try:
        conn = connect_to_db()
        if not is_disclaimer_accepted(conn, user_id):
            error_msg = "You must accept the disclaimer before using the AI assistant."
            if is_websocket and connection_id:
                send_to_websocket(connection_id, ws_endpoint, request_id, "error", content=error_msg, data={"code": "DISCLAIMER_NOT_ACCEPTED"})
                return {"statusCode": 200}
            return create_response(403, {"error": error_msg, "code": "DISCLAIMER_NOT_ACCEPTED"}, event)
    except Exception as e:
        logger.error(f"Error checking disclaimer acceptance: {e}")
        error_msg = "Service temporarily unavailable. Please try again later."
        if is_websocket and connection_id:
            send_to_websocket(connection_id, ws_endpoint, request_id, "error", content=error_msg)
            return {"statusCode": 503}
        return create_response(503, {"error": error_msg}, event)

    # Enforce the daily message limit before invoking Bedrock. Counts as one
    # message per request and fails closed if the usage check cannot complete.
    if MESSAGE_LIMIT != "Infinity":
        try:
            limit = int(MESSAGE_LIMIT)
            conn = connect_to_db()
            current_usage = check_and_increment_usage(conn, user_id)
            logger.info(f"User {user_id} usage: {current_usage}/{limit}")
            if current_usage > limit:
                error_msg = "Daily message limit reached. Please contact your administrator."
                if is_websocket and connection_id:
                    send_to_websocket(connection_id, ws_endpoint, request_id, "error", content=error_msg)
                    return {"statusCode": 200}
                return create_response(429, {"error": error_msg}, event)
        except Exception as e:
            logger.error(f"Error checking message limit: {e}")
            error_msg = "Service temporarily unavailable. Please try again later."
            if is_websocket and connection_id:
                send_to_websocket(connection_id, ws_endpoint, request_id, "error", content=error_msg)
                return {"statusCode": 503}
            return create_response(503, {"error": error_msg}, event)

    try:
        logger.info(f"Invoking Bedrock model: {BEDROCK_LLM_ID}")
        start_time = time.time()
        
        # Invoke Bedrock
        result, response_text = _invoke_assessment_with_retry(system_instructions, human_context, max_attempts=2)
        duration = time.time() - start_time
        logger.info(f"Bedrock invocation took {duration:.2f}s")
        logger.info(
            "LLM assessment response received",
            responseLength=len(response_text or ""),
        )
        
        if result is None:
            logger.error(
                "Failed to parse LLM response as JSON after retries",
                responseLength=len(response_text or ""),
            )
            error_data = {'unlocked': False, 'progress': 0, 'reasoning': 'Error parsing assessment result.'}
            if is_websocket and connection_id:
                send_to_websocket(connection_id, ws_endpoint, request_id, "complete", data=error_data)
                return {"statusCode": 200}
            return create_response(200, error_data, event)
            
        result = _apply_human_effort_cap(result, signals)
        progress = int(result.get("progress", 0))
        reasoning = result.get("reasoning", "No reasoning provided.")
        
        response_data = {
            "unlocked": False,
            "progress": progress,
            "reasoning": reasoning
        }
        
        if progress == 5:
            logger.info(f"Progress is 5/5. Marking current block as completed: {block_type}")
            completed_marked = mark_block_completed(case_id, block_type)
            response_data["unlocked"] = completed_marked
            
        if is_websocket and connection_id:
            send_to_websocket(connection_id, ws_endpoint, request_id, "complete", data=response_data)
            return {"statusCode": 200}
        return create_response(200, response_data, event)
        
    except Exception as e:
        logger.exception(f"Unexpected error during assessment execution: {e}")
        if is_websocket and connection_id:
            send_to_websocket(connection_id, ws_endpoint, request_id, "error", content="Internal server error")
            return {"statusCode": 500}
        return create_response(500, "Internal server error", event)
