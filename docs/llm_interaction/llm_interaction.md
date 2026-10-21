# LLM Interaction Overview

## Table Of Contents
1. [Text Generation](#1-text-generation)
2. [Case Generation](#2-case-generation)
3. [Summary Generation](#3-summary-generation)
4. [Progress Assessment](#4-progress-assessment)
5. [Playground Generation](#5-playground-generation)

---

## LLM Configuration
All functions use AWS Bedrock models. Configuration is managed centrally via SSM Parameter Store — all Lambda functions reference the same set of SSM parameters, so changing a value affects every function simultaneously. Each function caches these values across warm Lambda invocations.

| Parameter        | Purpose                                                                                                              | Configuration                                                                | Acceptable Values                                                                                            |
|------------------|----------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------|
| `bedrock_llm_id` | Identifies which Bedrock model to use for generation.                                                                | Single shared SSM parameter (`BEDROCK_LLM_PARAM`), used by all functions     | Must match a valid Bedrock model ID or cross-region inference profile ARN (e.g., `"meta.llama3-70b-instruct-v1:0"`, `"arn:aws:bedrock:{region}:{account}:inference-profile/us.anthropic.claude-sonnet-5-5"`) |
| `temperature`     | Controls randomness of the generated output. Lower = more deterministic; higher = more creative.                    | Single shared SSM parameter (`BEDROCK_TEMP_PARAM`), used by all functions    | A float between `0` and `1`.                                                                                 |
| `top_p`           | Nucleus sampling: percentage of most-likely candidates considered for the next token.                               | Single shared SSM parameter (`BEDROCK_TOP_P_PARAM`), used by all functions   | A float between `0` and `1`.                                                                                 |
| `max_tokens`      | Maximum number of tokens the model is allowed to generate in its response.                                          | Single shared SSM parameter (`BEDROCK_MAX_TOKENS_PARAM`), used by all functions | Any positive integer.                                                                                     |

> All Lambda functions (text generation, case generation, summary generation, assessment, playground) point to the exact same SSM parameters in CDK. Changing a value via the admin AI Configuration page updates every function at once. Each function does have a hardcoded fallback default that applies only if the SSM parameter has not been set yet:
>
> | Function              | Fallback Temperature | Fallback Top P | Fallback Max Tokens |
> |-----------------------|----------------------|----------------|---------------------|
> | Text Generation       | 0.5                  | 0.9            | 2048                |
> | Case Generation       | 0.7                  | 0.9            | 150                 |
> | Summary Generation    | 0.5                  | 0.9            | 2048                |
> | Progress Assessment   | 0.0                  | 0.9            | 512                 |
> | Playground Generation | 0.5                  | 0.9            | 2048                |
>
> The Playground function is a special case: it accepts per-request overrides for model ID, temperature, top_p, and max_tokens via the WebSocket request body, allowing admins/instructors to test different configurations without changing the shared SSM values.

### Shared Patterns

All Python Lambda functions share these common patterns:

- **Secrets Manager** for database credentials (`SM_DB_CREDENTIALS`)
- **SSM Parameter Store** for runtime configuration (model ID, temperature, etc.) — single shared set of parameters across all functions
- **RDS Proxy** for PostgreSQL connection pooling
- **Cached globals** for secrets, parameters, and DB connections across warm invocations
- **AWS Lambda Powertools** for structured logging and metrics (`Logger`, `Metrics`)

---

## 1. Text Generation

Text generation powers the interview assistant, allowing students to have multi-turn conversations with an AI about their legal cases. It supports both HTTP and WebSocket streaming modes.

### Source
- Handler: `cdk/lambda/text_generation/src/main.py`
- Helpers: `cdk/lambda/text_generation/src/helpers/chat.py`, `cdk/lambda/text_generation/src/helpers/usage.py`

### Key Functions

#### Handler (`main.py`)

- `handler(event, context)`:
    - Entry point for the Lambda function
    - Supports both HTTP (synchronous) and WebSocket (streaming) invocation modes
    - Maps `sub_route` to `block_type` enum: `intake-facts` → `intake`, `legal-analysis` → `legal_analysis`, `contrarian-analysis` → `contrarian`, `policy-context` → `policy`
    - Constructs a unique DynamoDB session ID as `{case_id}-{block_type}`
    - Applies Bedrock Guardrails to user input (PII detection, prompt injection prevention)
    - Enforces daily message limits per user via `check_and_increment_usage`
    - Performs IDOR protection via `check_authorization` (only case owner can send messages)

- `initialize_constants()`:
    - Fetches and caches `BEDROCK_LLM_ID`, `TABLE_NAME`, temperature, top_p, max_tokens, and `MESSAGE_LIMIT` from SSM Parameter Store

- `get_system_prompt(block_type: str)`:
    - Retrieves the active system prompt from the `prompt_versions` database table
    - Filters by `block_type`, `is_active = true`, and `category = 'reasoning'`
    - Returns the latest version by `version_number`

- `get_case_details(case_id: str)`:
    - Fetches `case_title`, `case_type`, `jurisdiction`, `case_description`, `province`, `statute` from the `cases` table

- `get_audio_details(case_id: str)`:
    - Fetches `case_description` from the `cases` table (used for audio context)

- `check_authorization(user_id, case_id)`:
    - Verifies the user owns the specified case (only case owner can send messages)
    - Uses `@functools.lru_cache` for performance

#### Chat Helpers (`helpers/chat.py`)

- `get_bedrock_llm(bedrock_llm_id, temperature, top_p, max_tokens, guardrail_id, guardrail_version)`:
    - Creates a `ChatBedrockConverse` instance configured with the specified model and guardrails

- `get_initial_student_query(case_type, jurisdiction, case_description)`:
    - Generates the first system prompt to start the conversation
    - Includes case details as context for the LLM
    - Instructs the LLM to greet the user and prepare for case discussion

- `construct_case_context_prompt(system_prompt, case_context)`:
    - Merges the system prompt with case-specific context (type, jurisdiction, description, province, statute)

- `get_response(query, province, statute, llm, table_name, case_id, system_prompt, case_type, jurisdiction, case_description)`:
    - Core function for HTTP mode that processes user queries and generates responses
    - Maintains conversation history in DynamoDB via LangChain's `DynamoDBChatMessageHistory`
    - Incorporates case details into the system prompt
    - Returns a dictionary with the LLM's response

- `get_streaming_response(query, province, statute, llm, table_name, case_id, system_prompt, case_type, jurisdiction, case_description, connection_id, websocket_endpoint, request_id)`:
    - WebSocket streaming variant of `get_response`
    - Sends `start`, `chunk`, and `complete` messages to the WebSocket connection
    - Streams AI response in real-time as chunks
    - Saves conversation history to DynamoDB after streaming completes

- `generate_response(conversational_rag_chain, query, case_id)`:
    - Invokes the conversational chain and returns the raw response

- `get_llm_output(response)`:
    - Extracts the LLM output text from the chain response

- `split_into_sentences(paragraph)`:
    - Splits text into sentences for chunked streaming delivery

- `update_session_name(table_name, session_id, bedrock_llm_id)`:
    - Updates the session name in DynamoDB

#### Usage Helper (`helpers/usage.py`)

- `check_and_increment_usage(connection, user_id)`:
    - Checks and increments the daily message counter for a user in the `users` table
    - Resets the counter if `last_activity` is from a different day (UTC)
    - Returns the current usage count for today

### Guardrail Integration
- Guardrail ID and version are passed via CDK environment variables (`GUARDRAIL_ID`, `GUARDRAIL_VERSION`)
- Input guardrails are applied before LLM invocation using `bedrock_runtime.apply_guardrail()`
- Output guardrails are applied via the `ChatBedrockConverse` guardrail configuration
- Detects PII (names, phone numbers, addresses) and prompt manipulation attempts

---

## 2. Case Generation

Automatically generates a case title based on inputs like case type, jurisdiction, and description. This function is invoked during case creation.

### Source
- Handler: `cdk/lambda/case_generation/src/main.py`
- Helpers: `cdk/lambda/case_generation/src/helpers/chat.py`

### Key Functions

#### Handler (`main.py`)

- `handler(event, context)`:
    - Entry point — handles case creation and title generation in a single flow
    - Extracts `userId` from the authorizer context (database user ID)
    - Applies Bedrock Guardrails to the combined input (title + type + jurisdiction + description)
    - Inserts a new case record into the `cases` table with status `in_progress`
    - Generates a `case_hash` (6-char URL-safe hash of the case UUID)
    - Calls `handle_generate_title` to generate an AI title; falls back gracefully if title generation fails

- `handle_generate_title(case_id, case_type, jurisdiction, case_description, province)`:
    - Orchestrates the title generation process
    - Creates a Bedrock LLM instance with custom configuration
    - Calls `get_response` from the chat helper to generate the title
    - Updates the database with the capitalized title via `update_title`
    - Returns the generated title string

- `capitalize_title(s)`:
    - Capitalizes each word in the title for consistent formatting

- `hash_uuid(uuid_str)`:
    - Creates a 6-character URL-safe hash from a UUID using SHA-256

- `get_case_details(case_id)`:
    - Fetches `case_type`, `jurisdiction`, `case_description`, `statute`, `province` from the `cases` table

- `update_title(case_id, title)`:
    - Updates the `case_title` field in the `cases` table

#### Chat Helpers (`helpers/chat.py`)

- `get_bedrock_llm(bedrock_llm_id, temperature, max_tokens, top_p)`:
    - Returns a configuration dictionary for Bedrock `InvokeModel` (not `ChatBedrockConverse`)
    - Used with direct `bedrock_runtime.invoke_model()` calls

- `get_response(case_type, llm, jurisdiction, case_description, province)`:
    - Constructs a prompt instructing the LLM to generate a professional, concise case title (under 100 characters)
    - Prompt explicitly avoids personal information and country/region names
    - Invokes the model via `bedrock_runtime.invoke_model()` and extracts the response text
    - Trims the result to 100 characters

### Guardrail Integration
- Guardrail ID and version are passed via CDK environment variables
- Input guardrails are applied to the combined case input before processing
- Detects sensitive information (PII) and blocks the request if found

---

## 3. Summary Generation

Generates professional legal summaries from conversation history. Supports both individual block summaries and full-case synthesis summaries. Operates in HTTP and WebSocket streaming modes.

### Source
- Handler: `cdk/lambda/summary_generation/src/main.py`
- Helpers: `cdk/lambda/summary_generation/src/helpers/chat.py`

### Key Functions

#### Handler (`main.py`)

- `handler(event, context)`:
    - Entry point supporting both HTTP and WebSocket streaming modes
    - Routes to either full-case summary or block-specific summary based on `sub_route`
    - Maps `sub_route` to `block_type`: `intake-facts` → `intake`, `legal-analysis` → `legal_analysis`, `contrarian-analysis` → `contrarian`, `policy-context` → `policy`
    - Performs IDOR protection (case owner or instructor of the case owner can generate summaries)
    - Appends a legal disclaimer to all generated summaries
    - Publishes EventBridge notification events on success or failure

- `get_summary_prompt_template(prompt_scope, block_type=None)`:
    - Retrieves the active summary prompt from the `prompt_versions` table
    - For block summaries: `prompt_scope='block'`, `block_type=<block name>`, `category='summary'`
    - For full-case synthesis: `prompt_scope='full_case'`, `category='summary'`
    - Returns the latest active version by `version_number`

- `get_completed_blocks(case_id)`:
    - Retrieves the list of completed blocks for a case from the `cases` table

- `get_latest_block_summaries(case_id, block_types)`:
    - Fetches the most recent summary for each requested block type from the `summaries` table
    - Returns summaries sorted in the canonical block order

- `update_summaries(case_id, summary, block_type, scope='block')`:
    - Inserts a new summary record into the `summaries` table
    - Maps block types to human-readable titles (e.g., `intake` → "Intake Facts Summary")
    - Supports both `block` and `full_case` scopes

- `publish_notification_event(event_type, case_id, user_id, success, error_message)`:
    - Publishes a notification event to EventBridge for summary generation completion/failure
    - Event source: `notification.system`, detail type: `Summary Generation Complete`

- `check_authorization(user_id, case_id)`:
    - Verifies the user owns the case or is an instructor for the case owner

- `send_to_websocket(connection_id, endpoint, request_id, msg_type, content, data)`:
    - Sends structured messages to a WebSocket connection with request correlation

#### Chat Helpers (`helpers/chat.py`)

- `get_bedrock_llm(bedrock_llm_id, temperature, top_p, max_tokens)`:
    - Returns a configuration dictionary for direct Bedrock model invocation

- `retrieve_dynamodb_history(table_name, session_id)`:
    - Retrieves conversation history from DynamoDB for a specific session
    - Converts DynamoDB items to a formatted string with role labels and timestamps

- `generate_lawyer_summary(conversation_history, llm, prompt_instruction, case_type, case_description, jurisdiction, block_type)`:
    - Generates a block-specific legal summary from conversation history (non-streaming)
    - Uses the prompt template from the database as the system instruction

- `generate_lawyer_summary_streaming(conversation_history, llm, prompt_instruction, case_type, case_description, jurisdiction, block_type, send_chunk_callback)`:
    - Streaming variant that sends chunks via the callback as they are generated

- `generate_full_case_summary(block_summaries, llm, prompt_instruction, case_type, case_description, jurisdiction)`:
    - Synthesizes all block summaries into a comprehensive full-case summary (non-streaming)

- `generate_full_case_summary_streaming(block_summaries, llm, prompt_instruction, case_type, case_description, jurisdiction, send_chunk_callback)`:
    - Streaming variant of full-case summary generation

### Full-Case Summary Flow
1. Retrieves latest block summaries for canonical block types: `intake`, `legal_analysis`, `contrarian`, `policy`
2. Fetches the active full-case summary prompt from `prompt_versions`
3. Generates a synthesis summary incorporating all block summaries with case context
4. Appends a legal disclaimer
5. Saves the summary to the `summaries` table with `scope='full_case'`
6. Publishes an EventBridge notification

### Legal Disclaimer
All summaries (block and full-case) include a mandatory disclaimer stating the summary must not be provided to the client without supervising lawyer review, is based solely on facts inputted by the user, and must be updated if facts change or after six months.

---

## 4. Progress Assessment

Evaluates a student's progress within a specific interview block by analyzing their conversation history against assessment criteria. Returns a progress score (0-5) and reasoning.

### Source
- Handler: `cdk/lambda/assess_progress/src/main.py`

### Key Functions

- `handler(event, context)`:
    - Entry point supporting both HTTP and WebSocket modes
    - Two modes of operation:
        - **Standard mode**: Requires `case_id` and `block_type`; uses database assessment prompts and case-specific chat history
        - **Playground mode**: Uses `custom_prompt` and `session_id`; reads from the playground DynamoDB table; never unlocks blocks
    - Performs IDOR protection in standard mode
    - Constructs session ID as `{case_id}-{block_type}` (standard) or `playground-{session_id}-{block_type}` (playground)

- `invoke_model_text(system_instructions, human_context)`:
    - Invokes the Bedrock model directly via `bedrock_runtime.invoke_model()`
    - Builds request payload based on model type (Anthropic or Meta format)
    - Returns the raw text response

- `get_assessment_prompt_template(block_type)`:
    - Retrieves the active assessment prompt from `prompt_versions` table
    - Filters by `block_type`, `is_active = true`, and `category = 'assessment'`

- `fetch_chat_history(session_id, table_name=None)`:
    - Retrieves chat history from DynamoDB for the given session
    - Supports both the main conversation table and the playground table

- `retrieve_dynamodb_history(table_name, session_id)`:
    - Alternative history retrieval that formats messages with role labels and timestamps

- `mark_block_completed(case_id, block_type)`:
    - Adds the block type to the `completed_blocks` array in the `cases` table when progress reaches 5/5
    - Returns `True` if the block was successfully marked as completed

- `check_authorization(user_id, case_id)`:
    - Verifies the user owns the case (IDOR protection)

### Assessment Prompt Structure
The LLM receives:
- **System instructions**: Assessment criteria from the database prompt template, with instructions to output a JSON object containing `progress` (0-5) and `reasoning` (3-4 sentences in second person)
- **Conversation history package**:
    - Ordered full timeline of all turns (chronological)
    - Human-only turn list used as the creditable evidence lane
    - Assistant-only turn list marked as context-only, non-creditable

### Human-Effort Guardrails
- Progress scoring is based on human-authored effort; assistant-generated analysis or summaries cannot be counted as student work.
- If human participation is mostly low-effort requests (for example, asking the assistant to "analyze" or "summarize" without substantive follow-up), a conservative score cap is applied.
- This logic is applied consistently in both standard assessment mode and playground assessment mode.

### Response Parsing
- Extracts JSON from the LLM response by finding the first `{` and last `}`
- Falls back to `{ progress: 0, reasoning: "Error parsing assessment result." }` on parse failure

---

## 5. Playground Generation

Allows admins and instructors to test prompt configurations with custom model parameters. Operates exclusively in WebSocket streaming mode.

### Source
- Handler: `cdk/lambda/playground_generation/src/main.py`
- Helpers: `cdk/lambda/playground_generation/src/helpers/chat.py`

### Key Functions

#### Handler (`main.py`)

- `handler(event, context)`:
    - Entry point — WebSocket-only (returns 400 for HTTP requests)
    - Accepts custom model configuration overrides: `model_id`, `temperature`, `top_p`, `max_tokens`
    - Uses `custom_prompt` as the system prompt (falls back to a default legal assistant prompt)
    - Constructs session ID as `playground-{session_id}-{block_type}`
    - Applies Bedrock Guardrails to the test message input
    - Streams the response via WebSocket using `get_playground_streaming_response`

- `initialize_constants()`:
    - Fetches and caches model configuration from SSM Parameter Store
    - Uses `TABLE_NAME` environment variable directly if available, otherwise fetches from SSM

- `get_default_system_prompt()`:
    - Returns a default legal assistant system prompt for use when no custom prompt is provided
    - Instructs the AI to be concise, address the student in second person, and provide legal analysis with follow-up questions

#### Chat Helpers (`helpers/chat.py`)

- `get_bedrock_llm(bedrock_llm_id, temperature, top_p, max_tokens, guardrail_id, guardrail_version)`:
    - Creates a `ChatBedrockConverse` instance with custom configuration and optional guardrails

- `get_playground_streaming_response(query, llm, table_name, session_id, system_prompt, connection_id, websocket_endpoint, request_id, case_context)`:
    - Streams the AI response to the WebSocket connection
    - Maintains conversation history in a dedicated playground DynamoDB table
    - Sends `start`, `chunk`, and `complete` messages

### Custom Model Configuration
Admins/instructors can override the following per-request:
- `model_id`: Bedrock model identifier
- `temperature`: Sampling temperature
- `top_p`: Nucleus sampling parameter
- `max_tokens`: Maximum response length

Values fall back to the SSM-configured defaults if not provided or if parsing fails.
