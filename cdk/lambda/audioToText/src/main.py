import os
import json
import re
import time
import random
import logging
import boto3
import psycopg
import urllib.request

# Canonical UUID format for the audio file identifier
UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
# Maximum accepted length for the client-supplied file name component
MAX_FILE_NAME_LENGTH = 200

# Set up logging for the Lambda function
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize AWS service clients using environment configuration
transcribe = boto3.client("transcribe", region_name=os.environ.get("AWS_REGION"))
s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION"))

# Environment variables (must be set in Lambda configuration)
DB_SECRET_NAME = os.environ["SM_DB_CREDENTIALS"]    # Secrets Manager secret for RDS credentials
REGION = os.environ["REGION"]                     # AWS region for SSM and other services
RDS_PROXY_ENDPOINT = os.environ["RDS_PROXY_ENDPOINT"]  # RDS Proxy endpoint
AUDIO_BUCKET = os.environ.get("AUDIO_BUCKET")         # S3 bucket where audio files are stored
FILE_SIZE_LIMIT_PARAM = os.environ.get("FILE_SIZE_LIMIT_PARAM") # SSM parameter for file size limit

# AWS clients for Secrets Manager and Parameter Store
secrets_manager_client = boto3.client("secretsmanager")
ssm_client = boto3.client("ssm", region_name=REGION)
eventbridge_client = boto3.client("events", region_name=REGION)

# Cached database connection and secret to reuse across Lambda invocations
connection = None
db_secret = None


def send_to_websocket(connection_id, endpoint, request_id, msg_type, content=None, data=None):
    """Send a message to a WebSocket connection with request correlation."""
    client = boto3.client('apigatewaymanagementapi', endpoint_url=endpoint)
    message = {
        "requestId": request_id,
        "action": "audio_to_text",
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


def _error_response(status_code, message, is_websocket=False, connection_id=None, ws_endpoint=None, request_id=None, event=None):
    """Helper for generating error responses for both HTTP and WebSocket modes."""
    if is_websocket and connection_id:
        send_to_websocket(connection_id, ws_endpoint, request_id, "error", content=message)
        return {"statusCode": status_code}
    return create_response(status_code, {"error": message}, event)


def get_secret(secret_name, expect_json=True):
    """
    Retrieve a secret from AWS Secrets Manager, parse JSON if requested, and cache the result.
    """
    global db_secret
    if db_secret is None:
        try:
            raw = secrets_manager_client.get_secret_value(SecretId=secret_name)["SecretString"]
            db_secret = json.loads(raw) if expect_json else raw
        except json.JSONDecodeError as e:
            # amazonq-ignore-next-line
            msg = f"DB Secret is not valid JSON: {e}"
            # amazonq-ignore-next-line
            logger.error(msg)
            raise ValueError(msg)
        except Exception as e:
            # amazonq-ignore-next-line
            logger.error(f"Error fetching DBsecret: {e}")
            raise
    return db_secret


def get_parameter(param_name, cached_var):
    """
    Retrieve a parameter from AWS Systems Manager Parameter Store and cache the result.
    """
    if cached_var is None:
        try:
            resp = ssm_client.get_parameter(Name=param_name, WithDecryption=True)
            cached_var = resp["Parameter"]["Value"]
        except Exception as e:
            logger.error(f"Error fetching parameter {param_name}: {e}")
            raise
    return cached_var


def connect_to_db():
    """
    Establish (or reuse) a connection to the RDS database via the Proxy.
    Uses credentials stored in Secrets Manager.
    """
    global connection
    if connection is None or connection.closed:
        secret = get_secret(DB_SECRET_NAME)
        params = {
            'dbname': secret['dbname'],
            'user': secret['username'],
            'password': secret['password'],
            'host': RDS_PROXY_ENDPOINT,
            'port': secret['port'],
            # Require TLS and verify the server certificate and hostname against
            # the system trust store (the RDS Proxy presents an ACM-issued
            # certificate from a public Amazon CA).
            'sslmode': 'verify-full',
            'sslrootcert': 'system'
        }
        # Build connection string for psycopg2
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


def check_authorization(user_id, audio_file_id):
    """
    Verify that the requesting user owns the case associated with the given
    audio file. Resolves audio_file_id -> case -> owning student and compares
    against the trusted user id from the authorizer context.

    Args:
        user_id: Database user ID from authorizer context
        audio_file_id: Audio file ID from the request

    Returns:
        bool: True if the user owns the case, False otherwise
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
            is_authorized = cursor.fetchone() is not None

            if is_authorized:
                logger.info(f"Authorization successful: User {user_id} authorized for audio file {audio_file_id}")
            else:
                logger.warning(f"Authorization failed: User {user_id} attempted unauthorized access to audio file {audio_file_id}")

            return is_authorized

    except Exception as e:
        logger.error(f"Authorization check failed with error: {e}")
        reset_connection()
        return False


def validate_file_integrity(bucket, key, file_type):
    """
    Validates file size and magic numbers to ensure file integrity.
    Uses structured byte signature checks for supported audio formats.
    """
    try:
        # 1. Validate File Size
        file_size_limit_str = get_parameter(FILE_SIZE_LIMIT_PARAM, None)
        max_size_mb = int(file_size_limit_str) if file_size_limit_str else 500
        max_size_bytes = max_size_mb * 1024 * 1024
        
        head = s3.head_object(Bucket=bucket, Key=key)
        actual_size = head['ContentLength']
        
        if actual_size > max_size_bytes:
             raise ValueError(f"File size ({actual_size / (1024*1024):.2f} MB) exceeds limit of {max_size_mb} MB")
        
        # 2. Validate File Signature (Magic Numbers)
        # Read the first 32 bytes to identify the file format
        response = s3.get_object(Bucket=bucket, Key=key, Range='bytes=0-31')
        header = response['Body'].read()
        
        # Define signatures for supported formats
        # MP3: Can start with ID3 tag or sync frame (0xFF + bits)
        if file_type == 'mp3':
            is_valid = (
                header.startswith(b'ID3') or 
                header.startswith(b'\xFF\xFB') or 
                (len(header) > 1 and header[0] == 0xFF and (header[1] & 0xE0 == 0xE0))
            )
        # WAV: Standard RIFF container with WAVE format
        elif file_type == 'wav':
            is_valid = header.startswith(b'RIFF') and b'WAVE' in header
        
        # M4A: ISO Base Media File Format (QuickTime container)
        elif file_type == 'm4a':
             # Look for specific brand identifiers in the ftyp box
             is_valid = any(brand in header for brand in [b'ftypM4A', b'ftypmp42', b'ftypisom', b'ftypM4B'])
        else:
            is_valid = False
        
        if not is_valid:
             raise ValueError(f"Invalid file signature for type {file_type}. Supported types: mp3, wav, m4a")
             
    except Exception as e:
        logger.error(f"Integrity validation failed for {key}: {e}")
        # Clean up invalid/malicious files immediately
        try:
            s3.delete_object(Bucket=bucket, Key=key)
            logger.info(f"Deleted invalid file from S3: {key}")
        except Exception as del_e:
            logger.error(f"Failed to delete invalid file {key}: {del_e}")
        raise ValueError(f"File integrity check failed: {str(e)}")



def format_diarized_transcript(data):
    speaker_segments = data["results"]["speaker_labels"]["segments"]
    items = data["results"]["items"]

    # Map each speaker_label (e.g., spk_0) to Speaker 1, Speaker 2, etc.
    speaker_map = {}
    speaker_counter = 1
    for segment in speaker_segments:
        label = segment["speaker_label"]
        if label not in speaker_map:
            speaker_map[label] = f"Speaker {speaker_counter}"
            speaker_counter += 1

    output = []
    segment_index = 0
    segment = speaker_segments[segment_index]
    speaker = segment["speaker_label"]
    current_line = f"**{speaker_map[speaker]}:** "

    for item in items:
        if item["type"] == "punctuation":
            current_line = current_line.rstrip() + item["alternatives"][0]["content"] + " "
        else:
            while (segment_index + 1 < len(speaker_segments) and
                   float(item["start_time"]) >= float(speaker_segments[segment_index + 1]["start_time"])):
                output.append(current_line.strip())
                segment_index += 1
                segment = speaker_segments[segment_index]
                speaker = segment["speaker_label"]
                current_line = f"**{speaker_map[speaker]}:** "

            current_line += item["alternatives"][0]["content"] + " "

    output.append(current_line.strip())
    return "\n\n".join(output)

def add_audio_to_db(audio_file_id, audio_text):
    conn = connect_to_db()
    try:
        cur = conn.cursor()
        sql = 'UPDATE "audio_files" SET audio_text = %s WHERE audio_file_id = %s;'
        cur.execute(sql, (audio_text, audio_file_id))
        conn.commit()
        # amazonq-ignore-next-line
        cur.close()
        # amazonq-ignore-next-line
        logger.info(f"Audio text stored for audio_file_id: {audio_file_id}")
        # amazonq-ignore-next-line
        return {"statusCode": 200, "body": json.dumps({"message": "Stored successfully"})}
    except Exception as e:
        # amazonq-ignore-next-line
        logger.error(f"DB update error for audio_file_id {audio_file_id}: {e}")
        if cur:
            cur.close()
        conn.rollback()
        return {"statusCode": 500, "body": json.dumps({"error": "DB update failed"})}



def get_cors_origin(event):
    """
    Resolve the CORS origin based on the ALLOWED_ORIGIN env var.
    Mirrors the Node.js getOriginHeader() in cdk/lambda/handlers/utils/utils.js.

    Returns:
        str: The value for the Access-Control-Allow-Origin response header.
    """
    allowed_origin = os.environ.get("ALLOWED_ORIGIN", "")
    if not allowed_origin:
        return "*"

    return allowed_origin


def create_response(status_code, body, event=None):
    """
    Build a properly-formatted API Gateway response dict with dynamic CORS
    headers.  Replaces all hardcoded CORS header dictionaries.

    Args:
        status_code (int): HTTP status code.
        body: Response body — will be JSON-serialised if not already a string.
        event (dict | None): The Lambda event, used for origin resolution.
                             Pass None for non-HTTP contexts (falls back to
                             ALLOWED_ORIGIN or "*").

    Returns:
        dict: API Gateway-compatible response.
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

def customize_pii_markers(transcript_text):
    """
    Convert PII markers to custom format
    e.g., [PII.NAME] -> [NAME], [PII.EMAIL] -> [EMAIL]
    """
    pii_replacements = {
        '[PII.NAME]': '[NAME]',
        '[PII.EMAIL]': '[EMAIL]',
        '[PII.PHONE]': '[PHONE]',
        '[PII.SSN]': '[SSN]',
        '[PII.CREDIT_DEBIT_NUMBER]': '[CREDIT_CARD]',
        '[PII.BANK_ACCOUNT_NUMBER]': '[BANK_ACCOUNT]',
        '[PII.ADDRESS]': '[ADDRESS]'
    }
    
    for pii_marker, custom_marker in pii_replacements.items():
        transcript_text = transcript_text.replace(pii_marker, custom_marker)
    
    return transcript_text

def publish_transcription_notification_event(audio_file_id, user_id, file_name, case_name, case_id, success=True, error_message=None):
    """
    Publish notification event to EventBridge for transcription completion
    
    Args:
        audio_file_id: UUID of the audio file
        user_id: Database user_id (UUID) - recipient of the notification
        file_name: Name of the audio file
        case_name: Name of the case
        case_id: UUID of the case
        success: Whether transcription succeeded
        error_message: Error message if transcription failed
    """
    try:
        event_bus_name = os.environ.get("NOTIFICATION_EVENT_BUS_NAME")
        if not event_bus_name:
            logger.warning("NOTIFICATION_EVENT_BUS_NAME not configured, skipping notification")
            return

        file_display_name = file_name or "Audio File"
        case_display_name = case_name or "Unknown Case"

        # Determine notification details based on success/failure
        if success:
            title = "Transcription Complete"
            message = f"Transcription complete for {file_display_name} in {case_display_name}"
            notification_type = "transcript_complete"
        else:
            title = "Transcription Failed"
            message = f"Transcription failed for {file_display_name}: {error_message or 'Unknown error'}"
            notification_type = "transcript_complete"

        event_detail = {
            "type": notification_type,
            "recipientId": user_id,  # Database user_id (already translated at boundary)
            "title": title,
            "message": message,
            "metadata": {
                "transcriptId": audio_file_id,
                "audioFileId": audio_file_id,
                "caseId": case_id,
                "caseName": case_display_name,
                "fileName": file_display_name,
                "status": "success" if success else "failed",
                **({"errorMessage": error_message} if error_message else {})
            }
        }

        response = eventbridge_client.put_events(
            Entries=[
                {
                    "Source": "notification.system",
                    "DetailType": "Transcription Complete",
                    "Detail": json.dumps(event_detail),
                    "EventBusName": event_bus_name
                }
            ]
        )

        logger.info(f"Published transcription notification event: {response}")
        
    except Exception as e:
        logger.error(f"Error publishing transcription notification event: {e}")
        # Don't fail the main operation if notification fails

def handler(event, context):
    """
    AWS Lambda handler for audio transcription.
    
    Supports two invocation modes:
    
    1. HTTP (API Gateway REST - legacy fallback):
       - Receives parameters via queryStringParameters
       - Returns response in HTTP body
    
    2. WebSocket (API Gateway WebSocket - primary):
       - Receives parameters via event body (from default.js router)
       - Posts status updates back to WebSocket connection
    
    Expected event structure (WebSocket):
    {
        "isWebSocket": true,
        "cognitoId": "user-cognito-id",
        "requestId": "unique-request-id",
        "body": "{\"audio_file_id\": \"...\", \"file_name\": \"...\", ...}",
        "requestContext": { "connectionId": "...", "domainName": "...", "stage": "..." }
    }
    """
    # 1. Handle CORS preflight (HTTP only)
    if event.get("httpMethod") == "OPTIONS":
        return create_response(200, "", event)

    # Detect invocation mode
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
        send_to_websocket(connection_id, ws_endpoint, request_id, "start", content="Transcription started")

    try:
        # 2. Extract parameters based on invocation mode
        if is_websocket:
            # WebSocket: parameters come from the event body (set by default.js)
            body = json.loads(event.get("body", "{}"))
            file_name = body.get("file_name")
            audio_file_id = body.get("audio_file_id")
            file_type = body.get("file_type", "mp3").lower()
            case_title = body.get("case_title")
            case_id = body.get("case_id")
            user_id = event.get("userId")  # Database user_id from default.js (already translated at boundary)
        else:
            # HTTP: parameters come from query string
            qs = event.get("queryStringParameters") or {}
            file_name = qs.get("file_name")
            audio_file_id = qs.get("audio_file_id")
            file_type = qs.get("file_type", "mp3").lower()
            case_title = qs.get("case_title")
            case_id = qs.get("case_id")
            user_id = request_context.get("authorizer", {}).get("principalId")
            if not user_id:
                logger.warning("No user_id available for notification")

        # Validate required parameters
        if not file_name or not audio_file_id:
            missing = []
            if not file_name:
                missing.append("file_name")
            if not audio_file_id:
                missing.append("audio_file_id")
            logger.error(f"Missing params: {missing}")
            if user_id:
                publish_transcription_notification_event(audio_file_id, user_id, file_name, case_title, case_id, success=False, error_message=f"Missing parameters: {missing}")
            return _error_response(400, f"Missing parameters: {missing}", is_websocket, connection_id, ws_endpoint, request_id, event=event)

        # Constrain identifiers so the object key stays within the audio file's
        # own prefix and the lookup receives a well-formed identifier.
        if not is_valid_audio_file_id(audio_file_id) or not is_valid_file_name(file_name):
            logger.error(f"Invalid identifiers for audio file request: audio_file_id={audio_file_id}")
            return _error_response(400, "Invalid parameters", is_websocket, connection_id, ws_endpoint, request_id, event=event)

        # 2a. Verify the caller owns the case this audio file belongs to
        if not check_authorization(user_id, audio_file_id):
            logger.error(f"Access denied for user {user_id} on audio file {audio_file_id}")
            return _error_response(403, "Access denied", is_websocket, connection_id, ws_endpoint, request_id, event=event)

        # 2b. Validate physical file integrity (Server-side validation)
        object_key = f"{audio_file_id}/{file_name}.{file_type}"
        validate_file_integrity(AUDIO_BUCKET, object_key, file_type)

        # Construct S3 file URI
        media_file_uri = f"s3://{AUDIO_BUCKET}/{object_key}"
        logger.info(f"Starting transcription for: {media_file_uri}")

        # 3. Start Transcription job
        job_name = f"transcription-{audio_file_id}-{int(time.time())}-{random.randint(1000, 9999)}"
        transcribe.start_transcription_job(
            TranscriptionJobName=job_name,
            Media={"MediaFileUri": media_file_uri},
            MediaFormat=file_type,
            LanguageCode="en-US",
            Settings={
                'ShowSpeakerLabels': True,
                'MaxSpeakerLabels': 2,
                'ShowAlternatives': False,
            },
            ContentRedaction={
                'RedactionType': 'PII',
                'RedactionOutput': 'redacted_and_unredacted',
                'PiiEntityTypes': [
                    'NAME', 'EMAIL', 'PHONE', 'SSN', 
                    'CREDIT_DEBIT_NUMBER', 'BANK_ACCOUNT_NUMBER', 
                    'ADDRESS'
                ]
            }
        )

        if is_websocket and connection_id:
            send_to_websocket(connection_id, ws_endpoint, request_id, "chunk", content="Transcription job submitted, waiting for completion...")

        # Poll for job completion
        transcript_uri = None
        while True:
            resp = transcribe.get_transcription_job(TranscriptionJobName=job_name)
            status = resp["TranscriptionJob"]["TranscriptionJobStatus"]
            if status == "COMPLETED":
                transcript_uri = resp["TranscriptionJob"]["Transcript"]["RedactedTranscriptFileUri"]
                break
            if status == "FAILED":
                raise Exception("Transcription job failed")
            time.sleep(5)

        if is_websocket and connection_id:
            send_to_websocket(connection_id, ws_endpoint, request_id, "chunk", content="Transcription complete, processing results...")

        # 4. Download and parse transcript
        with urllib.request.urlopen(transcript_uri) as r:
            data = json.loads(r.read().decode())

        # Use basic formatting since speaker labels aren't supported with redaction
        transcript_text = format_diarized_transcript(data)

        # Apply custom PII markers
        formatted_transcript = customize_pii_markers(transcript_text)
        
        # 5. Store transcript and notify clients
        add_audio_to_db(audio_file_id, formatted_transcript)

        # amazonq-ignore-next-line
        logger.info(f"About to send completion notification for audio_file_id={audio_file_id}")

        # Publish success notification via EventBridge (bell/toast notification system)
        if user_id:
            publish_transcription_notification_event(audio_file_id, user_id, file_name, case_title, case_id, success=True)

        # 6. Delete the audio file from S3
        try:
            s3.delete_object(
                Bucket=AUDIO_BUCKET,
                Key=f"{audio_file_id}/{file_name}.{file_type}"
            )
            # amazonq-ignore-next-line
            logger.info(f"Deleted file {audio_file_id}/{file_name}.{file_type} from S3")
        except Exception as e:
            logger.error(f"Failed to delete audio file from S3: {e}")

        # 7. Return response based on invocation mode
        if is_websocket and connection_id:
            send_to_websocket(connection_id, ws_endpoint, request_id, "complete", data={
                "text": formatted_transcript,
                "audioFileId": audio_file_id,
                "jobName": job_name
            })
            return {"statusCode": 200}

        return create_response(200, {"text": formatted_transcript, "audioFileId": audio_file_id, "jobName": job_name}, event)

    except Exception as e:
        logger.error("Handler error: %s", e, exc_info=True)
        # Publish failure notification event if user_id is available
        if is_websocket:
            user_id_for_notif = event.get("userId")
        else:
            user_id_for_notif = event.get("requestContext", {}).get("authorizer", {}).get("principalId")
        
        if user_id_for_notif:
            if is_websocket:
                body = json.loads(event.get("body", "{}"))
                afid = body.get("audio_file_id", "unknown")
            else:
                qs = event.get("queryStringParameters") or {}
                afid = qs.get("audio_file_id", "unknown")
            publish_transcription_notification_event(afid, user_id_for_notif, file_name=None, case_name=None, case_id=None, success=False, error_message="Internal server error")

        return _error_response(500, "Internal server error", is_websocket, connection_id, ws_endpoint, request_id, event=event)
