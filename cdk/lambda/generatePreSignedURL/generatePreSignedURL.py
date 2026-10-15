import os, json, re
import boto3
import psycopg
from botocore.config import Config
from aws_lambda_powertools import Logger

# Canonical UUID format for the audio file identifier
UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
# Maximum accepted length for the client-supplied file name component
MAX_FILE_NAME_LENGTH = 200

BUCKET = os.environ["BUCKET"]
REGION = os.environ["REGION"]
DB_SECRET_NAME = os.environ["SM_DB_CREDENTIALS"]      # Secrets Manager secret for RDS credentials
RDS_PROXY_ENDPOINT = os.environ["RDS_PROXY_ENDPOINT"]  # RDS Proxy endpoint

s3 = boto3.client(
    "s3",
    endpoint_url=f"https://s3.{REGION}.amazonaws.com",
    config=Config(
        s3={"addressing_style": "virtual"}, region_name=REGION, signature_version="s3v4"
    ),
)

secrets_manager_client = boto3.client("secretsmanager")

logger = Logger()

# Cached database connection and secret to reuse across Lambda invocations
connection = None
db_secret = None


def get_secret(secret_name, expect_json=True):
    """Retrieve a secret from AWS Secrets Manager, parse JSON if requested, and cache the result."""
    global db_secret
    if db_secret is None:
        raw = secrets_manager_client.get_secret_value(SecretId=secret_name)["SecretString"]
        db_secret = json.loads(raw) if expect_json else raw
    return db_secret


def reset_connection():
    """
    Recover the cached connection after a failed statement. Rolls back any
    aborted transaction so the warm connection stays reusable; if rollback
    itself fails, the connection is dropped so the next call reconnects.
    """
    global connection
    if connection is None:
        return
    try:
        connection.rollback()
    except Exception:
        try:
            connection.close()
        except Exception:
            pass
        connection = None


def is_valid_audio_file_id(audio_file_id):
    """Return True when the identifier matches the canonical UUID format."""
    return bool(audio_file_id) and bool(UUID_RE.match(audio_file_id))


def is_valid_file_name(file_name):
    """
    Return True when the file name is a safe single path component: no path
    separators, no control characters, within length. Blocking separators
    confines the key to the audio file's own prefix.
    """
    if not file_name or len(file_name) > MAX_FILE_NAME_LENGTH:
        return False
    if "/" in file_name or "\\" in file_name:
        return False
    if any(ord(c) < 32 for c in file_name):
        return False
    return True


def connect_to_db():
    """Establish (or reuse) a connection to the RDS database via the Proxy."""
    global connection
    if connection is None or connection.closed:
        secret = get_secret(DB_SECRET_NAME)
        params = {
            "dbname": secret["dbname"],
            "user": secret["username"],
            "password": secret["password"],
            "host": RDS_PROXY_ENDPOINT,
            "port": secret["port"],
            # Require TLS and verify the server certificate and hostname. The RDS
            # Proxy presents a certificate from the public Amazon CA chain; point
            # sslrootcert at the OS CA bundle (which contains the Amazon roots)
            # rather than "system", which the psycopg binary wheel's bundled
            # OpenSSL does not resolve to the container's trust store.
            "sslmode": "verify-full",
            "sslrootcert": "/etc/pki/tls/certs/ca-bundle.crt",
        }
        conn_str = " ".join(f"{k}={v}" for k, v in params.items())
        try:
            connection = psycopg.connect(conn_str)
            logger.info("Connected to the database.")
        except Exception as e:
            logger.error(f"Database connection failed: {e}")
            if connection:
                connection.rollback()
                connection.close()
            raise
    return connection


def check_authorization(user_id, audio_file_id):
    """
    Verify that the requesting user owns the case associated with the given
    audio file. Resolves audio_file_id -> case -> owning student and compares
    against the trusted user id from the authorizer context.
    """
    if not user_id or not audio_file_id:
        logger.warning("Authorization failed: Missing user_id or audio_file_id")
        return False

    try:
        conn = connect_to_db()
        with conn.cursor() as cursor:
            query = """
                SELECT 1
                FROM "audio_files" af
                JOIN "cases" c ON af.case_id = c.case_id
                WHERE af.audio_file_id = %s
                  AND c.student_id = %s;
            """
            cursor.execute(query, (audio_file_id, user_id))
            return cursor.fetchone() is not None
    except Exception as e:
        logger.error(f"Authorization check failed with error: {e}")
        reset_connection()
        return False


def s3_key_exists(bucket, key):
    try:
        s3.head_object(Bucket=bucket, Key=key)
        return True
    except Exception:
        return False


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


@logger.inject_lambda_context(log_event=False)
def lambda_handler(event, context):
    # Use .get() to safely extract query string parameters
    query_params = event.get("queryStringParameters", {})

    if not query_params:
        return create_response(400, "Missing queries to generate pre-signed URL", event)

    audio_file_id = query_params.get("audio_file_id", "")
    file_type = query_params.get("file_type", "").lower()
    file_name = query_params.get("file_name", "")

    if not audio_file_id:
        return create_response(400, "Missing required parameter: audio_file_id", event)

    if not file_name:
        return create_response(400, "Missing required parameter: file_name", event)

    # Constrain identifiers so the signed key stays within the audio file's
    # own prefix and the lookup receives a well-formed identifier.
    if not is_valid_audio_file_id(audio_file_id):
        return create_response(400, "Invalid audio_file_id", event)

    if not is_valid_file_name(file_name):
        return create_response(400, "Invalid file_name", event)

    # Resolve the trusted caller identity from the authorizer context
    user_id = event.get("requestContext", {}).get("authorizer", {}).get("principalId")

    # Only issue a capability when the caller owns the case this audio file belongs to
    if not check_authorization(user_id, audio_file_id):
        return create_response(403, "Access denied", event)

    # Allowed audio file types for Amazon Transcribe with their corresponding MIME types
    allowed_audio_types = {
        "mp3": "audio/mpeg",
        "mp4": "audio/mp4",
        "wav": "audio/wav",
        "flac": "audio/flac",
        "amr": "audio/amr",
        "ogg": "audio/ogg",
        "webm": "audio/webm",
        "m4a": "audio/m4a"
    }

    if file_type not in allowed_audio_types:
        return create_response(
            400,
            f'Unsupported audio file type. Allowed types: {", ".join(allowed_audio_types.keys())}',
            event,
        )

    # Modified key path to remove the "audio" subdirectory
    key = f"{audio_file_id}/{file_name}.{file_type}"
    content_type = allowed_audio_types[file_type]

    try:
        presigned_url = s3.generate_presigned_url(
            ClientMethod="put_object",
            Params={
                "Bucket": BUCKET,
                "Key": key,
                "ContentType": content_type,
            },
            ExpiresIn=120,
            HttpMethod="PUT",
        )

        return create_response(200, {"presignedurl": presigned_url}, event)

    except Exception as e:
        logger.error(f"Error generating presigned URL: {e}")
        return create_response(500, "Internal server error", event)