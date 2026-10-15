import os
import json
import hashlib
import base64
import uuid
import boto3
import psycopg
from aws_lambda_powertools import Logger, Metrics
from bedrock_client import get_bedrock_runtime_client

from helpers.chat import get_bedrock_llm, generate_case_title
from helpers.usage import check_and_increment_usage, is_disclaimer_accepted

# Set up logging and metrics for the Lambda function
logger = Logger(service="CaseGeneration")
metrics = Metrics(namespace="LAIGO", service="CaseGeneration")

# Environment variables
DB_SECRET_NAME = os.environ["SM_DB_CREDENTIALS"]
REGION = os.environ["REGION"]
RDS_PROXY_ENDPOINT = os.environ["RDS_PROXY_ENDPOINT"]
BEDROCK_LLM_PARAM = os.environ["BEDROCK_LLM_PARAM"]
TABLE_NAME_PARAM = os.environ["TABLE_NAME_PARAM"]
BEDROCK_TEMP_PARAM = os.environ.get("BEDROCK_TEMP_PARAM")
BEDROCK_TOP_P_PARAM = os.environ.get("BEDROCK_TOP_P_PARAM")
BEDROCK_MAX_TOKENS_PARAM = os.environ.get("BEDROCK_MAX_TOKENS_PARAM")
CASE_TYPES_PARAM = os.environ.get("CASE_TYPES_PARAM")
GUARDRAIL_ID = os.environ["GUARDRAIL_ID"]
GUARDRAIL_VERSION = os.environ["GUARDRAIL_VERSION"]
MESSAGE_LIMIT_PARAM = os.environ["MESSAGE_LIMIT_PARAM"]

# AWS clients
secrets_manager_client = boto3.client("secretsmanager")
ssm_client = boto3.client("ssm", region_name=REGION)
bedrock_runtime = get_bedrock_runtime_client(region_name=REGION)

# Globals
connection = None
db_secret = None
BEDROCK_LLM_ID = None
TABLE_NAME = None
BEDROCK_TEMP = 0.7
BEDROCK_TOP_P = 0.9
BEDROCK_MAX_TOKENS = 150
MESSAGE_LIMIT = None

DEFAULT_ALLOWED_CASE_TYPES = ["Other"]

ALLOWED_CASE_TYPES = set(DEFAULT_ALLOWED_CASE_TYPES)


def validation_error(message, event=None, field_errors=None):
    payload = {"error": message}
    if field_errors:
        payload["field_errors"] = field_errors
    return create_response(400, payload, event)

class CustomJSONEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, uuid.UUID):
            return str(obj)
        return super().default(obj)


def get_secret(secret_name, expect_json=True):
    global db_secret
    if db_secret is None:
        try:
            response = secrets_manager_client.get_secret_value(SecretId=secret_name)["SecretString"]
            db_secret = json.loads(response) if expect_json else response
        except Exception as e:
            logger.error(f"Failed to fetch secret {secret_name}: {e}")
            raise
    return db_secret


def get_parameter(param_name, cached_var):
    if cached_var is None:
        try:
            response = ssm_client.get_parameter(Name=param_name, WithDecryption=True)
            cached_var = response["Parameter"]["Value"]
        except Exception as e:
            logger.error(f"Error fetching parameter {param_name}: {e}")
            raise
    return cached_var


def parse_case_types(raw_value):
    if not raw_value:
        return DEFAULT_ALLOWED_CASE_TYPES

    try:
        parsed = json.loads(raw_value)
        if not isinstance(parsed, list):
            return DEFAULT_ALLOWED_CASE_TYPES

        cleaned = []
        for item in parsed:
            if isinstance(item, str):
                normalized = item.strip()
                if normalized and normalized not in cleaned:
                    cleaned.append(normalized)

        return cleaned if cleaned else DEFAULT_ALLOWED_CASE_TYPES
    except Exception as error:
        logger.warning(f"Failed to parse case types configuration: {error}")
        return DEFAULT_ALLOWED_CASE_TYPES


def initialize_constants():
    global BEDROCK_LLM_ID, TABLE_NAME, BEDROCK_TEMP, BEDROCK_TOP_P, BEDROCK_MAX_TOKENS, ALLOWED_CASE_TYPES, MESSAGE_LIMIT
    BEDROCK_LLM_ID = get_parameter(BEDROCK_LLM_PARAM, BEDROCK_LLM_ID)
    TABLE_NAME = get_parameter(TABLE_NAME_PARAM, TABLE_NAME)

    MESSAGE_LIMIT = get_parameter(MESSAGE_LIMIT_PARAM, MESSAGE_LIMIT)
    if MESSAGE_LIMIT is None:
        MESSAGE_LIMIT = "Infinity"

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

    if CASE_TYPES_PARAM:
        case_types_val = get_parameter(CASE_TYPES_PARAM, None)
        ALLOWED_CASE_TYPES = set(parse_case_types(case_types_val))
    else:
        ALLOWED_CASE_TYPES = set(DEFAULT_ALLOWED_CASE_TYPES)


def initialize_case_types():
    global ALLOWED_CASE_TYPES
    if CASE_TYPES_PARAM:
        try:
            case_types_val = get_parameter(CASE_TYPES_PARAM, None)
            ALLOWED_CASE_TYPES = set(parse_case_types(case_types_val))
            return
        except Exception as error:
            logger.warning(f"Falling back to default case types: {error}")
    ALLOWED_CASE_TYPES = set(DEFAULT_ALLOWED_CASE_TYPES)


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

    secret = get_secret(DB_SECRET_NAME)
    # Require TLS and verify the server certificate and hostname against the
    # system trust store (the RDS Proxy presents an ACM-issued certificate from
    # a public Amazon CA).
    conn_str = f"host={RDS_PROXY_ENDPOINT} dbname={secret['dbname']} user={secret['username']} password={secret['password']} port={secret['port']} sslmode=verify-full sslrootcert=system"
    try:
        connection = psycopg.connect(conn_str)
        logger.info("Connected to RDS via proxy")
    except Exception as e:
        logger.error(f"Database connection error: {e}")
        connection = None
        raise
    return connection


def hash_uuid(uuid_str):
    sha = hashlib.sha256(uuid_str.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(sha).decode("utf-8")[:6]


def capitalize_title(s):
    return ' '.join(word.capitalize() for word in s.split())


def get_case_details(case_id):
    conn = connect_to_db()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT case_type, jurisdiction, case_description, statute, province FROM "cases" WHERE case_id = %s;
        """, (case_id,))
        row = cur.fetchone()
        cur.close()
        return row if row else (None, None, None, None, None)
    except Exception as e:
        logger.error(f"Error fetching case details: {e}")
        return None, None, None, None, None


def update_title(case_id, title):
    conn = connect_to_db()
    try:
        cur = conn.cursor()
        cur.execute("""
            UPDATE "cases" SET case_title = %s WHERE case_id = %s;
        """, (title, case_id))
        conn.commit()
        cur.close()
    except Exception as e:
        logger.error(f"Error updating title: {e}")
        conn.rollback()


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


def _handle_guardrail_error(resp, event=None):
    message = 'Input blocked by content guardrails.'
    for assessment in resp.get('assessments', []):
        if 'sensitiveInformationPolicy' in assessment:
            message = 'Please remove personal information from the case overview.'
            break
    return validation_error(
        message,
        event,
        field_errors={"overview": message},
    )


@metrics.log_metrics(capture_cold_start_metric=True)
@logger.inject_lambda_context(log_event=False)
def handler(event, context):
    try:
        initialize_case_types()

        # Extract idp_id from authorizer context (passed from REST API authorizer)
        # extract the database user id that was injected by the authorizer
        authorizer = event.get('requestContext', {}).get('authorizer', {})
        user_id = authorizer.get('userId')
        if not user_id:
            logger.error("Missing userId from authorizer context")
            return create_response(401, {'error': 'Unauthorized: Missing user identity'}, event)

        raw_body = event.get('body', '{}')
        try:
            body = json.loads(raw_body) if raw_body else {}
        except json.JSONDecodeError:
            return validation_error(
                'Request body must be valid JSON.',
                event,
                field_errors={"overview": 'Please check the case details you entered.'},
            )

        if not isinstance(body, dict):
            return validation_error(
                'Request body must be a JSON object.',
                event,
                field_errors={"overview": 'Please check the case details you entered.'},
            )

        case_title = body.get('case_title')
        case_type = body.get('case_type')
        jurisdiction = body.get('jurisdiction')
        case_desc = body.get('case_description')
        province = body.get('province')
        statute = body.get('statute')

        field_errors = {}

        if not case_type:
            field_errors['broadLaw'] = 'Please select a Broad Area of Law.'
        elif case_type not in ALLOWED_CASE_TYPES:
            field_errors['broadLaw'] = 'Please select a valid broad area of law.'

        if not case_desc or not str(case_desc).strip():
            field_errors['overview'] = 'Please provide a case overview.'

        if isinstance(jurisdiction, list) and 'Provincial' in jurisdiction and not province:
            field_errors['province'] = 'Please select a Province/Territory.'

        if field_errors:
            return validation_error(
                'Please review the highlighted fields and try again.',
                event,
                field_errors=field_errors,
            )

        # Require the user to have accepted the legal/AI-use waiver before any
        # AI feature runs. Fails closed if the acceptance state cannot be read.
        try:
            conn = connect_to_db()
            if not is_disclaimer_accepted(conn, user_id):
                return create_response(403, {'error': 'You must accept the disclaimer before using the AI assistant.', 'code': 'DISCLAIMER_NOT_ACCEPTED'}, event)
        except Exception as e:
            logger.error(f"Error checking disclaimer acceptance: {e}")
            return create_response(503, {'error': 'Service temporarily unavailable. Please try again later.'}, event)

        # Enforce the daily message limit before invoking Bedrock. Counts as one
        # message per request and fails closed if the usage check cannot complete.
        initialize_constants()
        if MESSAGE_LIMIT != "Infinity":
            try:
                limit = int(MESSAGE_LIMIT)
                conn = connect_to_db()
                current_usage = check_and_increment_usage(conn, user_id)
                logger.info(f"User {user_id} usage: {current_usage}/{limit}")
                if current_usage > limit:
                    return create_response(429, {'error': 'Daily message limit reached. Please contact your administrator.'}, event)
            except Exception as e:
                logger.error(f"Error checking message limit: {e}")
                return create_response(503, {'error': 'Service temporarily unavailable. Please try again later.'}, event)

        combined = f"{case_title} {case_type} {jurisdiction} {case_desc}"
        
        # Use guardrail from CDK environment variables
        guardrail_id = GUARDRAIL_ID
        guardrail_version = GUARDRAIL_VERSION
        logger.info(f"Using guardrail ID: {guardrail_id}, version: {guardrail_version}")
        
        guard_resp = bedrock_runtime.apply_guardrail(
            guardrailIdentifier=guardrail_id,
            guardrailVersion=guardrail_version,
            source='INPUT',
            content=[{'text': {'text': combined, 'qualifiers': ['guard_content']}}]
        )
        if guard_resp.get('action') == 'GUARDRAIL_INTERVENED':
            return _handle_guardrail_error(guard_resp, event)

        # user_id is already supplied by the authorizer so we can skip any
        # database lookup entirely.
        conn = connect_to_db()
        cur = conn.cursor()
        logger.debug(f"Using user_id from context: {user_id}")

        cur.execute('''INSERT INTO "cases"(student_id, case_title, case_type, jurisdiction, case_description, province, statute, status, completed_blocks, last_updated)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,'in_progress',ARRAY[]::block_type[],CURRENT_TIMESTAMP) RETURNING case_id''',
                    (user_id, case_title, case_type, jurisdiction, case_desc, province, statute))
        case_id = cur.fetchone()[0]

        case_hash = hash_uuid(str(case_id))
        cur.execute('UPDATE "cases" SET case_hash=%s WHERE case_id=%s', (case_hash, case_id))
        conn.commit()
        cur.close()

        try:
            case_title = handle_generate_title(case_id, case_type, jurisdiction, case_desc, province)
            return create_response(200, json.dumps({'case_id': str(case_id), 'case_hash': case_hash, 'case_title': capitalize_title(case_title)}, cls=CustomJSONEncoder), event)
        except Exception as e:
            logger.warning(f"Title generation failed: {e}", exc_info=True)
            return create_response(200, json.dumps({
                'case_id': str(case_id),
                'case_hash': case_hash,
                'warning': 'Case created but title generation failed.'
            }, cls=CustomJSONEncoder), event)

    except Exception as err:
        logger.error(f"Error in new_case: {err}", exc_info=True)
        # Rollback transaction on error
        try:
            conn = connect_to_db()
            conn.rollback()
        except Exception:
            # Best-effort rollback in error path; handler already returns 500 to client.
            pass
        return create_response(500, {'error': 'Internal server error'}, event)


def handle_generate_title(case_id: str, case_type: str, jurisdiction: str, case_description: str, province: str) -> str:
    initialize_constants()

    try:
        logger.info(f"Creating Bedrock LLM with ID: {BEDROCK_LLM_ID}, Temp: {BEDROCK_TEMP}, TopP: {BEDROCK_TOP_P}, MaxTokens: {BEDROCK_MAX_TOKENS}")
        llm = get_bedrock_llm(
            bedrock_llm_id=BEDROCK_LLM_ID,
            temperature=BEDROCK_TEMP,
            top_p=BEDROCK_TOP_P,
            max_tokens=BEDROCK_MAX_TOKENS
        )
        response = generate_case_title(
            case_type=case_type,
            llm=llm,
            jurisdiction=jurisdiction,
            case_description=case_description,
            province=province
        )
        update_title(case_id, capitalize_title(response))
        return response
    except Exception as e:
        logger.error(f"Error generating or updating title: {e}", exc_info=True)
        raise RuntimeError("LLM processing or DB update failed")
