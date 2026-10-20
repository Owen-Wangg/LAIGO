import os
import json
import boto3
import uuid
import psycopg
from aws_lambda_powertools import Logger
from bedrock_client import get_bedrock_runtime_client

from helpers.chat import get_bedrock_llm, get_playground_streaming_response
from helpers.usage import check_and_increment_usage, is_disclaimer_accepted

# Set up logging for the Lambda function
logger = Logger(service="PlaygroundGeneration")

# Environment variables
DB_SECRET_NAME = os.environ["SM_DB_CREDENTIALS"]
REGION = os.environ["REGION"]
RDS_PROXY_ENDPOINT = os.environ.get("RDS_PROXY_ENDPOINT")
BEDROCK_LLM_PARAM = os.environ["BEDROCK_LLM_PARAM"]
TABLE_NAME_PARAM = os.environ["TABLE_NAME_PARAM"]
BEDROCK_TEMP_PARAM = os.environ.get("BEDROCK_TEMP_PARAM")
BEDROCK_TOP_P_PARAM = os.environ.get("BEDROCK_TOP_P_PARAM")
BEDROCK_MAX_TOKENS_PARAM = os.environ.get("BEDROCK_MAX_TOKENS_PARAM")
MESSAGE_LIMIT_PARAM = os.environ.get("MESSAGE_LIMIT_PARAM")

# AWS Clients
secrets_manager_client = boto3.client("secretsmanager")
ssm_client = boto3.client("ssm", region_name=REGION)
bedrock_runtime = get_bedrock_runtime_client(region_name=REGION)

# Cached resources
connection = None
db_secret = None
BEDROCK_LLM_ID = None
TABLE_NAME = None
BEDROCK_TEMP = 0.5
BEDROCK_TOP_P = 0.9
BEDROCK_MAX_TOKENS = 2048
MESSAGE_LIMIT = None


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
            # Require TLS and verify the RDS Proxy certificate/hostname against
            # the OS CA bundle (which contains the Amazon roots), mirroring the
            # standard-mode Lambdas.
            'sslmode': 'verify-full',
            'sslrootcert': '/etc/pki/tls/certs/ca-bundle.crt',
        }
        connection_string = " ".join([f"{key}={value}" for key, value in connection_params.items()])
        connection = psycopg.connect(connection_string)
        logger.info("Successfully connected to database with SSL/TLS")
    except Exception as e:
        logger.exception(f"Failed to connect to database: {e}")
        if connection:
            try:
                connection.close()
            except Exception:
                pass
        connection = None
        raise
    return connection

def get_cors_origin(event):
    allowed_origin = os.environ.get("ALLOWED_ORIGIN", "")
    if not allowed_origin:
        return "http://localhost:5173"
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

def get_parameter(param_name, cached_var):
    if cached_var is None:
        try:
            response = ssm_client.get_parameter(Name=param_name, WithDecryption=True)
            cached_var = response["Parameter"]["Value"]
        except Exception as e:
            logger.error(f"Error fetching parameter {param_name}: {e}")
            raise
    return cached_var

def initialize_constants():
    global BEDROCK_LLM_ID, TABLE_NAME, BEDROCK_TEMP, BEDROCK_TOP_P, BEDROCK_MAX_TOKENS, MESSAGE_LIMIT
    BEDROCK_LLM_ID = get_parameter(BEDROCK_LLM_PARAM, BEDROCK_LLM_ID)
    # TABLE_NAME might be passed as env var directly for playground to point to specific table
    # But current code tries to fetch from param. 
    # Logic change: Use env var TABLE_NAME directly if available (set in CDK), otherwise param.
    TABLE_NAME = os.environ.get("TABLE_NAME")
    if not TABLE_NAME:
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

    if MESSAGE_LIMIT_PARAM:
        MESSAGE_LIMIT = get_parameter(MESSAGE_LIMIT_PARAM, MESSAGE_LIMIT)
    if MESSAGE_LIMIT is None:
        MESSAGE_LIMIT = "Infinity"


def get_default_system_prompt():
    return '''You are a helpful assistant to me, a law student, who answers with kindness while being concise, so that it is easy to read your responses quickly yet still get valuable information from them. No need to be conversational, just skip to talking about the content. Refer to me, the law student, in the second person. I will provide you with context to a legal case I am interviewing my client about, and you exist to help provide legal context and analysis, relevant issues, possible strategies to defend the client, and other important details in a structured natural language response.

To me, the law student, when I provide you with context on certain client cases, and you should provide possible follow-up questions for me, the law student, to ask the client to help progress the case more after your initial (concise and easy to read) analysis. These are NOT for the client to ask a lawyer; this is to help me, the law student, learn what kind of questions to ask my client, so in your analysis you should provide follow-up questions for me, the law student, to ask the client as if I were a lawyer.

Initially, also break down the case and analyze it from a detailed but concise legal perspective. You should also mention certain legal information and implications that I, the law student, may have missed, and mention which part of Canadian law it is applicable to if possible or helpful (as well as cite where I can find that relevant info).

You are NOT allowed to hallucinate, informational accuracy and being up-to-date is important. If you are asked something for which you do not know, either say "I don't know" or ask for further information if applicable and not an invasion of privacy.

Do not indent your text.'''

@logger.inject_lambda_context(log_event=False)
def handler(event, context):
    logger.info("Playground Generation Lambda function is called!")
    initialize_constants()
    
    # Defense-in-depth: verify caller has staff role (admin or instructor)
    # Primary RBAC check is in the WebSocket default handler; this is a secondary safeguard
    caller_roles = event.get("callerRoles", [])
    if not isinstance(caller_roles, list):
        caller_roles = []
    
    is_staff = "admin" in caller_roles or "instructor" in caller_roles
    if not is_staff:
        logger.warn("Unauthorized playground access — caller lacks admin/instructor role", 
                    extra={"userId": event.get("userId"), "callerRoles": caller_roles})
        return create_response(403, {"error": "Forbidden: Administrative access required"}, event)
    
    # Extract request context
    is_websocket = event.get("isWebSocket", False)
    request_context = event.get("requestContext", {})
    connection_id = request_context.get("connectionId")
    domain_name = request_context.get("domainName")
    stage = request_context.get("stage")
    request_id = event.get("requestId")
    
    # In playground, we largely rely on body params
    body = {} if event.get("body") is None else json.loads(event.get("body"))
    
    if not is_websocket or not connection_id:
        # Fallback for HTTP/Test invoke - mostly simplified for now
        return create_response(400, "Playground only supports WebSocket interactions currently.", event)

    logger.info("Playground mode processing...")
    
    # Extract playground parameters
    custom_prompt = body.get("custom_prompt", get_default_system_prompt())
    test_message = body.get("message_content", "")
    
    playground_block_type = body.get("block_type", "intake") # Default
    
    # IDOR protection: bind the playground session key to the authenticated
    # caller so stored transcripts are namespaced per user. user_id comes from
    # the trusted boundary (WebSocket handler / authorizer), never the body.
    # This must stay consistent with the assess_progress reader, which
    # reconstructs the key as playground-{user_id}-{session_id}-{block_type}.
    user_id = event.get("userId")
    if not user_id:
        user_id = request_context.get("authorizer", {}).get("principalId")
    if not user_id:
        logger.error("Authorization failed: Missing userId for playground generation")
        return create_response(401, {"error": "Unauthorized: Missing user identity"}, event)

    # Construct unique session ID based on playground marker, user_id, session_id and block_type
    session_id = body.get("session_id", str(uuid.uuid4())[:8])
    playground_session_id = f"playground-{user_id}-{session_id}-{playground_block_type}"
    
    # Custom model configuration (override defaults)
    custom_model_id = body.get("model_id", BEDROCK_LLM_ID)
    try:
        custom_temperature = float(body.get("temperature", BEDROCK_TEMP))
    except (ValueError, TypeError):
        custom_temperature = BEDROCK_TEMP
        
    try:
        custom_top_p = float(body.get("top_p", BEDROCK_TOP_P))
    except (ValueError, TypeError):
        custom_top_p = BEDROCK_TOP_P
        
    try:
        custom_max_tokens = int(body.get("max_tokens", BEDROCK_MAX_TOKENS))
    except (ValueError, TypeError):
        custom_max_tokens = BEDROCK_MAX_TOKENS
    
    if not test_message:
        logger.error("Playground mode requires message_content")
        return create_response(400, "Missing message_content for playground", event)

    # Resolve the WebSocket endpoint up front so the consent/quota gates below
    # can surface errors to the client over the same channel.
    gate_ws_endpoint = os.environ.get("WEBSOCKET_API_ENDPOINT") or f"https://{domain_name}/{stage}"

    def _send_playground_error(content, data=None):
        try:
            apigw_client = boto3.client('apigatewaymanagementapi', endpoint_url=gate_ws_endpoint)
            message = {"action": "playground_test", "type": "error", "requestId": request_id, "content": content}
            if data is not None:
                message["data"] = data
            apigw_client.post_to_connection(
                ConnectionId=connection_id,
                Data=json.dumps(message).encode('utf-8'),
            )
        except Exception as ws_error:
            logger.error(f"Failed to send playground gate error to WebSocket: {ws_error}")

    # Consent gate: require the user to have accepted the legal/AI-use waiver
    # before any billed Bedrock work runs. Playground is not exempt. Fails
    # closed if the acceptance state cannot be read, mirroring assess_progress.
    try:
        conn = connect_to_db()
        if not is_disclaimer_accepted(conn, user_id):
            logger.warning(f"Playground blocked: user {user_id} has not accepted the disclaimer")
            _send_playground_error(
                "You must accept the disclaimer before using the AI assistant.",
                data={"code": "DISCLAIMER_NOT_ACCEPTED"},
            )
            return {"statusCode": 200}
    except Exception as e:
        logger.error(f"Error checking disclaimer acceptance: {e}")
        _send_playground_error("Service temporarily unavailable. Please try again later.")
        return {"statusCode": 503}

    # Quota gate: enforce the daily message limit before invoking Bedrock so
    # playground requests are metered like standard-mode requests. Counts as one
    # message per request and fails closed if the usage check cannot run.
    if MESSAGE_LIMIT != "Infinity":
        try:
            limit = int(MESSAGE_LIMIT)
            conn = connect_to_db()
            current_usage = check_and_increment_usage(conn, user_id)
            logger.info(f"User {user_id} playground usage: {current_usage}/{limit}")
            if current_usage > limit:
                _send_playground_error("Daily message limit reached. Please contact your administrator.")
                return {"statusCode": 200}
        except Exception as e:
            logger.error(f"Error checking message limit: {e}")
            _send_playground_error("Service temporarily unavailable. Please try again later.")
            return {"statusCode": 503}

    # Apply guardrail to test message input
    try:
        guardrail_id = os.environ.get("GUARDRAIL_ID")
        guardrail_version = os.environ.get("GUARDRAIL_VERSION")
        
        if guardrail_id and guardrail_version:
            logger.info(f"Applying guardrail to playground input - ID: {guardrail_id}, version: {guardrail_version}")
            guard_response = bedrock_runtime.apply_guardrail(
                guardrailIdentifier=guardrail_id,
                guardrailVersion=guardrail_version,
                source="INPUT",
                content=[{"text": {"text": test_message, "qualifiers": ["guard_content"]}}]
            )
            
            if guard_response.get("action") == "GUARDRAIL_INTERVENED":
                logger.info(f"Guardrail blocked playground input: {guard_response}")
                
                # Determine error message based on guardrail assessment
                error_message = "Sorry, I cannot process your request."
                for assessment in guard_response.get('assessments', []):
                    if 'sensitiveInformationPolicy' in assessment:
                        error_message = ("Sorry, I cannot process your request because it appears to contain personal information. "
                                        "Please submit your query without including personal identifiable information (Names, Phone Numbers, Addresses, etc.).")
                        break
                    else:
                        error_message = ("Sorry, I cannot process your request because it appears to contain prompt manipulation attempts. "
                                        "Please submit a query without any instructions attempting to manipulate the system.")
                
                # Send error via WebSocket
                websocket_endpoint = os.environ.get("WEBSOCKET_API_ENDPOINT", f"https://{domain_name}/{stage}")
                apigw_client = boto3.client('apigatewaymanagementapi', endpoint_url=websocket_endpoint)
                apigw_client.post_to_connection(
                    ConnectionId=connection_id,
                    Data=json.dumps({"action": "playground_test", "type": "error", "requestId": request_id, "content": error_message}).encode('utf-8')
                )
                return {"statusCode": 200}
        else:
            logger.warning("Guardrail environment variables not set for playground")
    except Exception as guardrail_error:
        logger.error(f"Error applying guardrail to playground input: {guardrail_error}")
        # Fail closed — do not process request without guardrail validation
        try:
            websocket_endpoint = os.environ.get("WEBSOCKET_API_ENDPOINT", f"https://{domain_name}/{stage}")
            apigw_client = boto3.client('apigatewaymanagementapi', endpoint_url=websocket_endpoint)
            apigw_client.post_to_connection(
                ConnectionId=connection_id,
                Data=json.dumps({"action": "playground_test", "type": "error", "requestId": request_id, "content": "Content validation is temporarily unavailable. Please try again later."}).encode('utf-8')
            )
        except Exception as ws_error:
            logger.error(f"Failed to send guardrail failure message to WebSocket: {ws_error}")
        return {"statusCode": 503}
    
    try:
         # Create LLM with custom configuration and guardrails
        logger.info(f"Playground: Creating LLM with model={custom_model_id}, temp={custom_temperature}, top_p={custom_top_p}, max_tokens={custom_max_tokens}")
        llm = get_bedrock_llm(
            bedrock_llm_id=custom_model_id,
            temperature=custom_temperature,
            top_p=custom_top_p,
            max_tokens=custom_max_tokens,
        )
        
        websocket_endpoint = os.environ.get("WEBSOCKET_API_ENDPOINT")
        if not websocket_endpoint:
            websocket_endpoint = f"https://{domain_name}/{stage}"
        
        # Extract mock case context for playground
        mock_case_context = body.get("case_context", {})
        
        # Use playground streaming response
        get_playground_streaming_response(
            query=test_message,
            llm=llm,
            table_name=TABLE_NAME,
            session_id=playground_session_id,
            system_prompt=custom_prompt,
            connection_id=connection_id,
            websocket_endpoint=websocket_endpoint,
            request_id=request_id,
            case_context=mock_case_context
        )
        
        logger.info("Playground streaming response completed.")
        return {"statusCode": 200}
        
    except Exception as e:
        logger.error(f"Playground error: {e}")
        try:
            websocket_endpoint = os.environ.get("WEBSOCKET_API_ENDPOINT", f"https://{domain_name}/{stage}")
            apigw_client = boto3.client('apigatewaymanagementapi', endpoint_url=websocket_endpoint)
            apigw_client.post_to_connection(
                ConnectionId=connection_id,
                Data=json.dumps({"action": "playground_test", "type": "error", "requestId": request_id, "content": "An unexpected error occurred. Please try again later or contact an administrator."}).encode('utf-8')
            )
        except Exception as ws_error:
            logger.error(f"Failed to send playground error to WebSocket: {ws_error}")
        return {"statusCode": 500}
