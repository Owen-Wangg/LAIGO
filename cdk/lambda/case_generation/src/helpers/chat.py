import logging
import json
import re
from typing import Optional
from bedrock_client import get_bedrock_runtime_client

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
bedrock_runtime = get_bedrock_runtime_client()

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


def _build_request_payload(model_id: str, prompt: str, temperature: float, max_tokens: int, top_p: Optional[float]) -> dict:
    if _is_anthropic_model(model_id):
        body = {
            "anthropic_version": "bedrock-2023-05-31",
            "messages": [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
            "max_tokens": max_tokens,
        }
        _apply_sampling_params(body, model_id, temperature, top_p)
        return body

    if _is_meta_model(model_id):
        # Llama 3 requires special chat template tokens for instruction following
        formatted_prompt = (
            f"<|begin_of_text|><|start_header_id|>user<|end_header_id|>\n\n"
            f"{prompt}<|eot_id|>"
            f"<|start_header_id|>assistant<|end_header_id|>\n\n"
        )
        return {
            "prompt": formatted_prompt,
            "max_gen_len": max_tokens,
            "temperature": temperature,
            "top_p": top_p,
        }

    raise ValueError(f"Unsupported Bedrock model for InvokeModel: {model_id}")


def _extract_response_text(model_id: str, invoke_response: dict) -> str:
    body = json.loads(invoke_response["body"].read())

    if _is_anthropic_model(model_id):
        content_blocks = body.get("content", [])
        return "".join(block.get("text", "") for block in content_blocks if block.get("type") == "text")

    if _is_meta_model(model_id):
        return body.get("generation") or body.get("output_text") or ""

    return body.get("outputText") or ""

def get_bedrock_llm(
    bedrock_llm_id: str,
    temperature: Optional[float] = 0.7,
    max_tokens: Optional[int] = 150,
    top_p : Optional[float] = None
) -> dict:
    """
    Create a Bedrock InvokeModel configuration dictionary.

    Args:
        bedrock_llm_id (str): The unique identifier for the Bedrock LLM model.
        temperature (float, optional): A parameter that controls the randomness 
            of generated responses (default is 0).
        max_tokens (int, optional): Sets an upper bound on how many tokens the model will generate in its response (default is None).
        top_p (float, optional): Indicates the percentage of most-likely candidates that are considered for the next token (default is None).

    Returns:
        dict: InvokeModel configuration for the selected model.
    """
    logger.info(
        "Initializing Bedrock InvokeModel config with model_id '%s', temperature '%s', max_tokens '%s', top_p '%s'.",
        bedrock_llm_id, 
        temperature,
        max_tokens, 
        top_p
    )
    
    return {
        "model_id": bedrock_llm_id,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "top_p": top_p,
    }


def generate_case_title(
    case_type: str, 
    llm: dict,
    jurisdiction: Optional[str] = None, 
    case_description: Optional[str] = None,
    province: Optional[str] = None
) -> str:
    """
    Generate a case title using an LLM based on input parameters.

    Args:
        case_type (str): The type of legal case
        llm (dict): Bedrock InvokeModel configuration.
        jurisdiction (str, optional): The legal jurisdiction of the case
        case_description (str, optional): A brief description of the case

    Returns:
        str: A generated case title
    """
    logger.info(f"Generating case title for case type: {case_type}")
    
    # Sanitize user-provided inputs before interpolation into prompt
    case_type_clean, ct_flag = sanitize_prompt_input(case_type or "")
    jurisdiction_clean, j_flag = sanitize_prompt_input(jurisdiction or "") if jurisdiction else ("", False)
    case_description_clean, cd_flag = sanitize_prompt_input(case_description or "") if case_description else ("", False)
    province_clean, p_flag = sanitize_prompt_input(province or "") if province else ("", False)

    if any([ct_flag, j_flag, cd_flag, p_flag]):
        logger.warning("Prompt injection pattern detected in case context for title generation")

    # Construct a prompt to guide the LLM in creating a concise, professional case title
    prompt = (
        "You are a legal document title generator. Create a professional, concise case title. "
        "Follow these guidelines:\n"
        "- Use a clear, formal format\n"
        "- Include the case type\n"
        "- If jurisdiction is provided, incorporate it\n"
        "- If a description is given, distill its essence\n"
        "- Keep the title under 100 characters\n"
        "- Avoid unnecessary words\n\n"
        "- Avoid the name of the person or any personal information or any country or region names\n"
        "- Do not mention any country or region name in the title, do not format it as country vs person\n"
        "- Do not mention United States vs Defendant"
        "Do not mention anything like: Here is a professional and concise case title:, just return the title.\n"
        f"Case Type: {case_type_clean}\n"
    )
    
    # Add jurisdiction to the prompt if provided
    if jurisdiction_clean:
        prompt += f"Jurisdiction: {jurisdiction_clean}\n"

    # Add province to the prompt if provided
    if province_clean:
        prompt += f"Province: {province_clean}\n"
    
    # Add case description to the prompt if provided
    if case_description_clean:
        prompt += f"Case Description: {case_description_clean}\n"
    
    # Add instruction to generate the title
    prompt += "\nGenerate the case title:"
    
    # Use the LLM to generate the title
    logger.info("Invoking LLM to generate case title")
    request_payload = _build_request_payload(
        model_id=llm["model_id"],
        prompt=prompt,
        temperature=llm["temperature"],
        max_tokens=llm["max_tokens"],
        top_p=llm["top_p"],
    )

    response = bedrock_runtime.invoke_model(
        modelId=llm["model_id"],
        contentType="application/json",
        accept="application/json",
        body=json.dumps(request_payload),
    )

    response_text = _extract_response_text(llm["model_id"], response)
    
    # Trim the response to ensure it's not too long
    title = response_text.strip()[:100]
    
    logger.info(f"Generated case title: {title}")
    return title



