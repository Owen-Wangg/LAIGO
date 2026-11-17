"""
Prompt input sanitizer for Bedrock LLM invocations.

Strips control sequences and common prompt injection patterns from user-provided
content before it is interpolated into LLM prompts. This is a defense-in-depth
measure — Bedrock Guardrails provide the primary protection, but sanitizing inputs
before they reach the prompt template reduces the attack surface.
"""

import re
import logging

logger = logging.getLogger(__name__)

# Patterns that indicate prompt injection attempts.
# Each tuple is (compiled_regex, description) for logging purposes.
_INJECTION_PATTERNS = [
    # Direct instruction overrides
    (re.compile(r"(?i)\b(ignore|disregard|forget)\b.{0,30}\b(previous|above|prior|all)\b.{0,30}\b(instructions?|prompts?|rules?|context)\b"), "instruction override"),
    # Role assumption attempts
    (re.compile(r"(?i)\b(you are now|act as|pretend to be|assume the role|switch to|new role)\b"), "role assumption"),
    # System prompt extraction
    (re.compile(r"(?i)\b(reveal|show|print|output|repeat|display)\b.{0,20}\b(system prompt|instructions|hidden|secret|internal)\b"), "prompt extraction"),
    # Delimiter injection (trying to close/open prompt sections)
    (re.compile(r"(?i)(```\s*(system|assistant|end|human)|<\/?system>|<\/?prompt>|\[INST\]|\[\/INST\]|<<SYS>>|<\/SYS>>)"), "delimiter injection"),
    # Direct command patterns
    (re.compile(r"(?i)^\s*(system|assistant)\s*:"), "role prefix injection"),
    # Jailbreak patterns
    (re.compile(r"(?i)\b(DAN|do anything now|jailbreak|bypass|override safety|ignore safety)\b"), "jailbreak attempt"),
]

# Control characters and zero-width characters that could be used to hide injections
_CONTROL_CHAR_PATTERN = re.compile(
    r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f"  # ASCII control chars (preserve \t \n \r)
    r"\u200b-\u200f"  # Zero-width chars
    r"\u2028-\u2029"  # Line/paragraph separators
    r"\u202a-\u202e"  # Bidi overrides
    r"\u2060-\u2064"  # Invisible operators
    r"\ufeff"  # BOM
    r"\ufff9-\ufffb"  # Interlinear annotations
    r"]"
)


def sanitize_prompt_input(user_input: str) -> tuple[str, bool]:
    """
    Sanitize user-provided text before interpolation into LLM prompts.

    Strips control characters and detects common prompt injection patterns.
    This is a defense-in-depth measure — Bedrock Guardrails remain the primary
    protection layer.

    Args:
        user_input: Raw user-provided string (case description, question, etc.)

    Returns:
        A tuple of (sanitized_string, injection_detected).
        - sanitized_string: The cleaned input with control chars removed.
        - injection_detected: True if any injection pattern was matched.
          The content is still returned (stripped of control chars) so the
          caller can decide whether to proceed or reject.
    """
    if user_input is None:
        return ("", False)

    if isinstance(user_input, list):
        user_input = ", ".join(str(item) for item in user_input)
    elif not isinstance(user_input, str):
        user_input = str(user_input)

    if not user_input:
        return ("", False)

    # Strip control characters
    sanitized = _CONTROL_CHAR_PATTERN.sub("", user_input)

    # Check for injection patterns
    injection_detected = False
    for pattern, description in _INJECTION_PATTERNS:
        if pattern.search(sanitized):
            # Log the pattern and input length only. The input is privileged
            # client content and must not be written to logs.
            logger.warning(
                "Prompt injection pattern detected: %s (input length: %d)",
                description,
                len(sanitized),
            )
            injection_detected = True
            break  # One detection is enough to flag

    return (sanitized, injection_detected)
