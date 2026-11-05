# Architecture Deep Dive

## Architecture

<img src="./media/architecture.png" alt="Architecture Diagram" style="width:100%;" />


1. **Edge and security** – All incoming traffic passes through **AWS Shield**, **Amazon CloudFront**, and **AWS WAF** to provide Layer 3, 4, and 7 protection. This layer flags potential threats, manages rate-limiting, and ensures secure content delivery before requests reach the application.

2. **Frontend** – The React web application is hosted and deployed via **AWS Amplify**. **AWS Cognito** serves as the authentication provider, managing user sign-up, sign-in, and secure access control to the backend services.

3. **API layer** – The backend surface is managed by **Amazon API Gateway**, which handles two primary communication patterns:
    - A **REST API** endpoint that routes CRUD operations and requests for pre-signed URLs to backend Lambda functions.
    - A **WebSocket API** (Streaming) that facilitates real-time, low-latency communication for chat interactions and live updates.

4. **Audio processing workflow** – When a user initiates an audio upload:
    1. A pre-signed URL is generated when the user uploads an audio file.
    2. The pre-signed URL is stored in an **Amazon S3** bucket.
    3. An **AWS Lambda** function monitors the bucket, retrieves the audio file, and prepares it for transcription processing.
    4. **Amazon Transcribe** processes the uploaded audio file and converts it into text.

5. **Data persistence** – Metadata related to the audio file and its transcription, such as timestamps and case ID, alongside primary application data such as cases and users, is stored in an **Amazon RDS for PostgreSQL** (version 17) database. An **Amazon RDS Proxy** manages a high volume of concurrent connections and requires TLS. Chat history, notifications, WebSocket connections, prompt playground sessions, and the signup email whitelist are stored in **Amazon DynamoDB** tables.


6. **Notifications** – **Amazon EventBridge** receives domain events and routes them to a **Notification Service Lambda**, which stores notification and connection state data in **DynamoDB**.

7. **Standard CRUD endpoints** – The **Amazon API Gateway REST API** exposes standard CRUD endpoints for core resources (for example, users, cases, feedback, and summaries) through role-aware Lambda handlers.

8. **AI services** – For intelligent text generation, summarization, and related assessments, dedicated Lambda functions retrieve context from persistence layers and invoke **Amazon Bedrock** models.

9. **Notifications and AI streaming to frontend** – The backend pushes real-time notification and AI generation updates to the frontend through the **Amazon API Gateway WebSocket API**, enabling low-latency status and response streaming.

10. **Infrastructure & CI/CD pipeline** – The backend uses **AWS CodePipeline** and **AWS CodeBuild** to automate build and deployment workflows, with container images stored in **Amazon ECR** for Lambda-based services.

### Database Schema

![Database Diagram](./media/database-schema.png)

#### RDS Tables

##### `users`

| Column                 | Description                                             |
| ---------------------- | ------------------------------------------------------- |
| `user_id`              | UUID PK                                                 |
| `idp_id`               | External identity provider ID (Cognito or others)       |
| `user_email`           | Unique email                                            |
| `username`             | Display name                                            |
| `first_name`           | First name of the user                                  |
| `last_name`            | Last name of the user                                   |
| `roles`                | Array of `user_role` (`student`/`instructor`/`admin`)   |
| `time_account_created` | Timestamp when the user's account was initially created |
| `last_sign_in`         | Timestamp of the user's most recent login               |
| `activity_counter`     | Count of AI requests made by the user today (resets at the UTC date boundary) |
| `last_activity`        | Timestamp of the user's last recorded activity          |
| `accepted_disclaimer`  | True if user has agreed to the current disclaimer       |
| `metadata`             | JSONB field for miscellaneous user metadata             |

##### `cases`

| Column             | Description                                                                    |
| ------------------ | ------------------------------------------------------------------------------ |
| `case_id`          | UUID PK                                                                        |
| `student_id`       | FK → `users`                                                                   |
| `case_hash`        | Unique base64 hash                                                             |
| `case_title`       | Human‑readable title of the case                                               |
| `case_type`        | Category or classification of the legal case                                   |
| `case_description` | Full description of the legal matter provided by the student                   |
| `jurisdiction`     | List of relevant jurisdictions (e.g. Federal, Provincial)                      |
| `province`         | Province associated with the case (defaults to N/A)                            |
| `statute`          | Statutory reference or law section relevant to the case                        |
| `status`           | Current lifecycle status of the case (in_progress/submitted/reviewed/archived) |
| `completed_blocks` | List of section types that the student has finished working on                 |
| `last_updated`     | Timestamp of the most recent modification to the case record                   |
| `last_viewed`      | When the student last opened or viewed the case                                |
| `time_submitted`   | Timestamp when the student submitted the case for review                       |
| `time_reviewed`    | When an instructor or reviewer completed their review of the case              |
| `sent_to_review`   | Indicates whether the case has been flagged for instructor review              |
| `student_notes`    | Free‑form notes the student adds to the case                                   |

##### `case_feedback`

| Column          | Description                                                    |
| --------------- | -------------------------------------------------------------- |
| `feedback_id`   | UUID PK                                                        |
| `case_id`       | FK→`cases`                                                     |
| `author_id`     | FK→`users`                                                     |
| `feedback_text` | Feedback written by an instructor or reviewer regarding a case |
| `time_created`  | Timestamp when the feedback entry was submitted                |

##### `prompt_versions`

| Column              | Description                                                       |
| ------------------- | ----------------------------------------------------------------- |
| `prompt_version_id` | UUID PK                                                           |
| `category`          | Classification of the prompt (reasoning, assessment, or summary)  |
| `prompt_scope`      | Prompt scope (`block` for block-specific prompts, `full_case` for synthesis prompts) |
| `block_type`        | Section type for block-scope prompts (nullable for `full_case` scope) |
| `version_number`    | Sequential version index for the prompt                           |
| `version_name`      | Optional human‑readable name for the prompt version               |
| `prompt_text`       | Prompt content used when generating AI responses                  |
| `author_id`         | FK→`users`                                                        |
| `time_created`      | When the prompt version was added to the system                   |
| `is_active`         | Marks whether this prompt version is currently in use             |

##### `summaries`

| Column          | Description                                                      |
| --------------- | ---------------------------------------------------------------- |
| `summary_id`    | UUID PK                                                          |
| `case_id`       | FK→`cases`                                                       |
| `scope`         | Indicates whether summary covers a single block or the full case |
| `block_context` | Block type context for which the summary was generated           |
| `title`         | Optional title for the summary                                   |
| `content`       | Generated summary or reasoning text for the case                 |
| `version`       | Version number of the summary (increments on edits)              |
| `time_created`  | Timestamp when the summary was generated                         |

##### `annotations`

| Column          | Description                                                  |
| --------------- | ------------------------------------------------------------ |
| `annotation_id` | UUID PK                                                      |
| `summary_id`    | FK→`summaries`                                               |
| `author_id`     | FK→`users`                                                   |
| `start_offset`  | Character index where the annotation begins                  |
| `end_offset`    | Character index where the annotation ends                    |
| `quote_text`    | Quoted excerpt from a summary that the annotation highlights |
| `comment_text`  | Comment provided by the annotator concerning the quote       |
| `time_created`  | Timestamp when the annotation was added                      |

##### `audio_files`

| Column          | Description                                               |
| --------------- | --------------------------------------------------------- |
| `audio_file_id` | UUID PK                                                   |
| `case_id`       | FK→`cases`                                                |
| `file_title`    | Original filename or title associated with the audio file |
| `audio_text`    | Transcription output produced from the audio file         |
| `s3_file_path`  | S3 key/location of the uploaded audio file                |
| `time_uploaded` | When the audio file was uploaded                          |

##### `messages`

| Column            | Description                                                               |
| ----------------- | ------------------------------------------------------------------------- |
| `message_id`      | UUID PK                                                                   |
| `instructor_id`   | FK→`users`                                                                |
| `message_content` | Text body of a message sent between users (usually instructor to student) |
| `case_id`         | FK→`cases`                                                                |
| `time_sent`       | When the message was sent                                                 |
| `is_read`         | Whether the recipient has read the message                                |

##### `case_reviewers`

| Column        | Description                                |
| ------------- | ------------------------------------------ |
| `case_id`     | FK→`cases`                                 |
| `reviewer_id` | FK→`users`                                 |
| `assigned_at` | When the reviewer was assigned to the case |

##### `instructor_students`

| Column             | Description                                                   |
| ------------------ | ------------------------------------------------------------- |
| `instructor_id`    | FK→`users`                                                    |
| `student_id`       | FK→`users`                                                    |
| `primary_assigned` | Indicates if this instructor is the student's primary teacher |

##### `disclaimers`

| Column            | Description                                                   |
| ----------------- | ------------------------------------------------------------- |
| `disclaimer_id`   | UUID PK                                                       |
| `author_id`       | FK→`users`                                                    |
| `disclaimer_text` | Content of the disclaimer presented to users during sign‑up   |
| `version_number`  | Sequential version number for the disclaimer                  |
| `version_name`    | Optional human‑readable label for the disclaimer version      |
| `time_created`    | Timestamp when this disclaimer version was created            |
| `last_updated`    | Timestamp of the last modification to the disclaimer          |
| `is_active`       | Indicates whether this disclaimer is the currently active one |

##### `role_labels`

| Column           | Description                                                                 |
| ---------------- | --------------------------------------------------------------------------- |
| `role_key`       | PK using `user_role` enum (`student`/`instructor`/`admin`)                 |
| `singular_label` | Configurable singular display label for a role (e.g., Student, Instructor) |
| `plural_label`   | Configurable plural display label for a role (e.g., Students, Instructors) |
| `updated_by`     | FK→`users`; user who last updated the role label pair                       |
| `updated_at`     | Timestamp of the most recent role label update                              |

##### `audit_log`

Records administrative actions: role changes, instructor assignments, prompt and disclaimer changes, role label edits, AI configuration updates, signup mode changes, and whitelist changes. The table is append-only for the application database roles: `db_setup` revokes `UPDATE`, `DELETE`, and `TRUNCATE` on it from `readwrite` and `tablecreator` on every deploy.

| Column          | Description                                                        |
| --------------- | ------------------------------------------------------------------ |
| `audit_id`      | UUID PK                                                            |
| `actor_id`      | ID of the user who performed the action (no FK, so rows survive user deletion) |
| `actor_email`   | Email of the acting user at the time of the action                 |
| `action`        | Action name (for example `user_role.elevate_instructor`)           |
| `subject_type`  | Type of the affected object (for example `user`)                   |
| `subject_id`    | ID of the affected object                                          |
| `subject_email` | Email of the affected user, when the subject is a user             |
| `before_state`  | JSONB snapshot before the change                                   |
| `after_state`   | JSONB snapshot after the change                                    |
| `created_at`    | Timestamp of the action                                            |

---
