import os
import json
import boto3
import logging
import psycopg
import functools
from aws_lambda_powertools import Logger, Metrics
from bedrock_client import get_bedrock_runtime_client

from helpers.chat import get_bedrock_llm, get_initial_student_query, get_response, get_streaming_response
from helpers.usage import check_and_increment_usage, is_disclaimer_accepted
 
# Set up logging and metrics for the Lambda function
logger = Logger(service="TextGeneration")
metrics = Metrics(namespace="LAIGO", service="TextGeneration")

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
GUARDRAIL_ID = os.environ["GUARDRAIL_ID"]
GUARDRAIL_VERSION = os.environ["GUARDRAIL_VERSION"]
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
            logger.error(f"Failed to decode JSON for secret : {e}")
            raise ValueError(f"Secret is not properly formatted as JSON.")
        except Exception as e:
            logger.error("Error fetching secret. Please check the system logs for more details.")
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
    global BEDROCK_LLM_ID, TABLE_NAME, BEDROCK_TEMP, BEDROCK_TOP_P, BEDROCK_MAX_TOKENS, MESSAGE_LIMIT
    BEDROCK_LLM_ID = get_parameter(BEDROCK_LLM_PARAM, BEDROCK_LLM_ID)
    TABLE_NAME = get_parameter(TABLE_NAME_PARAM, TABLE_NAME)
    logger.info(f"Using DynamoDB conversation history table: {TABLE_NAME}")
    
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
    
    # Table is managed by CDK; Lambda should only read/write existing table.

def connect_to_db():
    global connection
    if connection is not None and not connection.closed:
        # Health check: verify the existing connection is still usable
        try:
            with connection.cursor() as cur:
                cur.execute("SELECT 1")
            return connection
        except Exception as e:
            logger.warn(f"Stale database connection detected, reconnecting: {e}")
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

@functools.lru_cache(maxsize=128)
def check_authorization(user_id, case_id):
    """
    Verify that the user (identified by user_id) owns the specified case.
    Prevents sending messages on behalf of another user.
    
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
            # Chat send path: only the case owner can send.
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




def get_system_prompt(block_type):
    # Connect to the database
    connection = connect_to_db()
    if connection is None:
        raise ValueError("Database connection failed")

    try:
        cur = connection.cursor()
        logger.info("Connected to RDS instance!")

        # Query to get the active system prompt for the specific block_type
        cur.execute("""
            SELECT prompt_text
            FROM prompt_versions
            WHERE block_type = %s
              AND is_active = true
              AND category = 'reasoning'
            ORDER BY version_number DESC
            LIMIT 1;
        """, (block_type,))
        
        result = cur.fetchone()
        cur.close()

        if result:
            # Extract the prompt from the query result
            latest_prompt = result[0]
            logger.info(f"Successfully fetched the active system prompt for block_type: {block_type}.")
            return latest_prompt
        else:
            logger.error(f"No active system prompt found for block_type: {block_type}.")
            return None
    except Exception as e:
        logger.error(f"Error fetching system prompt: {e}")
        if cur:
            cur.close()
        connection.rollback()
        return None

def get_audio_details(case_id):
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
            SELECT case_description
            FROM "cases"
            WHERE case_id = %s;
        """, (case_id,))        
        result = cur.fetchone()
        logger.info(f"Query result: {result}")        
        cur.close()
        if result:
            audio_description = result[0]
            logger.info(f"Audio description found for case_id {case_id}: {audio_description}")
            return audio_description
        else:
            logger.error(f"No audio description found for case_id {case_id}")
            return None
    except Exception as e:
        logger.error(f"Error fetching audio description: {e}")
        if cur:
            cur.close()
        connection.rollback()
        return None

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
            SELECT case_title, case_type, jurisdiction, case_description, province, statute
            FROM "cases"
            WHERE case_id = %s;
        """, (case_id,))

        result = cur.fetchone()

        cur.close()
 
        if result:
            case_title, case_type, jurisdiction, case_description, province, statute = result
            logger.info(f"Case details found for case_id {case_id}")
            return case_title, case_type, jurisdiction, case_description, province, statute
        else:
            logger.warning(f"No details found for case_id {case_id}")
            return None, None, None, None, None, None

    except Exception as e:
        logger.error(f"Error fetching case details: {e}")
        if cur:
            cur.close()
        connection.rollback()
        return None, None, None, None, None, None


@metrics.log_metrics(capture_cold_start_metric=True)
@logger.inject_lambda_context(log_event=False)
def handler(event, context):
    #logger.info("Text Generation Lambda function is called!")
    initialize_constants()
    
    # Extract request context early for both WebSocket and HTTP
    is_websocket = event.get("isWebSocket", False)
    request_context = event.get("requestContext", {})
    connection_id = request_context.get("connectionId")
    domain_name = request_context.get("domainName")
    stage = request_context.get("stage")
    request_id = event.get("requestId")

    query_params = event.get("queryStringParameters", {}) or {}
    case_id = query_params.get("case_id", "")
    sub_route = query_params.get("sub_route", "intake-facts") # Default to intake-facts if missing

    # Map sub_route to block_type enum
    subroute_map = {
        "intake-facts": "intake",
        "legal-analysis": "legal_analysis",
        "contrarian-analysis": "contrarian",
        "policy-context": "policy"
    }
    
    block_type = subroute_map.get(sub_route, "intake") # Default to intake if invalid sub_route

    
    if not case_id:
        return create_response(400, "Missing required parameters: case_id", event)

    # Unified Identity Extraction
    # Prefer explicit payload userId (used by websocket invocations),
    # then fall back to HTTP API authorizer context.
    user_id = event.get("userId")
    if not user_id:
        user_id = request_context.get("authorizer", {}).get("userId")

    # Unified Authorization Check — must run before any case content is loaded,
    # logged, or sent to Bedrock so callers cannot probe cases they do not own.
    if not user_id:
        logger.error("Authorization failed: Missing user identity")
        if is_websocket:
            return {"statusCode": 401, "body": "Unauthorized"}
        else:
            return create_response(
                401,
                {"error": "Unauthorized: Missing user identity"},
                event,
            )

    if not check_authorization(user_id, case_id):
        logger.error(
            f"Authorization failed: User {user_id} is not permitted to send messages for case {case_id}"
        )
        if is_websocket:
            return {"statusCode": 403, "body": "Forbidden"}
        else:
            return create_response(403, {"error": "Forbidden: Only advocates can send messages for their own cases."}, event)

    system_prompt = get_system_prompt(block_type)
    if system_prompt is None:
        logger.error(f"Error fetching system prompt for block_type: {block_type}")
        return create_response(400, 'Error fetching system prompt', event)
    
    case_title, case_type, jurisdiction, case_description, province, statute = get_case_details(case_id)
    if case_title is None or case_type is None or jurisdiction is None or case_description is None or province is None or statute is None:
        logger.error(f"Error fetching case details for case_id: {case_id}")

    body = {} if event.get("body") is None else json.loads(event.get("body"))
    question = body.get("message_content", "")

    # Construct unique session ID based on case and subroute
    session_id = f"{case_id}-{block_type}"
    
    if not question:
        logger.info(f"Start of conversation. Creating conversation history table in DynamoDB.")
        student_query = get_initial_student_query(case_type, jurisdiction, case_description)

        # Apply guardrail to initial query (case context) — prevents PII/harmful content on first turn
        guardrail_id = GUARDRAIL_ID
        guardrail_version = GUARDRAIL_VERSION
        try:
            guard_response = bedrock_runtime.apply_guardrail(
                guardrailIdentifier=guardrail_id,
                guardrailVersion=guardrail_version,
                source="INPUT",
                content=[{"text": {"text": student_query, "qualifiers": ["guard_content"]}}]
            )
            if guard_response.get("action") == "GUARDRAIL_INTERVENED":
                logger.info(f"Guardrail blocked initial case context: {json.dumps(guard_response)}")
                error_message = "Sorry, I cannot process this case because it appears to contain content that violates our content policy. Please review the case details and try again."
                for assessment in guard_response.get('assessments', []):
                    if 'sensitiveInformationPolicy' in assessment:
                        error_message = ("Sorry, I cannot process this case because it appears to contain personal information in the case details. "
                                        "Please remove personal identifiable information (Names, Phone Numbers, Addresses, etc.) from the case description.")
                        break

                if is_websocket and connection_id:
                    try:
                        websocket_endpoint = os.environ.get("WEBSOCKET_API_ENDPOINT")
                        if not websocket_endpoint:
                            websocket_endpoint = f"https://{domain_name}/{stage}"
                        apigw_client = boto3.client('apigatewaymanagementapi', endpoint_url=websocket_endpoint)
                        apigw_client.post_to_connection(
                            ConnectionId=connection_id,
                            Data=json.dumps({"type": "error", "requestId": request_id, "action": "generate_text", "content": error_message}).encode('utf-8')
                        )
                        return {"statusCode": 200}
                    except Exception as ws_error:
                        logger.error(f"Failed to send guardrail error to WebSocket: {ws_error}")
                        return {"statusCode": 500}
                return create_response(400, {"error": error_message}, event)
        except Exception as guardrail_error:
            logger.error(f"Error applying guardrail to initial case context: {guardrail_error}")
            # Fail closed — do not proceed without guardrail validation
            error_message = "Unable to validate case content. Please try again later."
            if is_websocket and connection_id:
                try:
                    websocket_endpoint = os.environ.get("WEBSOCKET_API_ENDPOINT")
                    if not websocket_endpoint:
                        websocket_endpoint = f"https://{domain_name}/{stage}"
                    apigw_client = boto3.client('apigatewaymanagementapi', endpoint_url=websocket_endpoint)
                    apigw_client.post_to_connection(
                        ConnectionId=connection_id,
                        Data=json.dumps({"type": "error", "requestId": request_id, "action": "generate_text", "content": error_message}).encode('utf-8')
                    )
                    return {"statusCode": 200}
                except Exception as ws_error:
                    logger.error(f"Failed to send guardrail error to WebSocket: {ws_error}")
                    return {"statusCode": 500}
            return create_response(503, {"error": error_message}, event)

    else:
        logger.info("Processing student question", questionLength=len(question.strip()))
        student_query = question.strip()

        # Use guardrail from CDK environment variables
        guardrail_id = GUARDRAIL_ID
        guardrail_version = GUARDRAIL_VERSION
        logger.info(f"Using guardrail ID: {guardrail_id}, version: {guardrail_version}")

        guard_response = bedrock_runtime.apply_guardrail(
            guardrailIdentifier=guardrail_id,
            guardrailVersion=guardrail_version,
            source="INPUT",
            content=[{"text": {"text": question, "qualifiers": ["guard_content"]}}]
        )
        if guard_response.get("action") == "GUARDRAIL_INTERVENED":
            # Add debug logging to see the full guardrail response
            logger.info(f"Guardrail response: {json.dumps(guard_response)}")
            
            # Check if it's a PII issue or prompt attack
            error_message = "Sorry, I cannot process your request."
            for assessment in guard_response.get('assessments', []):
                if 'sensitiveInformationPolicy' in assessment:
                    error_message = ("Sorry, I cannot process your request because it appears to contain personal information. "
                                    "Please submit your query without including personal identifiable information (Names, Phone Numbers, Addresses, etc.).")
                    break
                else:
                    error_message = ("Sorry, I cannot process your request because it appears to contain prompt manipulation attempts. "
                                    "Please submit a query without any instructions attempting to manipulate the system.")
            
            if is_websocket and connection_id:
                try:
                    websocket_endpoint = os.environ.get("WEBSOCKET_API_ENDPOINT")
                    if not websocket_endpoint:
                         websocket_endpoint = f"https://{domain_name}/{stage}"
                    
                    apigw_client = boto3.client('apigatewaymanagementapi', endpoint_url=websocket_endpoint)
                    apigw_client.post_to_connection(
                        ConnectionId=connection_id,
                        Data=json.dumps({"type": "error", "requestId": request_id, "action": "generate_text", "content": error_message}).encode('utf-8')
                    )
                    return {"statusCode": 200} # Return 200 to acknowledge processing
                except Exception as ws_error:
                    logger.error(f"Failed to send guardrail error to WebSocket: {ws_error}")
                    return {"statusCode": 500}

            return create_response(400, {"error": error_message}, event)
    try:
        logger.info(f"Creating Bedrock LLM instance with ID: {BEDROCK_LLM_ID}, Temp: {BEDROCK_TEMP}, TopP: {BEDROCK_TOP_P}, MaxTokens: {BEDROCK_MAX_TOKENS}")
        llm = get_bedrock_llm(
            bedrock_llm_id=BEDROCK_LLM_ID,
            temperature=BEDROCK_TEMP,
            top_p=BEDROCK_TOP_P,
            max_tokens=BEDROCK_MAX_TOKENS,
        )
    except Exception as e:
        logger.error(f"Error getting LLM from Bedrock: {e}")
        return create_response(500, 'Error getting LLM from Bedrock', event)

    try:
        logger.info("Generating response from the LLM.")

        # Require the user to have accepted the legal/AI-use waiver before any
        # AI feature runs. Fails closed if the acceptance state cannot be read.
        try:
            conn = connect_to_db()
            if not is_disclaimer_accepted(conn, user_id):
                error_message = "You must accept the disclaimer before using the AI assistant."
                if is_websocket and connection_id:
                    websocket_endpoint = os.environ.get("WEBSOCKET_API_ENDPOINT")
                    if not websocket_endpoint:
                        websocket_endpoint = f"https://{domain_name}/{stage}"
                    apigw_client = boto3.client('apigatewaymanagementapi', endpoint_url=websocket_endpoint)
                    apigw_client.post_to_connection(
                        ConnectionId=connection_id,
                        Data=json.dumps({"type": "error", "requestId": request_id, "code": "DISCLAIMER_NOT_ACCEPTED", "content": error_message}).encode('utf-8')
                    )
                    return {"statusCode": 200}
                return create_response(403, {"error": error_message, "code": "DISCLAIMER_NOT_ACCEPTED"}, event)
        except Exception as e:
            logger.error(f"Error checking disclaimer acceptance: {e}")
            error_message = "Service temporarily unavailable. Please try again later."
            if is_websocket and connection_id:
                try:
                    websocket_endpoint = os.environ.get("WEBSOCKET_API_ENDPOINT")
                    if not websocket_endpoint:
                        websocket_endpoint = f"https://{domain_name}/{stage}"
                    apigw_client = boto3.client('apigatewaymanagementapi', endpoint_url=websocket_endpoint)
                    apigw_client.post_to_connection(
                        ConnectionId=connection_id,
                        Data=json.dumps({"type": "error", "requestId": request_id, "content": error_message}).encode('utf-8')
                    )
                except Exception as ws_error:
                    logger.error(f"Failed to send disclaimer error to WebSocket: {ws_error}")
                return {"statusCode": 503}
            return create_response(503, {"error": error_message}, event)


        # Check Message Limit
        if MESSAGE_LIMIT != "Infinity":
            try:
                limit = int(MESSAGE_LIMIT)
                conn = connect_to_db()
                current_usage = check_and_increment_usage(conn, user_id)
                logging.info(f"User {user_id} usage: {current_usage}/{limit}")
                    
                if current_usage > limit:
                    error_message = "Daily message limit reached. Please contact your administrator."
                    if is_websocket and connection_id:
                        websocket_endpoint = os.environ.get("WEBSOCKET_API_ENDPOINT")
                        if not websocket_endpoint:
                            websocket_endpoint = f"https://{domain_name}/{stage}"

                        apigw_client = boto3.client('apigatewaymanagementapi', endpoint_url=websocket_endpoint)
                        apigw_client.post_to_connection(
                            ConnectionId=connection_id,
                            Data=json.dumps({"type": "error", "requestId": request_id, "content": error_message}).encode('utf-8')
                        )
                        return {"statusCode": 200}
                    else:
                         return create_response(429, {"error": error_message}, event)
            except Exception as e:
                logger.error(f"Error checking message limit: {e}")
                # Fail closed: deny request if usage check fails (prevents bypass during DB outages)
                error_message = "Service temporarily unavailable. Please try again later."
                if is_websocket and connection_id:
                    try:
                        websocket_endpoint = os.environ.get("WEBSOCKET_API_ENDPOINT")
                        if not websocket_endpoint:
                            websocket_endpoint = f"https://{domain_name}/{stage}"
                        apigw_client = boto3.client('apigatewaymanagementapi', endpoint_url=websocket_endpoint)
                        apigw_client.post_to_connection(
                            ConnectionId=connection_id,
                            Data=json.dumps({"type": "error", "requestId": request_id, "content": error_message}).encode('utf-8')
                        )
                    except Exception as ws_error:
                        logger.error(f"Failed to send rate limit error to WebSocket: {ws_error}")
                    return {"statusCode": 503}
                else:
                    return create_response(503, {"error": error_message}, event)

        # Request Processing
        if is_websocket and connection_id:
            # WebSocket streaming mode
            logger.info(f"WebSocket streaming mode - connectionId: {connection_id}, userId: {user_id}")
            
            websocket_endpoint = os.environ.get("WEBSOCKET_API_ENDPOINT")
            if not websocket_endpoint:
                websocket_endpoint = f"https://{domain_name}/{stage}"
            
            get_streaming_response(
                query=student_query,
                province=province,
                statute=statute,
                llm=llm,
                table_name=TABLE_NAME,
                case_id=session_id,
                system_prompt=system_prompt,
                case_type=case_type,
                jurisdiction=jurisdiction,
                case_description=case_description,
                connection_id=connection_id,
                websocket_endpoint=websocket_endpoint,
                request_id=request_id,
            )
            # For WebSocket invocations, we don't return an HTTP response
            # The streaming response is sent directly to the WebSocket connection
            logger.info("Streaming response completed.")
            return {"statusCode": 200}
        else:
            # Traditional HTTP mode
            logger.info(f"HTTP mode processing request from user {user_id}")
            
            response = get_response(
                query=student_query,
                province=province,
                statute=statute,
                llm=llm,
                table_name=TABLE_NAME,
                case_id=session_id,
                system_prompt=system_prompt,
                case_type=case_type,
                jurisdiction=jurisdiction,
                case_description=case_description,
            )
            logger.info(
                "AI response generated",
                responseLength=len(str(response or "")),
            )

    except Exception as e:
        logger.error(f"Error getting response from AI: {e}")
        # For WebSocket errors, try to send error message to client
        if is_websocket and connection_id:
            try:
                websocket_endpoint = os.environ.get("WEBSOCKET_API_ENDPOINT", f"https://{domain_name}/{stage}")
                apigw_client = boto3.client('apigatewaymanagementapi', endpoint_url=websocket_endpoint)
                apigw_client.post_to_connection(
                    ConnectionId=connection_id,
                    Data=json.dumps({"type": "error", "requestId": request_id, "content": "An unexpected error occurred. Please try again later or contact an administrator."}).encode('utf-8')
                )
            except Exception as ws_error:
                logger.error(f"Failed to send error to WebSocket: {ws_error}")
            return {"statusCode": 500}
        return create_response(500, 'An unexpected error occurred. Please try again later or contact an administrator.', event)


    logger.info("Returning the generated response.")
    return create_response(200, response, event)


    


