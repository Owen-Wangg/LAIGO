import os
import json
import boto3
import re
import logging

from botocore.exceptions import ClientError
from botocore.config import Config

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Inline Bedrock client (bedrock_client layer not available for this function)
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

# AWS Clients
dynamodb = boto3.client('dynamodb')
_REGION = os.environ.get("REGION")
bedrock_runtime = _get_bedrock_runtime_client(region_name=_REGION)

try:
    from bedrock_client.sanitizer import sanitize_prompt_input
except ImportError:
    def sanitize_prompt_input(user_input: str) -> tuple[str, bool]:
        """Minimal inline sanitizer fallback."""
        if not user_input:
            return ("", False)
        sanitized = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u200b-\u200f\u2028-\u2029\u202a-\u202e\u2060-\u2064\ufeff\ufff9-\ufffb]", "", user_input)
        injection_patterns = [
            r"(?i)\b(ignore|disregard|forget)\b.{0,30}\b(previous|above|prior|all)\b.{0,30}\b(instructions?|prompts?|rules?|context)\b",
            r"(?i)\b(you are now|act as|pretend to be|assume the role|switch to|new role)\b",
            r"(?i)\b(reveal|show|print|output|repeat|display)\b.{0,20}\b(system prompt|instructions|hidden|secret|internal)\b",
            r"(?i)(```\s*(system|assistant|end|human)|<\/?system>|<\/?prompt>|\[INST\]|\[\/INST\]|<<SYS>>|<\/SYS>>)",
            r"(?i)^\s*(system|assistant)\s*:",
            r"(?i)\b(DAN|do anything now|jailbreak|bypass|override safety|ignore safety)\b",
        ]
        for pat in injection_patterns:
            if re.search(pat, sanitized):
                logger.warning("Prompt injection pattern detected in user input (first 100 chars): %.100s", sanitized)
                return (sanitized, True)
        return (sanitized, False)


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


def _build_invoke_request(llm: dict, system_prompt: str, user_prompt: str) -> dict:
    model_id = llm["model_id"]

    if _is_anthropic_model(model_id):
        body = {
            "anthropic_version": "bedrock-2023-05-31",
            "system": system_prompt,
            "messages": [
                {
                    "role": "user",
                    "content": [{"type": "text", "text": user_prompt}],
                }
            ],
            "max_tokens": llm["max_tokens"],
        }
        _apply_sampling_params(body, model_id, llm["temperature"], llm["top_p"])
        return body

    if _is_meta_model(model_id):
        # Llama 3 requires special chat template tokens for instruction following
        formatted_prompt = (
            f"<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n"
            f"{system_prompt}<|eot_id|>"
            f"<|start_header_id|>user<|end_header_id|>\n\n"
            f"{user_prompt}<|eot_id|>"
            f"<|start_header_id|>assistant<|end_header_id|>\n\n"
        )
        return {
            "prompt": formatted_prompt,
            "max_gen_len": llm["max_tokens"],
            "temperature": llm["temperature"],
            "top_p": llm["top_p"],
        }

    raise ValueError(f"Unsupported Bedrock model for InvokeModel: {model_id}")


def _extract_response_text(model_id: str, response_payload: dict) -> str:
    if _is_anthropic_model(model_id):
        content_blocks = response_payload.get("content", [])
        return "".join(block.get("text", "") for block in content_blocks if block.get("type") == "text")

    if _is_meta_model(model_id):
        return (
            response_payload.get("generation")
            or response_payload.get("output_text")
            or response_payload.get("outputText")
            or ""
        )

    return response_payload.get("outputText") or response_payload.get("generation") or ""


def _invoke_model_text(llm: dict, system_prompt: str, user_prompt: str) -> str:
    request_body = _build_invoke_request(llm, system_prompt, user_prompt)
    logger.info(f"Invoking model (non-streaming): {llm['model_id']}, prompt length: {len(user_prompt)}")
    response = bedrock_runtime.invoke_model(
        modelId=llm["model_id"],
        contentType="application/json",
        accept="application/json",
        body=json.dumps(request_body),
    )
    payload = json.loads(response["body"].read())
    result = _extract_response_text(llm["model_id"], payload)
    logger.info("Model response received", extra={"responseLength": len(result)})
    if not result:
        logger.warning(f"Empty model response. Payload keys: {list(payload.keys())}, payload preview: {json.dumps(payload)[:500]}")
    return result


def _stream_invoke_model_text(llm: dict, system_prompt: str, user_prompt: str, send_chunk_callback=None) -> str:
    request_body = _build_invoke_request(llm, system_prompt, user_prompt)
    stream = bedrock_runtime.invoke_model_with_response_stream(
        modelId=llm["model_id"],
        contentType="application/json",
        accept="application/json",
        body=json.dumps(request_body),
    )

    full_response = ""
    for event in stream.get("body", []):
        chunk = event.get("chunk")
        if not chunk:
            for error_key in (
                "internalServerException",
                "modelStreamErrorException",
                "validationException",
                "throttlingException",
                "modelTimeoutException",
                "serviceUnavailableException",
            ):
                if error_key in event:
                    error_detail = event[error_key]
                    message = error_detail.get("message") if isinstance(error_detail, dict) else str(error_detail)
                    raise RuntimeError(f"Bedrock stream error ({error_key}): {message}")
            continue

        try:
            event_payload = json.loads(chunk["bytes"].decode("utf-8"))
        except Exception as parse_error:
            logger.warning(f"Failed to parse Bedrock stream chunk: {parse_error}")
            continue

        chunk_text = ""
        if _is_anthropic_model(llm["model_id"]):
            event_type = event_payload.get("type")
            if event_type == "content_block_delta":
                chunk_text = event_payload.get("delta", {}).get("text", "")
        elif _is_meta_model(llm["model_id"]):
            chunk_text = (
                event_payload.get("generation")
                or event_payload.get("output_text")
                or event_payload.get("outputText")
                or ""
            )

        if chunk_text:
            full_response += chunk_text
            if send_chunk_callback:
                send_chunk_callback(chunk_text)

    return full_response

def get_bedrock_llm(
    bedrock_llm_id: str,
    temperature: float = 0.3,
    max_tokens: int = 2048,
    top_p: float = 0.9,
) -> dict:
    """
    Build a Bedrock InvokeModel configuration with specified parameters.
    
    Args:
        bedrock_llm_id (str): The model ID for the Bedrock LLM.
        temperature (float): Controls the randomness of the output.
        max_tokens (int, optional): The maximum number of tokens to generate. Defaults to 2048.
        top_p (float, optional): The top_p parameter for the LLM. Defaults to 0.9.
    
    Returns:
        dict: Configured Bedrock invoke settings.
    """
    return {
        "model_id": bedrock_llm_id,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "top_p": top_p,
    }

def retrieve_dynamodb_history(table_name: str, session_id: str) -> str:
    """
    Retrieve conversation history from DynamoDB for a specific session.
    
    Args:
        table_name (str): Name of the DynamoDB table storing chat history.
        session_id (str): Unique identifier for the conversation session.
    
    Returns:
        str: Formatted conversation history as a string.
    """
    try:
        response = dynamodb.get_item(
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

def generate_lawyer_summary(
    conversation_history: str, 
    llm: dict, 
    prompt_instruction: str,
    case_type: str = None, 
    case_description: str = None, 
    jurisdiction: str = None,
    block_type: str = "intake"
) -> str:
    """
    Generate a concise, professional summary of the conversation for lawyers.
    
    Args:
        conversation_history (str): Formatted conversation history string.
        llm (dict): Bedrock InvokeModel configuration.
        case_type (str, optional): Type of legal case.
        case_description (str, optional): Brief description of the case.
        jurisdiction (str, optional): Legal jurisdiction for the case.
        block_type (str, optional): The type of block to summarize (e.g. intake, legal_analysis).
    
    Returns:
        str: Formatted lawyer-friendly summary.
    """

    if not prompt_instruction:
        raise ValueError(f"Missing active summary prompt for block_type: {block_type}")

    # Sanitize user-provided case context before interpolation into prompt
    case_type_clean, ct_flag = sanitize_prompt_input(case_type or "")
    case_description_clean, cd_flag = sanitize_prompt_input(case_description or "")
    jurisdiction_clean, j_flag = sanitize_prompt_input(jurisdiction or "")

    if any([ct_flag, cd_flag, j_flag]):
        logger.warning("Prompt injection pattern detected in case context for summary generation")

    system_prompt = f"""
{prompt_instruction}

--- CASE METADATA ---
Case Type: {case_type_clean or 'Not Specified'}
Case Description: {case_description_clean or 'No additional description provided'}
Jurisdiction: {jurisdiction_clean or 'Not Specified'}

--- CRITICAL OUTPUT INSTRUCTIONS ---
- Respond with ONLY the summary content in markdown format.
- DO NOT include ANY preamble, such as "Here's your summary...", "Based on the information provided...", or "Based on the conversation...".
- DO NOT include ANY outro, such as "Let me know if this is correct...", "Please review...", or "Please let me know if I am missing...".
- Start directly with the first section heading.
- End with the last content point.
- NO conversational text whatsoever. ONLY the structured markdown summary.
- Respond in a proper, readable, markdown format.
- Use a clear, professional tone. Organize the summary with clear headings.
- Avoid personal opinions and stick to the observable facts from the conversation.
    """.strip()

    user_prompt = f"Please summarize the following conversation:\n\n---\n{conversation_history}\n---\n\nAdhere strictly to the critical output instructions."
    return _invoke_model_text(llm, system_prompt, user_prompt)

def generate_lawyer_summary_streaming(
    conversation_history: str, 
    llm: dict, 
    prompt_instruction: str,
    case_type: str = None, 
    case_description: str = None, 
    jurisdiction: str = None,
    block_type: str = "intake",
    send_chunk_callback = None
) -> str:
    """
    Generate a streaming summary of the conversation for lawyers.
    
    Args:
        conversation_history (str): Formatted conversation history string.
        llm (dict): Bedrock InvokeModel configuration.
        case_type (str, optional): Type of legal case.
        case_description (str, optional): Brief description of the case.
        jurisdiction (str, optional): Legal jurisdiction for the case.
        block_type (str, optional): The type of block to summarize.
        send_chunk_callback: Callback function to send chunks to WebSocket.
    
    Returns:
        str: Formatted lawyer-friendly summary.
    """

    if not prompt_instruction:
        raise ValueError(f"Missing active summary prompt for block_type: {block_type}")

    # Sanitize user-provided case context before interpolation into prompt
    case_type_clean, ct_flag = sanitize_prompt_input(case_type or "")
    case_description_clean, cd_flag = sanitize_prompt_input(case_description or "")
    jurisdiction_clean, j_flag = sanitize_prompt_input(jurisdiction or "")

    if any([ct_flag, cd_flag, j_flag]):
        logger.warning("Prompt injection pattern detected in case context for streaming summary generation")

    system_prompt = f"""
{prompt_instruction}

--- CASE METADATA ---
Case Type: {case_type_clean or 'Not Specified'}
Case Description: {case_description_clean or 'No additional description provided'}
Jurisdiction: {jurisdiction_clean or 'Not Specified'}

--- CRITICAL OUTPUT INSTRUCTIONS ---
- Respond with ONLY the summary content in markdown format.
- DO NOT include ANY preamble, such as "Here's your summary...", "Based on the information provided...", or "Based on the conversation...".
- DO NOT include ANY outro, such as "Let me know if this is correct...", "Please review...", or "Please let me know if I am missing...".
- Start directly with the first section heading.
- End with the last content point.
- NO conversational text whatsoever. ONLY the structured markdown summary.
- Respond in a proper, readable, markdown format.
- Use a clear, professional tone. Organize the summary with clear headings.
- Avoid personal opinions and stick to the observable facts from the conversation.
    """.strip()

    user_prompt = f"Please summarize the following conversation:\n\n---\n{conversation_history}\n---\n\nAdhere strictly to the critical output instructions."

    try:
        return _stream_invoke_model_text(llm, system_prompt, user_prompt, send_chunk_callback)
    except Exception as e:
        logger.error(f"Error during streaming summary generation: {e}")
        raise

def generate_full_case_summary(
    block_summaries: list,  # [{block_type, content, title}, ...]
    llm: dict,
    prompt_instruction: str,
    case_type: str = None,
    case_description: str = None,
    jurisdiction: str = None
) -> str:
    """
    Synthesize multiple block summaries into a cohesive full-case summary.
    
    Args:
        block_summaries (list): List of dictionaries containing block summaries.
        llm (dict): Bedrock InvokeModel configuration.
        case_type (str, optional): Type of legal case.
        case_description (str, optional): Brief description of the case.
        jurisdiction (str, optional): Legal jurisdiction.
        
    Returns:
        str: Synthesized full-case summary.
    """
    # Format the input summaries for the prompt
    summaries_text = "\n\n".join([
        f"--- SECTION: {item['title']} ({item['block_type']}) ---\n{item['content']}"
        for item in block_summaries
    ])

    if not prompt_instruction:
        raise ValueError("Missing active summary prompt for block_type: full_case")

    system_prompt = f"""
{prompt_instruction}

--- CRITICAL OUTPUT INSTRUCTIONS ---
IMPORTANT: Respond with ONLY the synthesized summary content in markdown format.
Do not include any preamble, explanation, or meta-commentary (e.g. no "Here is the summary" or "Based on the information...").
Do not include any outro or conclusion text.
Start directly with the summary content and end with the last content point. No conversational text whatsoever.
    """.strip()
    user_prompt = f"Here are the summaries from different stages of the case:\n\n---\n{summaries_text}\n---\n\nPlease synthesize them strictly adhering to the critical output instructions."
    return _invoke_model_text(llm, system_prompt, user_prompt)

def generate_full_case_summary_streaming(
    block_summaries: list,  # [{block_type, content, title}, ...]
    llm: dict,
    prompt_instruction: str,
    case_type: str = None,
    case_description: str = None,
    jurisdiction: str = None,
    send_chunk_callback = None
) -> str:
    """
    Synthesize multiple block summaries into a cohesive full-case summary with streaming.
    
    Args:
        block_summaries (list): List of dictionaries containing block summaries.
        llm (dict): Bedrock InvokeModel configuration.
        case_type (str, optional): Type of legal case.
        case_description (str, optional): Brief description of the case.
        jurisdiction (str, optional): Legal jurisdiction.
        send_chunk_callback: Callback function to send chunks to WebSocket.
        
    Returns:
        str: Synthesized full-case summary.
    """
    # Format the input summaries for the prompt
    summaries_text = "\n\n".join([
        f"--- SECTION: {item['title']} ({item['block_type']}) ---\n{item['content']}"
        for item in block_summaries
    ])

    if not prompt_instruction:
        raise ValueError("Missing active summary prompt for block_type: full_case")

    system_prompt = f"""
{prompt_instruction}

--- CRITICAL OUTPUT INSTRUCTIONS ---
IMPORTANT: Respond with ONLY the synthesized summary content in markdown format.
Do not include any preamble, explanation, or meta-commentary (e.g. no "Here is the summary" or "Based on the information...").
Do not include any outro or conclusion text.
Start directly with the summary content and end with the last content point. No conversational text whatsoever.
    """.strip()
    user_prompt = f"Here are the summaries from different stages of the case:\n\n---\n{summaries_text}\n---\n\nPlease synthesize them strictly adhering to the critical output instructions."

    try:
        return _stream_invoke_model_text(llm, system_prompt, user_prompt, send_chunk_callback)
    except Exception as e:
        logger.error(f"Error during streaming full-case summary generation: {e}")
        raise

