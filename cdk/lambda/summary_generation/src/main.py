import os
import json
import boto3
import psycopg
from botocore.config import Config

# Create Bedrock client inline (bedrock_client layer not available for this function)
_BEDROCK_RETRY_CONFIG = Config(
    retries={"mode": "adaptive", "max_attempts": 5},
    read_timeout=120,
    connect_timeout=10,
)

def _get_bedrock_runtime_client(region_name=None):
    kwargs = {"config": _BEDROCK_RETRY_CONFIG}
    if region_name:
        kwargs["region_name"] = region_name
    return boto3.client("bedrock-runtime", **kwargs)

from helpers.chat import (
    get_bedrock_llm,
    generate_lawyer_summary,
    retrieve_dynamodb_history,
    generate_full_case_summary,
)
from helpers.usage import check_and_increment_usage, is_disclaimer_accepted
from aws_lambda_powertools import Logger, Metrics

# Set up logging and metrics for the Lambda function
logger = Logger(service="SummaryGeneration")
metrics = Metrics(namespace="LAIGO", service="SummaryGeneration")

# Environment variables
DB_SECRET_NAME = os.environ["SM_DB_CREDENTIALS"]
REGION = os.environ["REGION"]
RDS_PROXY_ENDPOINT = os.environ["RDS_PROXY_ENDPOINT"]
BEDROCK_LLM_PARAM = os.environ["BEDROCK_LLM_PARAM"]
TABLE_NAME_PARAM = os.environ["TABLE_NAME_PARAM"]
TABLE_NAME = os.environ["TABLE_NAME"]
BEDROCK_TEMP_PARAM = os.environ.get("BEDROCK_TEMP_PARAM")
BEDROCK_TOP_P_PARAM = os.environ.get("BEDROCK_TOP_P_PARAM")
BEDROCK_MAX_TOKENS_PARAM = os.environ.get("BEDROCK_MAX_TOKENS_PARAM")
MESSAGE_LIMIT_PARAM = os.environ["MESSAGE_LIMIT_PARAM"]
# AWS Clients
secrets_manager_client = boto3.client("secretsmanager")
ssm_client = boto3.client("ssm", region_name=REGION)
bedrock_runtime = _get_bedrock_runtime_client(region_name=REGION)
eventbridge_client = boto3.client("events", region_name=REGION)

# Cached resources
connection = None
db_secret = None
BEDROCK_LLM_ID = None
BEDROCK_TEMP = 0.5
BEDROCK_TOP_P = 0.9
BEDROCK_MAX_TOKENS = 2048
MESSAGE_LIMIT = None

FULL_CASE_BLOCK_TYPES = ["intake", "legal_analysis", "contrarian", "policy"]

DISCLAIMER = "\n\n---\n**DISCLAIMER:**\nTHIS SUMMARY MUST NOT BE PROVIDED TO THE CLIENT WITHOUT THE REVIEW AND SIGNATURE OF THE SUPERVISING LAWYER.\nTHE SUMMARY IS BASED SOLELY ON THE FACTS INPUTTED BY THE USER, AS GATHERED FROM THE CLIENT AT THE TIME IT WAS PREPARED. SHOULD ADDITIONAL FACTS COME TO LIGHT, OR SHOULD THE FACTS AS PRESENTED CHANGE, THE APPLICABLE LAW AND ANALYSIS MAY ALSO CHANGE. IN SUCH CIRCUMSTANCES, THIS SUMMARY MUST BE REVISED TO REFLECT THE UPDATED OR ADDITIONAL INFORMATION.\nTHE LAW IS ALSO CONSTANTLY EVOLVING. ALL SUMMARIES MORE THAN SIX (6) MONTHS OLD MUST BE UPDATED.\nTHIS SUMMARY IS SUBJECT TO CLIENT-SOLICITOR PRIVILEGE."


def get_cors_origin(event):
    allowed_origin = os.environ.get("ALLOWED_ORIGIN", "")
    if not allowed_origin:
        return "*"
    return allowed_origin


def create_response(status_code, body, event=None):
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


def get_secret(secret_name, expect_json=True):
    global db_secret
    if db_secret is None:
        try:
            response = secrets_manager_client.get_secret_value(SecretId=secret_name)["SecretString"]
            db_secret = json.loads(response) if expect_json else response
        except json.JSONDecodeError as e:
            logger.error(f"Failed to decode JSON for DB secret: {e}")
            raise ValueError(f"DB Secret is not properly formatted as JSON.")
        except Exception as e:
            logger.error(f"Error fetching DB secret: {e}")
            raise
    return db_secret


def get_parameter(param_name, cached_var):
    """
    Fetch a parameter value from Systems Manager Parameter Store.
    """
    if cached_var is None:
        try:
            response = ssm_client.get_parameter(Name=param_name, WithDecryption=True)
            cached_var = response["Parameter"]["Value"]
        except Exception as e:
            logger.error(f"Error fetching parameter {param_name}: {e}")
            raise
    return cached_var

def initialize_constants():
    global BEDROCK_LLM_ID, BEDROCK_TEMP, BEDROCK_TOP_P, BEDROCK_MAX_TOKENS, MESSAGE_LIMIT
    BEDROCK_LLM_ID = get_parameter(BEDROCK_LLM_PARAM, BEDROCK_LLM_ID)

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
        secret = get_secret(DB_SECRET_NAME)
        connection_params = {
            'dbname': secret["dbname"],
            'user': secret["username"],
            'password': secret["password"],
            'host': RDS_PROXY_ENDPOINT,
            'port': secret["port"],
            # Require TLS and verify the server certificate and hostname against
            # the system trust store (the RDS Proxy presents an ACM-issued
            # certificate from a public Amazon CA).
            'sslmode': 'verify-full',
            'sslrootcert': 'system'
        }
        connection_string = " ".join([f"{key}={value}" for key, value in connection_params.items()])
        connection = psycopg.connect(connection_string)
        logger.info("Connected to the database!")
    except Exception as e:
        logger.error(f"Failed to connect to database: {e}")
        if connection:
            try:
                connection.close()
            except Exception:
                # Connection may already be closed or broken; discard and reconnect.
                pass
            connection = None
        raise
    return connection


def check_authorization(user_id, case_id):
    """
    Verify that the user (identified by user_id) owns the specified case 
    or is an instructor for the case owner.
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
            # Single query to check both ownership and instructor relationship
            query = """
                SELECT 1 FROM "cases" c
                WHERE c.case_id = %s
                AND (
                    c.student_id = %s
                    OR EXISTS (
                        SELECT 1 FROM instructor_students 
                        WHERE instructor_id = %s AND student_id = c.student_id
                    )
                );
            """
            cursor.execute(query, (case_id, user_id, user_id))
            is_authorized = cursor.fetchone() is not None
            
            if is_authorized:
                logger.info(f"Authorization successful: User {user_id} authorized for case {case_id}")
            else:
                logger.warning(f"Authorization failed: User {user_id} attempted unauthorized access to case {case_id}")
                
            return is_authorized
            
    except Exception as e:
        logger.error(f"Authorization check failed: {e}")
        return False





def send_to_websocket(connection_id, endpoint, request_id, msg_type, content=None, data=None):
    """Send a message to a WebSocket connection with request correlation."""
    client = boto3.client('apigatewaymanagementapi', endpoint_url=endpoint)
    message = {
        "requestId": request_id,
        "action": "generate_summary",
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


def _error_response(status_code, message, is_websocket=False, connection_id=None, ws_endpoint=None, request_id=None, event=None, code=None):
    """Helper for generating error responses for both HTTP and WebSocket modes."""
    if is_websocket and connection_id:
        ws_data = {"code": code} if code else None
        send_to_websocket(connection_id, ws_endpoint, request_id, "error", content=message, data=ws_data)
        return {"statusCode": status_code}
    body = {"error": message}
    if code:
        body["code"] = code
    return create_response(status_code, body, event)


def _require_non_empty_summary(body: str) -> str:
    """Reject empty model output before persisting a summary record."""
    text = (body or "").strip()
    if not text:
        raise ValueError("Summary generation returned empty content from the model")
    return text


def _finalize_summary_response(
    body: str,
    is_websocket: bool,
    connection_id,
    ws_endpoint,
    request_id,
) -> str:
    """
    Validate model output, append disclaimer, and optionally push chunks to WebSocket.

    Uses non-streaming Bedrock output for reliability; WebSocket clients still receive
    start/chunk/complete events without depending on invoke_model_with_response_stream.
    """
    summary_body = _require_non_empty_summary(body)
    if is_websocket and connection_id:
        send_to_websocket(connection_id, ws_endpoint, request_id, "chunk", content=summary_body)
        send_to_websocket(connection_id, ws_endpoint, request_id, "chunk", content=DISCLAIMER)
    return summary_body + DISCLAIMER


def get_case_details(case_id):
    connection = connect_to_db()
    if connection is None:
        logger.error("No database connection available.")
        return {
            "statusCode": 500,
            "body": json.dumps("Database connection failed.")
        }
    
    try:
        cur = connection.cursor()
        logger.info("Connected to RDS instance!")
        cur.execute("""
            SELECT case_title, case_type, jurisdiction, case_description
            FROM "cases"
            WHERE case_id = %s;
        """, (case_id,))

        result = cur.fetchone()
        logger.info(f"Query result: {result}")

        cur.close()

        if result:
            case_title, case_type, jurisdiction, case_description = result
            
            # Handle jurisdiction list
            if isinstance(jurisdiction, list):
                jurisdiction = ", ".join(jurisdiction)

            logger.info(f"client details found for case_id {case_id}: "
                        f"Title: {case_title} \n Case type: {case_type} \n Jurisdiction: {jurisdiction} \n Case description: {case_description}")
            return case_title, case_type, jurisdiction, case_description
        else:
            logger.warning(f"No details found for case_id {case_id}")
            return None, None, None, None

    except Exception as e:
        logger.error(f"Error fetching case details: {e}")
        if cur:
            cur.close()
        connection.rollback()
        return None, None, None, None

def get_completed_blocks(case_id):
    """
    Retrieve list of completed blocks for a case.
    """
    connection = connect_to_db()
    if connection is None:
        return []

    try:
        cur = connection.cursor()
        cur.execute("""
            SELECT completed_blocks FROM cases WHERE case_id = %s;
        """, (case_id,))
        result = cur.fetchone()
        cur.close()
        
        if result and result[0]:
            return result[0]
        return []
    except Exception as e:
        logger.error(f"Error fetching completed blocks: {e}")
        if cur:
            cur.close()
        connection.rollback()
        return []

def get_summary_prompt_template(prompt_scope, block_type=None):
    """
    Retrieve the active summary prompt from prompt_versions.

    For block summaries:       prompt_scope='block',     block_type=<block name>
    For full-case synthesis:   prompt_scope='full_case',  block_type=None
    """
    connection = connect_to_db()
    if connection is None:
        logger.error("DB connection is None when trying to fetch summary prompt")
        return None

    try:
        cur = connection.cursor()
        if prompt_scope == "full_case":
            logger.info("Fetching full-case summary prompt")
            cur.execute(
                """
                SELECT prompt_text
                FROM prompt_versions
                WHERE prompt_scope = 'full_case'
                  AND category = 'summary'
                  AND is_active = true
                ORDER BY version_number DESC
                LIMIT 1;
            """
            )
        else:
            logger.info(f"Fetching summary prompt for block_type: {block_type}")
            cur.execute(
                """
                SELECT prompt_text
                FROM prompt_versions
                WHERE prompt_scope = 'block'
                  AND block_type = %s
                  AND category = 'summary'
                  AND is_active = true
                ORDER BY version_number DESC
                LIMIT 1;
            """,
                (block_type,),
            )

        result = cur.fetchone()
        cur.close()

        if result:
            return result[0]

        label = "full_case" if prompt_scope == "full_case" else block_type
        logger.warning(f"No active summary prompt found for scope: {label}")
        return None
    except Exception as e:
        label = "full_case" if prompt_scope == "full_case" else block_type
        logger.exception(f"Error fetching summary prompt for scope '{label}': {e}")
        try:
            connection.rollback()
        except Exception:
            # Best-effort rollback after query failure; original error is already logged.
            pass
        return None

def get_latest_block_summaries(case_id, block_types):
    """
    Retrieve the most recent summary for each requested block type.
    """
    connection = connect_to_db()
    if connection is None or not block_types:
        return []
    
    summaries = []
    try:
        cur = connection.cursor()
        # Fetch latest summary for each requested block type
        # We process them one by one or via IN clause. 
        # Using specific query to get latest per block type.
        
        query = """
            SELECT DISTINCT ON (block_context) 
                block_context, content, title
            FROM summaries
            WHERE case_id = %s 
                AND scope = 'block'
                AND block_context = ANY(%s)
            ORDER BY block_context, time_created DESC;
        """
        
        cur.execute(query, (case_id, block_types))
        rows = cur.fetchall()
        cur.close()
        
        for row in rows:
            summaries.append({
                "block_type": row[0],
                "content": row[1],
                "title": row[2]
            })
            
        return sorted(summaries, key=lambda x: block_types.index(x['block_type']) if x['block_type'] in block_types else 999)

    except Exception as e:
        logger.error(f"Error fetching block summaries: {e}")
        if cur:
            cur.close()
        connection.rollback()
        return []

def update_summaries(case_id, summary, block_type, scope='block'):
    """
    Adds a new summary for a given case.
    
    Args:
        case_id (str): The ID of the case to update.
        summary (str): The new summary for the case.
        block_type (str): The block type (intake, issues, etc.). None if full-case.
        scope (str): 'block' or 'full_case'
    
    Returns:
        bool: True if successful, False otherwise.
    """
    logger.info(f"Adding new summary for case_id {case_id}, scope {scope}, block {block_type}")
    connection = connect_to_db()
    if connection is None:
        logger.error("No database connection available.")
        return False
    
    # Map block_type to human-readable titles
    block_titles = {
        "intake": "Intake Facts Summary",
        "legal_analysis": "Legal Analysis Summary",
        "contrarian": "Contrarian Analysis Summary",
        "policy": "Policy Context Summary"
    }
    
    if scope == 'full_case':
        title = "Full Case Summary"
        block_context = None
    else:
        title = block_titles.get(block_type, "Block Summary")
        block_context = block_type
    
    try:
        cur = connection.cursor()
        logger.info("Connected to RDS instance!")
        
        # Insert a new summary
        cur.execute("""
            INSERT INTO summaries (case_id, content, scope, block_context, title, time_created)
            VALUES (%s, %s, %s, %s, %s, CURRENT_TIMESTAMP)
        """, (case_id, summary, scope, block_context, title))
            
        connection.commit()
        cur.close()
        logger.info(f"Successfully added new summary for case_id {case_id}")
        return True

    except Exception as e:
        logger.error(f"Error adding summary: {e}")
        if cur:
            cur.close()
        connection.rollback()
        return False

def publish_notification_event(event_type, case_id, user_id, success=True, error_message=None):
    """
    Publish notification event to EventBridge for summary generation completion
    """
    try:
        event_bus_name = os.environ.get("NOTIFICATION_EVENT_BUS_NAME")
        if not event_bus_name:
            logger.warning("NOTIFICATION_EVENT_BUS_NAME not configured, skipping notification")
            return

        # Get case details for notification context
        case_title, case_type, jurisdiction, case_description = get_case_details(case_id)
        
        # Map event_type (sub_route) to readable block name
        block_titles = {
            "intake-facts": "Intake Facts",
            "legal-analysis": "Legal Analysis",
            "contrarian-analysis": "Contrarian Analysis",
            "policy-context": "Policy Context",
            "full-case": "Full Case"
        }
        block_name = block_titles.get(event_type, "Summary")
        case_display_name = case_title or "Unknown Case"

        # Determine notification details based on success/failure
        if success:
            title = "Summary Generation Complete"
            message = f"Summary generated for {block_name} on {case_display_name}"
            notification_type = "summary_complete"
        else:
            title = "Summary Generation Failed"
            message = f"Summary generation failed for {block_name}: {error_message or 'Unknown error'}"
            notification_type = "summary_complete"

        event_detail = {
            "type": notification_type,
            "recipientId": user_id,
            "title": title,
            "message": message,
            "metadata": {
                "caseId": case_id,
                "caseName": case_display_name,
                "status": "success" if success else "failed",
                "eventType": event_type,
                "blockName": block_name,
                **({"errorMessage": error_message} if error_message else {})
            }
        }

        response = eventbridge_client.put_events(
            Entries=[
                {
                    "Source": "notification.system",
                    "DetailType": "Summary Generation Complete",
                    "Detail": json.dumps(event_detail),
                    "EventBusName": event_bus_name
                }
            ]
        )

        logger.info(f"Published notification event: {response}")
        
    except Exception as e:
        logger.error(f"Error publishing notification event: {e}")
        # Don't fail the main operation if notification fails

@metrics.log_metrics(capture_cold_start_metric=True)
@logger.inject_lambda_context(log_event=False)
def handler(event, context):
    """
    Lambda function handler for generating conversation summaries.
    
    Expected event structure (HTTP):
    {
        "queryStringParameters": {
            "case_id": "unique_case_id",
            "sub_route": "intake-facts" | "issue-identification" | "full-case" | etc.
        }
    }
    
    Expected event structure (WebSocket):
    {
        "isWebSocket": true,
        "userId": "database-user-id",
        "requestId": "unique-request-id",
        "queryStringParameters": { "case_id": "...", "sub_route": "..." },
        "requestContext": { "connectionId": "...", "domainName": "...", "stage": "..." }
    }
    """
    logger.info("Summary Generation Lambda function is called!")
    initialize_constants()

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

    query_params = event.get("queryStringParameters", {})
    case_id = query_params.get("case_id", "")
    sub_route = query_params.get("sub_route", "intake-facts") 

    if not case_id:
        return _error_response(400, "Missing required parameters: case_id", is_websocket, connection_id, ws_endpoint, request_id, event=event)

    # Get user_id from event (already translated at boundary)
    user_id = event.get("userId")
    if not user_id:
        # Try to get from request context (HTTP fallback)
        user_id = request_context.get("authorizer", {}).get("userId")
    if not user_id:
        # Backward compatibility fallback for older authorizer payloads
        user_id = request_context.get("authorizer", {}).get("principalId")
    
    # Validate user_id is present
    if not user_id:
        logger.error("Authorization failed: Missing userId")
        return _error_response(401, "Unauthorized: Missing user identity", is_websocket, connection_id, ws_endpoint, request_id, event=event)

    # Check case ownership (IDOR protection)
    if not check_authorization(user_id, case_id):
        logger.error(f"Authorization failed: User {user_id} does not own case {case_id}")
        return _error_response(403, "Forbidden: You do not own this case", is_websocket, connection_id, ws_endpoint, request_id, event=event)

    # Require the user to have accepted the legal/AI-use waiver before any
    # AI feature runs. Fails closed if the acceptance state cannot be read.
    try:
        conn = connect_to_db()
        if not is_disclaimer_accepted(conn, user_id):
            return _error_response(403, "You must accept the disclaimer before using the AI assistant.", is_websocket, connection_id, ws_endpoint, request_id, event=event, code="DISCLAIMER_NOT_ACCEPTED")
    except Exception as e:
        logger.error(f"Error checking disclaimer acceptance: {e}")
        return _error_response(503, "Service temporarily unavailable. Please try again later.", is_websocket, connection_id, ws_endpoint, request_id, event=event)

    case_title, case_type, jurisdiction, case_description = get_case_details(case_id)
    if case_title is None or case_type is None or jurisdiction is None or case_description is None:
        logger.error(f"Error fetching case details for case_id: {case_id}")
        return _error_response(400, 'Unable to retrieve case details. Please try again later.', is_websocket, connection_id, ws_endpoint, request_id, event=event)

    try:
        logger.info(f"Creating Bedrock LLM instance with ID: {BEDROCK_LLM_ID}, Temp: {BEDROCK_TEMP}, TopP: {BEDROCK_TOP_P}, MaxTokens: {BEDROCK_MAX_TOKENS}")
        llm = get_bedrock_llm(
            bedrock_llm_id=BEDROCK_LLM_ID,
            temperature=BEDROCK_TEMP,
            top_p=BEDROCK_TOP_P,
            max_tokens=BEDROCK_MAX_TOKENS
        )
    except Exception as e:
        logger.error(f"Error getting LLM from Bedrock: {e}")
        return _error_response(500, 'An unexpected error occurred. Please try again later or contact an administrator.', is_websocket, connection_id, ws_endpoint, request_id, event=event)

    # Enforce the daily message limit before invoking Bedrock. Counts as one
    # message per request and fails closed if the usage check cannot complete.
    if MESSAGE_LIMIT != "Infinity":
        try:
            limit = int(MESSAGE_LIMIT)
            conn = connect_to_db()
            current_usage = check_and_increment_usage(conn, user_id)
            logger.info(f"User {user_id} usage: {current_usage}/{limit}")
            if current_usage > limit:
                return _error_response(429, "Daily message limit reached. Please contact your administrator.", is_websocket, connection_id, ws_endpoint, request_id, event=event)
        except Exception as e:
            logger.error(f"Error checking message limit: {e}")
            return _error_response(503, "Service temporarily unavailable. Please try again later.", is_websocket, connection_id, ws_endpoint, request_id, event=event)

    # --- Full Case Summary Logic ---
    if sub_route == "full-case":
        logger.info(f"Generating full case summary for case_id: {case_id}")

        full_case_prompt = get_summary_prompt_template("full_case")
        if not full_case_prompt:
            return _error_response(
                500,
                "An unexpected error occurred. Please try again later or contact an administrator.",
                is_websocket,
                connection_id,
                ws_endpoint,
                request_id,
                event=event,
            )

        # 1. Get latest summaries for the canonical interview blocks
        block_summaries = get_latest_block_summaries(case_id, FULL_CASE_BLOCK_TYPES)
        if not block_summaries:
            return _error_response(400, "No block summaries found to synthesize. Please generate summaries for individual blocks first.", is_websocket, connection_id, ws_endpoint, request_id, event=event)
        
        logger.info(f"Requested full-case blocks: {FULL_CASE_BLOCK_TYPES}")
        logger.info(f"Found {len(block_summaries)} block summaries to synthesize.")

        # 2. Generate full case summary (always non-streaming for reliable model output)
        try:
            response = generate_full_case_summary(
                block_summaries=block_summaries,
                llm=llm,
                prompt_instruction=full_case_prompt,
                case_type=case_type,
                case_description=case_description,
                jurisdiction=jurisdiction,
            )
            response = _finalize_summary_response(
                response,
                is_websocket,
                connection_id,
                ws_endpoint,
                request_id,
            )
        except ValueError as e:
            logger.error(f"Full case summary was empty or invalid: {e}")
            publish_notification_event("full-case", case_id, user_id, success=False, error_message=str(e))
            return _error_response(
                500,
                "Summary generation produced no content. Please try again after more conversation in the interview assistant.",
                is_websocket,
                connection_id,
                ws_endpoint,
                request_id,
                event=event,
            )
        except Exception as e:
            logger.error(f"Error generating full case summary: {e}")
            publish_notification_event("full-case", case_id, user_id, success=False, error_message=str(e))
            return _error_response(500, 'An unexpected error occurred. Please try again later or contact an administrator.', is_websocket, connection_id, ws_endpoint, request_id, event=event)

        # 3. Save summary
        try:
            if not update_summaries(case_id, response, None, scope='full_case'):
                raise RuntimeError("Failed to persist summary to database")
        except Exception as e:
            logger.error(f"Error saving full case summary: {e}")
            publish_notification_event("full-case", case_id, user_id, success=False, error_message=str(e))
            return _error_response(500, 'An unexpected error occurred. Please try again later or contact an administrator.', is_websocket, connection_id, ws_endpoint, request_id, event=event)
        
        # 4. Publish success notification event
        publish_notification_event("full-case", case_id, user_id, success=True)
        
        # Return response
        if is_websocket and connection_id:
            send_to_websocket(connection_id, ws_endpoint, request_id, "complete", data={"llm_output": response})
            return {"statusCode": 200}
        
        return create_response(200, {"llm_output": response}, event)

    # --- Block Specific Summary Logic ---
    else:
        # Map sub_route to block_type enum
        subroute_map = {
            "intake-facts": "intake",
            "legal-analysis": "legal_analysis",
            "contrarian-analysis": "contrarian",
            "policy-context": "policy"
        }
        
        block_type = subroute_map.get(sub_route, "intake")  # Default to intake
        summary_prompt = get_summary_prompt_template("block", block_type=block_type)
        if not summary_prompt:
            return _error_response(
                500,
                "An unexpected error occurred. Please try again later or contact an administrator.",
                is_websocket,
                connection_id,
                ws_endpoint,
                request_id,
                event=event,
            )
        
        # Construct unique session ID based on case and block type
        session_id = f"{case_id}-{block_type}"
        
        try:
            logger.info(f"Retrieving dynamo history for session_id: {session_id}")
            conversation_history = retrieve_dynamodb_history(TABLE_NAME, session_id)
        except Exception as e:
            logger.error(f"Error retrieving dynamo history: {e}")
            return _error_response(500, 'An unexpected error occurred. Please try again later or contact an administrator.', is_websocket, connection_id, ws_endpoint, request_id, event=event)
        
        if not conversation_history or not conversation_history.strip():
            logger.warning(f"No conversation history found for session_id: {session_id}")
            return _error_response(400, 'No conversation history found for this block. Please have a conversation in the interview assistant first before generating a summary.', is_websocket, connection_id, ws_endpoint, request_id, event=event)

        try:
            logger.info("Generating response from the LLM.")
            response = generate_lawyer_summary(
                conversation_history=conversation_history,
                llm=llm,
                prompt_instruction=summary_prompt,
                case_type=case_type,
                case_description=case_description,
                jurisdiction=jurisdiction,
                block_type=block_type,
            )
            response = _finalize_summary_response(
                response,
                is_websocket,
                connection_id,
                ws_endpoint,
                request_id,
            )
        except ValueError as e:
            logger.error(f"Block summary was empty or invalid for {block_type}: {e}")
            publish_notification_event(sub_route, case_id, user_id, success=False, error_message=str(e))
            return _error_response(
                500,
                "Summary generation produced no content. Please try again after more conversation in the interview assistant.",
                is_websocket,
                connection_id,
                ws_endpoint,
                request_id,
                event=event,
            )
        except Exception as e:
            logger.error(f"Error getting response: {e}")
            publish_notification_event(sub_route, case_id, user_id, success=False, error_message=str(e))
            return _error_response(500, 'An unexpected error occurred. Please try again later or contact an administrator.', is_websocket, connection_id, ws_endpoint, request_id, event=event)
            
        try:
            logger.info(f"Updating case summary for block_type: {block_type}")
            # Note: scope defaults to 'block'
            if not update_summaries(case_id, response, block_type, scope='block'):
                raise RuntimeError("Failed to persist summary to database")
        except Exception as e:
            logger.error(f"Error updating case summary: {e}")
            publish_notification_event(sub_route, case_id, user_id, success=False, error_message=str(e))
            return _error_response(500, 'An unexpected error occurred. Please try again later or contact an administrator.', is_websocket, connection_id, ws_endpoint, request_id, event=event)
        
        # Publish success notification event
        publish_notification_event(sub_route, case_id, user_id, success=True)
        
        # Return response
        if is_websocket and connection_id:
            send_to_websocket(connection_id, ws_endpoint, request_id, "complete", data={"llm_output": response})
            return {"statusCode": 200}
            
        return create_response(200, {"llm_output": response}, event)
