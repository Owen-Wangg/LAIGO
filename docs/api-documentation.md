# LAIGO REST API Documentation

This document provides comprehensive documentation for the LAIGO REST API, including endpoint descriptions, authentication requirements, request/response formats, and example usage.

## Table of Contents

- [Authentication](#authentication)
- [Base URL](#base-url)
- [Common Headers](#common-headers)
- [Error Responses](#error-responses)
- [Student Endpoints](#student-endpoints)
- [Instructor Endpoints](#instructor-endpoints)
- [Admin Endpoints](#admin-endpoints)

## Authentication

All API endpoints require authentication using AWS Cognito JWT tokens. The token must be included in the `Authorization` header of each request.

---

### Obtaining a Token

Users authenticate through AWS Cognito and receive an ID token. This token is used for all API requests.

```javascript
// JavaScript example using AWS Amplify
import { fetchAuthSession } from "aws-amplify/auth";

const session = await fetchAuthSession();
const token = session.tokens?.idToken?.toString();
```

---

### Authorization Levels

The API uses role-based access control (RBAC) with three authorization levels. Each authorizer validates that the user has the specific role in the database:

- **Admin**: User must have `admin` role in database to access `/admin/*` endpoints
- **Instructor**: User must have `instructor` role in database to access `/instructor/*` endpoints
- **Student**: User must have `student` role in database to access `/student/*` endpoints (with some shared endpoint exceptions)

**Important:** Users must explicitly have the role attached to access endpoints. Having an `admin` role does NOT automatically grant access to `/instructor/*` or `/student/*` endpoints - the user must also have those specific roles in their database record.

## Base URL

```
https://{api-id}.execute-api.{region}.amazonaws.com/prod
```

Replace `{api-id}` and `{region}` with your API Gateway deployment values.

## Common Headers

All requests should include:

```
Authorization: {cognito-id-token}
Content-Type: application/json
```


## Error Responses

### Standard Error Format

```json
{
  "error": "Error message description"
}
```

---

### HTTP Status Codes

- `200` - Success
- `400` - Bad Request (invalid parameters or request body)
- `401` - Unauthorized (missing or invalid token)
- `403` - Forbidden (insufficient permissions)
- `404` - Not Found (resource doesn't exist)
- `429` - Too Many Requests (rate limit exceeded)
- `500` - Internal Server Error

---

# Student Endpoints

Student endpoints require the user to have the `student` role in the database. The student authorizer validates this role before allowing access to most `/student/*` endpoints.

**Shared Endpoints:** Some student endpoints are accessible to any authenticated user regardless of role:
- `GET /student/profile`
- `GET /student/role_labels`
- `GET /student/get_disclaimer`
- `POST /student/accept_disclaimer`

## Case Management

### Create New Case

Create a new case for the authenticated student.

**Endpoint:** `POST /student/new_case`

**Query Parameters:**
- `user_id` (string, required): ID of the student

**Request Body:**
```json
{
  "case_title": "Employment Dispute",
  "case_type": "Employment Law",
  "jurisdiction": ["Provincial"],
  "case_description": "Client was terminated without cause after 5 years of employment. Seeking wrongful dismissal damages.",
  "province": "Ontario",
  "statute": "Employment Standards Act, 2000"
}
```

**Parameters:**
- `case_title` (string, required): Title of the case
- `case_type` (string, required): Broad area of law
- `jurisdiction` (array, required): Array of jurisdiction values (`Federal`, `Provincial`, or `Unknown`)
- `case_description` (string, required): Detailed description (1-4000 characters)
- `province` (string, required): Province related to the case
- `statute` (string, required): Statute related to the case

**Response:**
```json
{
  "case_id": "uuid",
  "case_hash": "abc123def456",
  "case_title": "Employment Dispute"
}
```

**Example (cURL):**
```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/new_case?user_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{
  "case_title": "Employment Dispute",
  "case_type": "Employment Law",
  "jurisdiction": [
    "Provincial"
  ],
  "case_description": "Client was terminated without cause after 5 years of employment. Seeking wrongful dismissal damages.",
  "province": "Ontario",
  "statute": "Employment Standards Act, 2000"
}'
```
---

### Update Case

Update case details.

**Endpoint:** `PUT /student/edit_case`

**Query Parameters:**
- `case_id` (string, required): The ID of the case

**Request Body:**
```json
{
  "case_title": "Employment Dispute - Updated",
  "case_description": "Updated description...",
  "case_type": "Employment Law",
  "status": "in_progress",
  "jurisdiction": ["Provincial", "Federal"],
  "province": "Ontario",
  "statute": "Employment Standards Act, 2000"
}
```

**Parameters:**
- `case_title` (string, required): Title of the case
- `case_description` (string, required): Detailed description (1-4000 characters)
- `case_type` (string, required): Broad area of law
- `status` (string, required): Case status (`in_progress`, `submitted`, `reviewed`, or `archived`)
- `jurisdiction` (array, required): Jurisdiction list
- `province` (string, required): Province/Territory
- `statute` (string, required): Relevant statute details

**Response:** `200 OK`

**Example (cURL):**
```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/edit_case?case_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{
  "case_title": "Employment Dispute - Updated",
  "case_description": "Updated description...",
  "case_type": "Employment Law",
  "status": "in_progress",
  "jurisdiction": [
    "Provincial",
    "Federal"
  ],
  "province": "Ontario",
  "statute": "Employment Standards Act, 2000"
}'
```

---

### Get Case Page

Get comprehensive case data including messages and summaries.

**Endpoint:** `GET /student/case_page`

**Query Parameters:**
- `case_id` (string, required): The case ID

**Response:**
```json
{
  "caseData": {
    "case_id": "uuid",
    "case_hash": "abc123def456",
    "case_title": "Employment Dispute",
    "status": "in_progress",
    "student_id": "uuid",
    "completed_blocks": ["intake"],
    "student_notes": "Student notes...",
    "jurisdiction": ["Provincial"],
    "province": "Ontario",
    "statute": "Employment Standards Act, 2000",
    "case_type": "Employment Law",
    "case_description": "Client was terminated...",
    "last_updated": "2024-01-20T14:22:00.000Z"
  },
  "messages": [
    {
      "message_id": "uuid",
      "message_content": "Great work on the intake section.",
      "time_sent": "2024-01-18T09:15:00.000Z",
      "instructor_id": "uuid",
      "first_name": "Jane",
      "last_name": "Smith"
    }
  ],
  "summaries": [
    {
      "summary_id": "uuid",
      "case_id": "uuid",
      "scope": "block",
      "block_context": "intake",
      "title": "Intake Facts Summary",
      "content": "Summary of intake facts...",
      "time_created": "2024-01-16T12:00:00.000Z"
    }
  ]
}
```

**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/case_page?case_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```


---

### Archive Case

Archive a case.

**Endpoint:** `PUT /student/archive_case`

**Query Parameters:**
- `case_id` (string, required): The case ID

**Response:** `200 OK`

**Example (cURL):**
```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/archive_case?case_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Unarchive Case

Unarchive a case.

**Endpoint:** `PUT /student/unarchive_case`

**Query Parameters:**
- `case_id` (string, required): The case ID

**Response:** `200 OK`

**Example (cURL):**
```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/unarchive_case?case_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Record Case View

Record that a student viewed a case (for analytics).

**Endpoint:** `PUT /student/view_case`

**Query Parameters:**
- `case_id` (string, required): The case ID

**Response:** `200 OK`

**Example (cURL):**
```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/view_case?case_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Submit Case for Review

Send a case to assigned instructors for review.

**Endpoint:** `PUT /student/review_case`

**Query Parameters:**
- `case_id` (string, required): The case ID

**Request Body (optional):**
```json
{
  "reviewer_ids": ["instructor-uuid-1", "instructor-uuid-2"]
}
```

**Response:** `200 OK`

**Example (cURL):**
```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/review_case?case_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{
  "reviewer_ids": [
    "instructor-uuid-1",
    "instructor-uuid-2"
  ]
}'
```
---

### List Cases

Get all cases for the authenticated student with server-side pagination, search, and status filtering.

**Endpoint:** `GET /student/get_cases`

**Query Parameters:**
- `page` (integer, optional): Page number for pagination, 0-indexed (default: 0)
- `limit` (integer, optional): Number of cases per page (default: 12)
- `search` (string, optional): Search term for case title, jurisdiction, or case ID
- `status` (string, optional): Filter by case status (`in_progress`, `submitted`, `reviewed`, `archived`)

**Response:**
```json
{
  "cases": [
    {
      "case_id": "uuid",
      "case_hash": "abc123def456",
      "case_title": "Employment Dispute",
      "status": "in_progress",
      "jurisdiction": ["Provincial"],
      "last_updated": "2024-01-20T14:22:00.000Z"
    }
  ],
  "totalCount": 5
}
```

**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/get_cases?page=0&limit=12&search=employment&status=in_progress" \
  -H "Authorization: eyJraWQiOiJ..."
```

## Notes Management

### Save/Update Notes

Save or update student notes for a case.

**Endpoint:** `PUT /student/notes`

**Query Parameters:**
- `case_id` (string, required): The case ID

**Request Body:**
```json
{
  "notes": "Key points to remember:\n- Client was employed for 5 years\n- No written warning before termination\n- Seeking 6 months severance"
}
```

**Response:** `200 OK`

**Example (cURL):**
```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/notes?case_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{
  "notes": "Key points to remember:\n- Client was employed for 5 years\n- No written warning before termination\n- Seeking 6 months severance"
}'
```

## Chat/Messaging

### Get Chat Messages

Get chat history for a case and section.

**Endpoint:** `GET /student/get_messages`

**Query Parameters:**
- `case_id` (string, required): ID of the case
- `sub_route` (string, required): The section/block type
  - Valid values: `intake-facts`, `legal-analysis`, `contrarian-analysis`, `policy-context`

**Response:**
```json
[
  {
    "type": "human",
    "content": "What are the key legal issues in this employment dispute?"
  },
  {
    "type": "ai",
    "content": "Based on the facts you've provided, the key legal issues include:\n1. Wrongful dismissal\n2. Notice period calculation\n3. Mitigation of damages"
  }
]
```

**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/get_messages?case_id=uuid&sub_route=intake-facts" \
  -H "Authorization: eyJraWQiOiJ..."
```
---

### Generate AI Response

Generate an AI response for a student message (synchronous, non-streaming).

**Note:** For real-time streaming responses, use the WebSocket API instead (see WebSocket documentation).

**Endpoint:** `POST /student/text_generation`

**Query Parameters:**
- `case_id` (string, required): ID of the case
- `sub_route` (string, required): The section/block type
  - Valid values: `intake-facts`, `legal-analysis`, `contrarian-analysis`, `policy-context`

**Request Body:**
```json
{
  "message_content": "What are the key legal issues in this case?"
}
```

**Response:**
```json
{
  "session_name": "Employment Dispute - Intake",
  "llm_output": "Based on the facts you've provided, the key legal issues include:\n1. Wrongful dismissal\n2. Notice period calculation\n3. Mitigation of damages"
}
```

**Example (cURL):**
```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/text_generation?case_id=uuid&sub_route=intake-facts" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{
  "message_content": "What are the key legal issues in this case?"
}'
```

## Progress Assessment

### Assess Progress

Assess student progress and potentially unlock the next block.

**Endpoint:** `POST /student/assess_progress`

**Request Body:**
```json
{
  "case_id": "uuid",
  "block_type": "intake"
}
```

**Parameters:**
- `case_id` (string, required): The case ID
- `block_type` (string, required): The block type to assess

**Response:**
```json
{
  "progress": 5,
  "reasoning": "You have done an excellent job gathering comprehensive facts and identifying the key parties. You are ready to move forward to issue identification.",
  "unlocked": true
}
```

**Response Fields:**
- `progress` (integer): Score from 0-5 (5 = ready to advance)
- `reasoning` (string): Feedback addressing the user directly
- `unlocked` (boolean): Whether the next block was unlocked

**Example (cURL):**
```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/assess_progress" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{
  "case_id": "uuid",
  "block_type": "intake"
}'
```

## Summary Management

### Generate Summary

Generate a summary for a case block or full case.

**Endpoint:** `GET /student/generate_summary`

**Query Parameters:**
- `case_id` (string, required): The case ID
- `sub_route` (string, optional): The block type to summarize (default: `full-case`)
  - Block types: `intake-facts`, `legal-analysis`, `contrarian-analysis`, `policy-context`
  - `full-case`: Stitches together existing block summaries

**Response:**
```json
{
  "llm_output": "## Intake Facts Summary\n\nThe client was employed for 5 years before being terminated without cause. Key facts include:\n- No written warnings\n- Strong performance reviews\n- Seeking 6 months severance"
}
```

**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/generate_summary?case_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```
---

### Get Summaries

Get all summaries for a case.

**Endpoint:** `GET /student/get_summaries`

**Query Parameters:**
- `case_id` (string, required): The case ID

**Response:**
```json
[
  {
    "summary_id": "uuid",
    "case_id": "uuid",
    "content": "## Intake Facts Summary\n\nThe client was employed...",
    "scope": "block",
    "block_context": "intake",
    "title": "Intake Facts Summary",
    "time_created": "2024-01-16T12:00:00.000Z"
  }
]
```

**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/get_summaries?case_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Delete Summary

Delete a summary.

**Endpoint:** `DELETE /student/delete_summary`

**Query Parameters:**
- `summary_id` (integer, required): The ID of the summary to delete

**Response:**
```json
{
  "message": "Summary deleted successfully"
}
```



**Example (cURL):**
```bash
curl -X DELETE "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/delete_summary?summary_id=1" \
  -H "Authorization: eyJraWQiOiJ..."
```

## Feedback

### Get Feedback

Get all feedback messages for a case.

**Endpoint:** `GET /student/feedback`

**Query Parameters:**
- `case_id` (string, required): The case ID

**Response:**
```json
[
  {
    "message_id": "uuid",
    "message_content": "Great work on identifying the key legal issues. Consider exploring the jurisdiction's specific statutes on employment law.",
    "time_sent": "2024-01-20T14:22:00.000Z",
    "first_name": "Jane",
    "last_name": "Smith"
  }
]
```

**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/feedback?case_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

## Audio Transcription

### Generate Presigned URL

Generate an S3 presigned URL for audio file upload.

**Endpoint:** `GET /student/generate_presigned_url`

**Query Parameters:**
- `audio_file_id` (string, required): Unique ID for the audio file
- `file_name` (string, required): Name of the file
- `file_type` (string, required): MIME type (e.g., `audio/mpeg`, `audio/wav`)

**Response:**
```json
{
  "presignedurl": "https://s3.amazonaws.com/bucket/path?signature=..."
}
```

**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/generate_presigned_url?audio_file_id=uuid&file_name=interview.mp3&file_type=audio/mpeg" \
  -H "Authorization: eyJraWQiOiJ..."
```
---

### Initialize Audio File

Initialize an audio file record in the database.

**Endpoint:** `POST /student/initialize_audio_file`

**Query Parameters:**
- `audio_file_id` (string, required): The audio file ID
- `s3_file_path` (string, required): S3 path to the file
- `case_id` (string, required): The case ID
- `title` (string, required): Title for the audio file

**Response:** `200 OK`

**Example (cURL):**
```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/initialize_audio_file?audio_file_id=uuid&s3_file_path=audio/uuid.mp3&case_id=uuid&title=Client Interview" \
  -H "Authorization: eyJraWQiOiJ..."
```
---

### Trigger Audio Transcription

Trigger AWS Transcribe to transcribe an audio file.

**Note:** Transcription results are delivered via WebSocket notification when complete.

**Endpoint:** `GET /student/audio_to_text`

**Query Parameters:**
- `audio_file_id` (string, required): The audio file ID
- `file_name` (string, required): Name of the file
- `file_type` (string, required): File type (e.g., `mp3`, `wav`, `m4a`)
- `case_title` (string, required): Title of the case
- `case_id` (string, required): The case ID

**Response:** `200 OK` (transcription starts asynchronously)

**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/audio_to_text?audio_file_id=uuid&file_name=interview.mp3&file_type=audio/mpeg&case_title=Employment Dispute&case_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```
---

### Get Transcriptions

Get all transcriptions for a case.

**Endpoint:** `GET /student/get_transcriptions`

**Query Parameters:**
- `case_id` (string, required): The case ID

**Response:**
```json
[
  {
    "audio_file_id": "uuid",
    "file_title": "Client Interview",
    "timestamp": "2024-01-16T15:30:00.000Z"
  }
]
```



**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/get_transcriptions?case_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

## User Settings

### Get Assigned Instructors

Get all instructors assigned to the authenticated student.

**Endpoint:** `GET /student/instructors`

**Query Parameters:**
- `user_id` (string, required): The student's user ID

**Response:**
```json
[
  {
    "instructor_name": "Jane Smith"
  }
]
```

**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/instructors?user_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Disclaimer

Get the active disclaimer and user's acceptance status.

**Endpoint:** `GET /student/get_disclaimer`

**Query Parameters:** None

**Response:**
```json
{
  "disclaimer_text": "This is a legal disclaimer...",
  "last_updated": "2024-01-15T10:30:00.000Z",
  "has_accepted": false
}
```

**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/get_disclaimer" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Accept Disclaimer

Mark the disclaimer as accepted by the user.

**Endpoint:** `PUT /student/accept_disclaimer`

**Query Parameters:** None

**Request Body:** None

**Response:** `200 OK`

**Example (cURL):**
```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/accept_disclaimer" \
  -H "Authorization: eyJraWQiOiJ..."
```
---

### Get File Size Limit

Get the current audio file size limit.

**Endpoint:** `GET /student/file_size_limit`

**Query Parameters:** None

**Response:**
```json
{
  "value": "500"
}
```

**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/file_size_limit" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Role Labels

Get configurable role display labels.

**Endpoint:** `GET /student/role_labels`

**Query Parameters:** None

**Response:**
```json
{
  "student": {
    "singular": "Advocate",
    "plural": "Advocates"
  },
  "instructor": {
    "singular": "Supervisor",
    "plural": "Supervisors"
  },
  "admin": {
    "singular": "Administrator",
    "plural": "Administrators"
  }
}
```

---


---


# Instructor Endpoints

Instructor endpoints require the user to have the `instructor` role in the database. The instructor authorizer validates this role before allowing access to any `/instructor/*` endpoint.


**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/role_labels" \
  -H "Authorization: eyJraWQiOiJ..."
```

## Student Management

### View Student Cases

Get all cases for students assigned to the instructor with server-side pagination, search, and status filtering.

**Endpoint:** `GET /instructor/view_students`

**Query Parameters:**
- `page` (integer, optional): Page number for pagination, 0-indexed (default: 0)
- `limit` (integer, optional): Number of cases per page (default: 12)
- `search` (string, optional): Search term for case title, student name, jurisdiction, or case ID
- `status` (string, optional): Filter by case status (`in_progress`, `submitted`, `reviewed`, `archived`)

**Response:**
```json
{
  "cases": [
    {
      "case_id": "uuid",
      "case_title": "Employment Dispute",
      "student_id": "uuid",
      "first_name": "John",
      "last_name": "Doe",
      "status": "in_progress",
      "time_created": "2024-01-15T10:30:00.000Z",
      "last_updated": "2024-01-20T14:22:00.000Z"
    }
  ],
  "totalCount": 15
}
```

**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/view_students?page=0&limit=12&search=john&status=submitted" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Instructor Name

Get the name of an instructor by email.

**Endpoint:** `GET /instructor/name`

**Query Parameters:**
- `user_email` (string, required): The email of the instructor

**Response:**
```json
{
  "name": "Jane Smith"
}
```

**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/name?user_email=user@example.com" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### List Assigned Students

Get all students assigned to the authenticated instructor.

**Endpoint:** `GET /instructor/students`

**Query Parameters:** None

**Response:**
```json
[
  {
    "student_id": "uuid",
    "first_name": "John",
    "last_name": "Doe"
  }
]
```

**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/students" \
  -H "Authorization: eyJraWQiOiJ..."
```

## Case Review

### List Cases Pending Review

Get all cases that have been submitted for review.

**Endpoint:** `GET /instructor/cases_to_review`

**Query Parameters:** None

**Response:**
```json
[
  {
    "case_id": "uuid",
    "case_title": "Employment Dispute",
    "student_id": "uuid",
    "student_name": "John Doe",
    "submitted_at": "2024-01-20T14:22:00.000Z"
  }
]
```



**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/cases_to_review" \
  -H "Authorization: eyJraWQiOiJ..."
```

## Feedback Management

### Send Feedback

Send feedback on a student's case.

**Endpoint:** `PUT /instructor/send_feedback`

**Query Parameters:**
- `case_id` (string, required): The case ID
- `instructor_id` (string, required): The instructor's user ID

**Request Body:**
```json
{
  "message_content": "Great work on identifying the key legal issues. Consider exploring the jurisdiction's specific statutes on employment law."
}
```

**Response:** `200 OK`

**Example (cURL):**
```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/send_feedback?case_id=uuid&instructor_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{
  "message_content": "Great work on identifying the key legal issues. Consider exploring specific statutes on employment law."
}'
```
---

### Delete Feedback

Delete a feedback message.

**Endpoint:** `DELETE /instructor/delete_feedback`

**Query Parameters:**
- `message_id` (string, required): The ID of the feedback message to delete

**Response:**
```json
{
  "message": "Feedback deleted successfully"
}
```

**Example (cURL):**
```bash
curl -X DELETE "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/delete_feedback?message_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

## Case Management

### Archive Case

Archive a student's case.

**Endpoint:** `PUT /instructor/archive_case`

**Query Parameters:**
- `case_id` (string, required): The ID of the case to archive

**Response:**
```json
{
  "message": "Case archived successfully"
}
```

**Example (cURL):**
```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/archive_case?case_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```
---

### Unarchive Case

Unarchive a student's case.

**Endpoint:** `PUT /instructor/unarchive_case`

**Query Parameters:**
- `case_id` (string, required): The ID of the case to unarchive

**Response:**
```json
{
  "message": "Case unarchived successfully"
}
```

---

# Admin Endpoints

Admin endpoints require the user to have the `admin` role in the database. The admin authorizer validates this role before allowing access to any `/admin/*` endpoint.


**Example (cURL):**
```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/unarchive_case?case_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

## User Management

### Update User Role

Add or remove a single role from a user.

**Endpoint:** `PUT /admin/user_role`

**Request Body:**
```json
{
  "email": "user@example.com",
  "operation": "add",
  "role": "instructor"
}
```

**Parameters:**
- `email` (string, required): User's email address
- `operation` (string, required): Either `add` or `remove`
- `role` (string, required): Role to add/remove (`admin`, `instructor`, or `student`)

**Response:** `200 OK`

**Example (cURL):**
```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/user_role" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{
  "email": "user@example.com",
  "operation": "add",
  "role": "instructor"
}'
```
---

### Assign Instructor to Student

Create an instructor-student relationship.

**Endpoint:** `POST /admin/assign_instructor_to_student`

**Request Body:**
```json
{
  "instructor_id": "instructor-uuid",
  "student_id": "student-uuid"
}
```

**Response:** `200 OK`

**Example (cURL):**
```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/assign_instructor_to_student" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{
  "instructor_id": "instructor-uuid",
  "student_id": "student-uuid"
}'
```
---

### Remove Instructor Assignment

Remove an instructor-student relationship.

**Endpoint:** `DELETE /admin/assign_instructor_to_student`

**Query Parameters:**
- `instructor_id` (string, required): Instructor's user ID
- `student_id` (string, required): Student's user ID

**Response:** `200 OK`

**Example (cURL):**
```bash
curl -X DELETE "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/assign_instructor_to_student?instructor_id=uuid&student_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```
---

### Get Instructor's Students

Get all students assigned to a specific instructor.

**Endpoint:** `GET /admin/instructorStudents`

**Query Parameters:**
- `instructor_id` (string, required): The instructor's user ID

**Response:**
```json
[
  {
    "user_id": "uuid",
    "first_name": "John",
    "last_name": "Doe",
    "user_email": "john.doe@example.com"
  }
]
```

**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/instructorStudents?instructor_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```


---

### List All Users

Get a paginated list of all users with optional search and role filtering.

**Endpoint:** `GET /admin/users`

**Query Parameters:**
- `page` (integer, optional): Page number for pagination (default: 0)
- `limit` (integer, optional): Number of items per page (default: 10)
- `search` (string, optional): Search term for first name, last name, or email
- `role` (string, optional): Filter by role (`admin`, `instructor`, `student`, or `all`)

**Response:**
```json
{
  "users": [
    {
      "user_id": "uuid",
      "first_name": "John",
      "last_name": "Doe",
      "user_email": "john.doe@example.com",
      "roles": ["student"],
      "time_account_created": "2024-01-15T10:30:00.000Z",
      "last_sign_in": "2024-01-20T14:22:00.000Z"
    }
  ],
  "totalCount": 42
}
```

**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/users" \
  -H "Authorization: eyJraWQiOiJ..."
```
---

### List All Instructors

Get a list of all users with the instructor role.

**Endpoint:** `GET /admin/instructors`

**Query Parameters:** None

**Response:**
```json
[
  {
    "user_id": "uuid",
    "first_name": "Jane",
    "last_name": "Smith",
    "user_email": "jane.smith@example.com"
  }
]
```

**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/instructors" \
  -H "Authorization: eyJraWQiOiJ..."
```
---

### List All Students

Get a list of all users with the student role.

**Endpoint:** `GET /admin/students`

**Query Parameters:** None

**Response:**
```json
[
  {
    "user_id": "uuid",
    "first_name": "John",
    "last_name": "Doe",
    "user_email": "john.doe@example.com"
  }
]
```



**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/students" \
  -H "Authorization: eyJraWQiOiJ..."
```

## Prompt Management

### Get Active Prompts Only

Get only the currently active prompt versions.

**Endpoint:** `GET /admin/prompt/active`

**Query Parameters:** None

**Response:**
```json
[
  {
    "prompt_version_id": "uuid",
    "category": "reasoning",
    "prompt_scope": "block",
    "block_type": "intake",
    "version_number": 1,
    "version_name": "Initial Version",
    "prompt_text": "You are a helpful legal assistant...",
    "time_created": "2024-01-15T10:30:00.000Z"
  }
]
```

**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/prompt/active" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Create Prompt Version

Create a new prompt version.

**Endpoint:** `POST /admin/prompt`

**Request Body:**
```json
{
  "category": "summary",
  "prompt_scope": "full_case",
  "block_type": null,
  "prompt_text": "Synthesize all block summaries into one full-case legal summary...",
  "version_name": "Full Case Synthesis v1",
  "author_id": "uuid"
}
```

```json
{
  "category": "summary",
  "prompt_scope": "block",
  "block_type": "intake",
  "prompt_text": "Generate an intake summary from interview notes...",
  "version_name": "Intake Summary v2",
  "author_id": "uuid"
}
```

**Parameters:**
- `category` (string, required): Prompt category (`reasoning`, `assessment`, or `summary`)
- `prompt_scope` (string, optional): Prompt scope (`block` or `full_case`). Defaults to `block`.
- `block_type` (string, conditionally required): Required when `prompt_scope=block`; omit/null when `prompt_scope=full_case`
- `prompt_text` (string, required): The prompt content
- `version_name` (string, optional): Human-friendly version name
- `author_id` (string, optional): Author's user ID

**Response:**
```json
{
  "prompt_version_id": "uuid",
  "category": "summary",
  "prompt_scope": "full_case",
  "block_type": null,
  "version_number": 2,
  "version_name": "Full Case Synthesis v1",
  "prompt_text": "Synthesize all block summaries into one full-case legal summary...",
  "author_id": "uuid",
  "is_active": false
}
```

**Example (cURL):**
```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/prompt" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{
  "category": "summary",
  "prompt_scope": "full_case",
  "block_type": null,
  "prompt_text": "Synthesize all block summaries into one full-case legal summary...",
  "version_name": "Full Case Synthesis v1",
  "author_id": "uuid"
}'
```


---

### Update Prompt Version

Update an existing prompt version.

**Endpoint:** `PUT /admin/prompt`

**Request Body:**
```json
{
  "prompt_version_id": "2",
  "prompt_text": "Updated prompt text...",
  "version_name": "Version 2.1"
}
```

**Parameters:**
- `prompt_version_id` (string, required): The ID of the prompt version to update
- `prompt_text` (string, required): Updated prompt content
- `version_name` (string, required): Updated version name

**Response:** `200 OK`

**Example (cURL):**
```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/prompt" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{
  "prompt_version_id": "2",
  "prompt_text": "Updated prompt text...",
  "version_name": "Version 2.1"
}'
```

---

### Activate Prompt Version

Set a prompt version as the active version for its scope slot.

- For `prompt_scope=block`: one active prompt per `(category, block_type)`.
- For `prompt_scope=full_case`: one active prompt per `category`.

**Endpoint:** `POST /admin/prompt/activate`

**Request Body:**
```json
{
  "prompt_version_id": 2
}
```

**Response:**
```json
{
  "message": "Prompt activated successfully",
  "category": "summary",
  "prompt_scope": "full_case",
  "block_type": null
}
```

**Example (cURL):**
```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/prompt/activate" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{
  "prompt_version_id": 2
}'
```

---

### Delete Prompt Version

Delete a prompt version (cannot delete active prompts).

**Endpoint:** `DELETE /admin/prompt`

**Query Parameters:**
- `prompt_version_id` (integer, required): The ID of the prompt version to delete

**Response:**
```json
{
  "message": "Prompt deleted successfully",
  "category": "summary",
  "prompt_scope": "full_case",
  "block_type": null
}
```

**Example (cURL):**
```bash
curl -X DELETE "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/prompt?prompt_version_id=1" \
  -H "Authorization: eyJraWQiOiJ..."
```
---

### List All Prompt Versions

Get all prompt versions across all categories and block types.

**Endpoint:** `GET /admin/prompt`

**Query Parameters:**
- `category` (string, optional): Filter by prompt category
- `block_type` (string, optional): Filter by block type (for block-scope prompts)
- `prompt_scope` (string, optional): Filter by scope (`block` or `full_case`)

**Response:**
```json
[
  {
    "prompt_version_id": "uuid",
    "category": "reasoning",
    "prompt_scope": "block",
    "block_type": "intake",
    "version_number": 1,
    "version_name": "Initial Version",
    "prompt_text": "You are a helpful legal assistant...",
    "author_id": "uuid",
    "time_created": "2024-01-15T10:30:00.000Z",
    "is_active": true
  }
]
```

**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/prompt" \
  -H "Authorization: eyJraWQiOiJ..."
```

**Example (full-case summary prompt):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/prompt?category=summary&prompt_scope=full_case" \
  -H "Authorization: eyJraWQiOiJ..."
```

## AI Configuration

### Get AI Configuration

Retrieve current AI model configuration parameters.

**Endpoint:** `GET /admin/ai_config`

**Query Parameters:** None

**Response:**
```json
{
  "bedrock_llm_id": "meta.llama3-70b-instruct-v1:0",
  "model_options": [
    {
      "label": "Claude Sonnet 5.5",
      "value": "us.anthropic.claude-sonnet-5-5",
      "constraints": {
        "maxOutputTokens": 128000,
        "defaultMaxOutputTokens": 4096,
        "temperatureRange": [0, 1.0],
        "topPRange": [0, 1.0]
      }
    },
    {
      "label": "Llama 3 70b Instruct",
      "value": "meta.llama3-70b-instruct-v1:0",
      "constraints": {
        "maxOutputTokens": 8192,
        "defaultMaxOutputTokens": 2000,
        "temperatureRange": [0, 1.0],
        "topPRange": [0, 1.0]
      }
    }
  ],
  "temperature": "0.7",
  "top_p": "0.9",
  "max_tokens": "2048",
  "message_limit": "50",
  "file_size_limit": "500"
}
```

**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/ai_config" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Update AI Configuration

Update AI model configuration parameters.

**Endpoint:** `POST /admin/ai_config`

**Request Body:**
```json
{
  "bedrock_llm_id": "meta.llama3-70b-instruct-v1:0",
  "temperature": 0.7,
  "top_p": 0.9,
  "max_tokens": 2048,
  "message_limit": "50",
  "file_size_limit": "500"
}
```

**Parameters:**
- `bedrock_llm_id` (string, optional): AWS Bedrock model ID
- `temperature` (number, optional): Controls randomness (0.0 to 1.0)
- `top_p` (number, optional): Controls diversity (0.0 to 1.0)
- `max_tokens` (integer, optional): Maximum tokens in response (minimum: 1)
- `message_limit` (string, optional): Daily message limit per user (>= 10 or "Infinity")
- `file_size_limit` (string, optional): Max audio file size in MB (1-500)

**Validation note:** If `bedrock_llm_id` is provided, it must match one of the configured model options. If `temperature`, `top_p`, or `max_tokens` are provided, they are validated against the selected model's `constraints`.

**Model constraints note:** `max_tokens` is the maximum output tokens. It does not limit input tokens.

**Response:** `200 OK`

**Example (cURL):**
```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/ai_config" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{
  "bedrock_llm_id": "meta.llama3-70b-instruct-v1:0",
  "temperature": 0.7,
  "top_p": 0.9,
  "max_tokens": 2048,
  "message_limit": "50",
  "file_size_limit": "500"
}'
```
---

### Get Message Limit

Get the current daily message limit.

**Endpoint:** `GET /admin/message_limit`

**Query Parameters:** None

**Response:**
```json
{
  "value": "50"
}
```

**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/message_limit" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Update Message Limit

Update the daily message limit per user.

**Endpoint:** `PUT /admin/message_limit`

**Request Body:**
```json
{
  "limit": "100"
}
```

**Parameters:**
- `limit` (string, required): Message limit value (number >= 10 or "Infinity")

**Response:** `200 OK`

**Example (cURL):**
```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/message_limit" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{
  "limit": "100"
}'
```


---

### Get File Size Limit

Get the current audio file size limit.

**Endpoint:** `GET /admin/file_size_limit`

**Query Parameters:** None

**Response:**
```json
{
  "value": "500"
}
```

**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/file_size_limit" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Update File Size Limit

Update the audio file size limit.

**Endpoint:** `POST /admin/file_size_limit`

**Request Body:**
```json
{
  "value": "500"
}
```

**Parameters:**
- `value` (string, required): File size limit in MB (1-500)

**Response:** `200 OK`


**Example (cURL):**
```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/file_size_limit" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{
  "value": "500"
}'
```

## Disclaimer Management

### Create Disclaimer Version

Create a new disclaimer version.

**Endpoint:** `POST /admin/disclaimer`

**Request Body:**
```json
{
  "disclaimer_text": "This is a legal disclaimer...",
  "version_name": "Version 2.0",
  "author_id": "uuid"
}
```

**Parameters:**
- `disclaimer_text` (string, required): The disclaimer content
- `version_name` (string, optional): Human-friendly version name
- `author_id` (string, optional): Author's user ID

**Response:** `200 OK`

**Example (cURL):**
```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/disclaimer" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{
  "disclaimer_text": "This is a legal disclaimer...",
  "version_name": "Version 2.0",
  "author_id": "uuid"
}'
```

---

### Update Disclaimer Version

Update an existing disclaimer version.

**Endpoint:** `PUT /admin/disclaimer`

**Request Body:**
```json
{
  "disclaimer_id": "uuid",
  "disclaimer_text": "Updated disclaimer text...",
  "version_name": "Version 2.1"
}
```

**Response:** `200 OK`

**Example (cURL):**
```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/disclaimer" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{
  "disclaimer_id": "uuid",
  "disclaimer_text": "Updated disclaimer text...",
  "version_name": "Version 2.1"
}'
```


---

### Activate Disclaimer Version

Set a disclaimer version as the active version.

**Endpoint:** `POST /admin/disclaimer/activate`

**Request Body:**
```json
{
  "disclaimer_id": "uuid"
}
```

**Response:**
```json
{
  "message": "Disclaimer activated successfully"
}
```

**Example (cURL):**
```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/disclaimer/activate" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{
  "disclaimer_id": "uuid"
}'
```

---

### Delete Disclaimer Version

Delete a disclaimer version (cannot delete active disclaimer).

**Endpoint:** `DELETE /admin/disclaimer`

**Query Parameters:**
- `disclaimer_id` (string, required): The ID of the disclaimer version to delete

**Response:**
```json
{
  "message": "Disclaimer deleted successfully"
}
```

**Example (cURL):**
```bash
curl -X DELETE "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/disclaimer?disclaimer_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### List All Disclaimer Versions

Get all disclaimer versions.

**Endpoint:** `GET /admin/disclaimer`

**Query Parameters:** None

**Response:**
```json
[
  {
    "disclaimer_id": "uuid",
    "disclaimer_text": "This is a legal disclaimer...",
    "version_number": 1,
    "version_name": "Initial Version",
    "author_id": "uuid",
    "author_name": "John Doe",
    "time_created": "2024-01-15T10:30:00.000Z",
    "last_updated": "2024-01-15T10:30:00.000Z",
    "is_active": true
  }
]
```


**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/disclaimer" \
  -H "Authorization: eyJraWQiOiJ..."
```

## Role Label Configuration

### Update Role Labels

Update configurable role display labels for the UI.

**Endpoint:** `PUT /admin/role_labels`

**Request Body:**
```json
{
  "student": {
    "singular": "Advocate",
    "plural": "Advocates"
  },
  "instructor": {
    "singular": "Supervisor",
    "plural": "Supervisors"
  },
  "admin": {
    "singular": "Administrator",
    "plural": "Administrators"
  }
}
```

**Parameters:**
- Each role requires `singular` and `plural` labels (max 64 characters each)

**Response:**
```json
{
  "message": "Role labels updated successfully"
}
```

**Example (cURL):**
```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/role_labels" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{
  "student": {
    "singular": "Advocate",
    "plural": "Advocates"
  },
  "instructor": {
    "singular": "Supervisor",
    "plural": "Supervisors"
  },
  "admin": {
    "singular": "Administrator",
    "plural": "Administrators"
  }
}'
```

---

## Signup Access Configuration

### Get Signup Mode

Retrieve the current signup mode from SSM.

**Endpoint:** `GET /admin/signup_mode`

**Query Parameters:** None

**Response:**
```json
{
  "mode": "public"
}
```

*Modes: `public` (anyone can sign up) or `whitelist` (only whitelisted emails can sign up).*

**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/signup_mode" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Update Signup Mode

Set the signup mode in SSM.

**Endpoint:** `PUT /admin/signup_mode`

**Request Body:**
```json
{
  "mode": "whitelist"
}
```

**Parameters:**
- `mode` (string, required): Either `public` or `whitelist`.

**Response:**
```json
{
  "mode": "whitelist"
}
```

**Example (cURL):**
```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/signup_mode" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{
  "mode": "whitelist"
}'
```

---

### Get Whitelist Entries

Retrieve all emails currently in the whitelist.

**Endpoint:** `GET /admin/whitelist`

**Query Parameters:** None

**Response:**
```json
{
  "count": 1,
  "entries": [
    {
      "email": "student@example.com",
      "canonical_role": "student",
      "uploaded_label": "Law Student"
    }
  ]
}
```

**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/whitelist" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Upload Whitelist CSV

Generate a presigned upload URL, upload your CSV to S3, then process it into whitelist entries.

**Endpoint:** `GET /admin/whitelist/upload`

**Query Parameters:** None

**Response:**
```json
{
  "uploadUrl": "https://bucket.s3.ca-central-1.amazonaws.com/whitelist-1711122334455.csv?...",
  "s3Key": "whitelist-1711122334455.csv",
  "expiresIn": 3600
}
```

**Example (cURL):**
```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/whitelist/upload" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Process Whitelist CSV

Parse and apply an uploaded CSV to the whitelist.

**Endpoint:** `POST /admin/whitelist/upload`

**Request Body:**
```json
{
  "s3Key": "whitelist-1711122334455.csv"
}
```

**Request Body Parameters:**
- `s3Key` (string, required): Key of a CSV previously uploaded to S3 using the presigned URL

**CSV Format:**
- Column 1: Email address
- Column 2: Role (either canonical name or singular label defined in Role Label Configuration)
- Header row is optional (skipped if second column is literally "role")

**Response:**
```json
{
  "processed": 2,
  "invalid": 0,
  "invalidRows": []
}
```

**Example (cURL):**
```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/whitelist/upload" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{
  "s3Key": "whitelist-1234567891022.csv"
}'
```

---

### Delete Whitelist Entry

Remove an email from the whitelist.

**Endpoint:** `DELETE /admin/whitelist`

**Query Parameters:**
- `email` (string, required): The email to remove

**Response:**
```json
{
  "message": "Entry removed",
  "email": "student1@example.com"
}
```

**Example (cURL):**
```bash
curl -X DELETE "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/whitelist?email=student1@example.com" \
  -H "Authorization: eyJraWQiOiJ..."
```

---


## Complete Usage Examples

### Complete Case Creation Flow (JavaScript)

```javascript
import { fetchAuthSession } from "aws-amplify/auth";

// 1. Get authentication token
const session = await fetchAuthSession();
const token = session.tokens?.idToken?.toString();
const userId = session.tokens?.idToken?.payload?.sub;

// 2. Create a new case
const createResponse = await fetch(
  `${API_ENDPOINT}/student/new_case?user_id=${userId}`,
  {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      case_title: "Employment Dispute",
      case_type: "Employment Law",
      jurisdiction: ["Provincial"],
      case_description: "Client was terminated without cause after 5 years of employment.",
      province: "Ontario",
      statute: "Employment Standards Act, 2000",
    }),
  }
);

const { case_id } = await createResponse.json();

// 3. Send a message to the AI assistant
const messageResponse = await fetch(
  `${API_ENDPOINT}/student/text_generation?case_id=${case_id}&sub_route=intake-facts`,
  {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message_content: "What are the key legal issues in this case?",
    }),
  }
);

const { llm_output } = await messageResponse.json();
console.log("AI Response:", llm_output);

// 4. Get chat history
const messagesResponse = await fetch(
  `${API_ENDPOINT}/student/get_messages?case_id=${case_id}&sub_route=intake-facts`,
  {
    headers: { Authorization: token },
  }
);

const messages = await messagesResponse.json();
console.log("Chat History:", messages);

// 5. Generate a summary
const summaryResponse = await fetch(
  `${API_ENDPOINT}/student/generate_summary?case_id=${case_id}&sub_route=intake-facts`,
  {
    headers: { Authorization: token },
  }
);

const summary = await summaryResponse.json();
console.log("Summary:", summary.llm_output);
```


---

### Complete Case Creation Flow (Python)

```python
import requests

API_ENDPOINT = "https://api-id.execute-api.us-east-1.amazonaws.com/prod"
token = "eyJraWQiOiJ..."  # Cognito ID token

# 1. Create a new case
create_response = requests.post(
    f"{API_ENDPOINT}/student/new_case",
    params={"user_id": "cognito-user-uuid"},
    headers={"Authorization": token},
    json={
        "case_title": "Employment Dispute",
        "case_type": "Employment Law",
        "jurisdiction": ["Provincial"],
        "case_description": "Client was terminated without cause after 5 years.",
        "province": "Ontario",
        "statute": "Employment Standards Act, 2000"
    }
)
case_id = create_response.json()["case_id"]

# 2. Send a message to the AI assistant
message_response = requests.post(
    f"{API_ENDPOINT}/student/text_generation",
    params={"case_id": case_id, "sub_route": "intake-facts"},
    headers={"Authorization": token},
    json={"message_content": "What are the key legal issues?"}
)
print("AI Response:", message_response.json()["llm_output"])

# 3. Assess progress
assess_response = requests.post(
    f"{API_ENDPOINT}/student/assess_progress",
    headers={"Authorization": token},
    json={"case_id": case_id, "block_type": "intake"}
)
assessment = assess_response.json()
print(f"Progress: {assessment['progress']}/5")
print(f"Feedback: {assessment['reasoning']}")

# 4. Generate a summary
summary_response = requests.get(
    f"{API_ENDPOINT}/student/generate_summary",
    params={"case_id": case_id, "sub_route": "intake-facts"},
    headers={"Authorization": token}
)
print("Summary:", summary_response.json()["llm_output"])

# 5. Submit for review
requests.put(
    f"{API_ENDPOINT}/student/review_case",
    params={"case_id": case_id},
    headers={"Authorization": token},
    json={"reviewer_ids": ["instructor-uuid"]}
)
```

---

### Audio Upload and Transcription Flow (JavaScript)

```javascript
// 1. Generate presigned URL
const audioFileId = crypto.randomUUID();
const urlResponse = await fetch(
  `${API_ENDPOINT}/student/generate_presigned_url?audio_file_id=${audioFileId}&file_name=interview.mp3&file_type=audio/mpeg`,
  { headers: { Authorization: token } }
);
const { presignedurl } = await urlResponse.json();

// 2. Upload file to S3
await fetch(presignedurl, {
  method: "PUT",
  body: audioFile,
  headers: { "Content-Type": "audio/mpeg" },
});

// 3. Initialize audio file record
await fetch(
  `${API_ENDPOINT}/student/initialize_audio_file?audio_file_id=${audioFileId}&s3_file_path=audio/${audioFileId}.mp3&case_id=${caseId}&title=Client Interview`,
  { method: "POST", headers: { Authorization: token } }
);

// 4. Trigger transcription (results delivered via WebSocket)
await fetch(
  `${API_ENDPOINT}/student/audio_to_text?audio_file_id=${audioFileId}&file_name=interview&file_type=mp3&case_title=Employment Dispute&case_id=${caseId}`,
  { headers: { Authorization: token } }
);
```

---

### Admin User Management Flow (JavaScript)

```javascript
// 1. List all users with search and filtering
const usersResponse = await fetch(
  `${API_ENDPOINT}/admin/users?page=0&limit=20&search=john&role=student`,
  { headers: { Authorization: token } }
);
const { users, totalCount } = await usersResponse.json();

// 2. Add instructor role to a user
await fetch(`${API_ENDPOINT}/admin/user_role`, {
  method: "PUT",
  headers: {
    Authorization: token,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    email: "john.doe@example.com",
    operation: "add",
    role: "instructor",
  }),
});

// 3. Get all instructors
const instructorsResponse = await fetch(
  `${API_ENDPOINT}/admin/instructors`,
  { headers: { Authorization: token } }
);
const instructors = await instructorsResponse.json();

// 4. Assign instructor to student
await fetch(`${API_ENDPOINT}/admin/assign_instructor_to_student`, {
  method: "POST",
  headers: {
    Authorization: token,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    instructor_id: instructors[0].user_id,
    student_id: users[0].user_id,
  }),
});

// 5. Get students assigned to instructor
const studentsResponse = await fetch(
  `${API_ENDPOINT}/admin/instructorStudents?instructor_id=${instructors[0].user_id}`,
  { headers: { Authorization: token } }
);
const assignedStudents = await studentsResponse.json();
```

---

### Instructor Feedback Flow (Python)

```python
# 1. Get cases pending review
cases_response = requests.get(
    f"{API_ENDPOINT}/instructor/cases_to_review",
    headers={"Authorization": token}
)
cases = cases_response.json()

# 2. Send feedback on a case
case_id = cases[0]["case_id"]
requests.put(
    f"{API_ENDPOINT}/instructor/send_feedback",
    params={
        "case_id": case_id,
        "instructor_id": instructor_id
    },
    headers={"Authorization": token},
    json={
        "message_content": "Great work on identifying the key legal issues. Consider exploring the jurisdiction's specific statutes on employment law."
    }
)

# 3. Archive the case after review
requests.put(
    f"{API_ENDPOINT}/instructor/archive_case",
    params={"case_id": case_id},
    headers={"Authorization": token}
)
```

---


## Rate Limiting

The API implements rate limiting at multiple levels:

---

### WAF Rate Limiting

- **Per IP**: 2000 requests per 5 minutes
- **Per User**: 200 requests per 5 minutes (based on Authorization header)

---

### Application Rate Limiting

- **Daily Message Limit**: Configurable per-user daily message limit (default: 50 messages)
  - Applies to AI chat interactions
  - Returns `429 Too Many Requests` when exceeded
  - Resets daily at midnight UTC

---

### Best Practices

- Implement exponential backoff for retries
- Cache responses when appropriate
- Use WebSocket for real-time streaming instead of polling
- Monitor rate limit headers in responses

## Security Considerations

### Token Management

- ID tokens expire after 1 hour
- Use refresh tokens to obtain new ID tokens
- Never expose tokens in logs or client-side code
- Store tokens securely (use AWS Amplify for automatic secure storage)

---

### CORS

All endpoints support CORS with the following headers:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: *`
- `Access-Control-Allow-Headers: Content-Type,X-Amz-Date,Authorization,X-Api-Key`

---

### Security Headers

All responses include security headers:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Content-Security-Policy: default-src 'none'; frame-ancestors 'none';`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`

---

### Input Validation

- All request bodies are validated against schemas
- Query parameters are type-checked
- File uploads are validated for size and type
- PII detection via AWS Bedrock Guardrails

## WebSocket API

For real-time streaming AI responses, notifications, and bidirectional communication, use the WebSocket API. See the [WebSocket Implementation Guide](.kiro/steering/Websocket.md) for detailed documentation.

**WebSocket URL:**
```
wss://{websocket-api-id}.execute-api.{region}.amazonaws.com/prod
```

**Key Features:**
- Real-time AI chat streaming
- Progress assessment with streaming feedback
- Summary generation with streaming output
- Audio transcription status updates
- Real-time notifications


## Troubleshooting

### Common Errors

#### 401 Unauthorized

**Cause:** Missing or invalid JWT token

**Solution:**
- Verify token is included in `Authorization` header
- Check token hasn't expired (1 hour lifetime)
- Refresh token using AWS Amplify

```javascript
import { fetchAuthSession } from "aws-amplify/auth";

const session = await fetchAuthSession({ forceRefresh: true });
const token = session.tokens?.idToken?.toString();
```

#### 403 Forbidden

**Cause:** User doesn't have the required role in the database

**Solution:**
- Verify user has the specific role required for the endpoint in the database
- Admin endpoints require `admin` role
- Instructor endpoints require `instructor` role
- Student endpoints require `student` role (except shared endpoints)
- Note: Having `admin` role does NOT automatically grant access to instructor or student endpoints
- Use `/admin/user_role` endpoint to add required roles to users

#### 404 Not Found

**Cause:** Resource doesn't exist or user doesn't have access

**Solution:**
- Verify resource ID is correct
- Check user owns the resource (for student endpoints)
- Verify instructor-student relationship (for instructor endpoints)

#### 429 Too Many Requests

**Cause:** Rate limit exceeded

**Solution:**
- Implement exponential backoff
- Check daily message limit hasn't been reached
- Wait before retrying

```javascript
async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const response = await fetch(url, options);
    
    if (response.status === 429) {
      const delay = Math.pow(2, i) * 1000; // Exponential backoff
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }
    
    return response;
  }
  throw new Error("Max retries exceeded");
}
```

#### 500 Internal Server Error

**Cause:** Server-side error

**Solution:**
- Check CloudWatch logs for detailed error information
- Verify request body matches expected schema
- Contact system administrator if issue persists

---

### Debugging Tips

1. **Enable verbose logging:**
```javascript
// Log all requests and responses
const originalFetch = window.fetch;
window.fetch = async (...args) => {
  console.log("Request:", args);
  const response = await originalFetch(...args);
  console.log("Response:", response.status, await response.clone().text());
  return response;
};
```

2. **Validate request bodies:**
```javascript
// Ensure all required fields are present
const validateCaseCreation = (data) => {
  const required = ["case_title", "case_type", "jurisdiction", "case_description", "province", "statute"];
  const missing = required.filter(field => !data[field]);
  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(", ")}`);
  }
};
```

3. **Check token expiration:**
```javascript
import { jwtDecode } from "jwt-decode";

const isTokenExpired = (token) => {
  const decoded = jwtDecode(token);
  return decoded.exp * 1000 < Date.now();
};
```


## Related Documentation

- [Product Overview](.kiro/steering/product.md) - Core features and user roles
- [Technology Stack](.kiro/steering/tech.md) - AWS services and frameworks
- [Authentication & Authorization](.kiro/steering/Authentication.md) - Cognito integration and RBAC
- [WebSocket Implementation](.kiro/steering/Websocket.md) - Real-time streaming and notifications
- [Project Structure](.kiro/steering/structure.md) - File organization and naming conventions

## API Changelog

### Version 1.0.0 (Current)

- Initial API release
- Admin, Instructor, and Student endpoints
- Case management
- AI chat integration
- Audio transcription
- Summary generation
- Feedback system
- Prompt management
- Disclaimer management
- Role-based access control

## Support

For API support or to report issues:

1. Check CloudWatch logs for detailed error information
2. Review this documentation for endpoint specifications
3. Verify authentication and authorization requirements
4. Contact your system administrator

## API Best Practices

### Performance

1. **Use pagination** for list endpoints to reduce response size
2. **Cache responses** when data doesn't change frequently (e.g., role labels, disclaimers)
3. **Use WebSocket** for real-time features instead of polling REST endpoints
4. **Batch operations** when possible to reduce number of requests

---

### Error Handling

1. **Always check response status** before parsing JSON
2. **Implement retry logic** with exponential backoff for transient errors
3. **Log errors** with context for debugging
4. **Provide user-friendly error messages** in the UI

```javascript
async function apiRequest(url, options) {
  try {
    const response = await fetch(url, options);
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error("API request failed:", error);
    throw error;
  }
}
```

---

### Security

1. **Never log tokens** or sensitive data
2. **Validate input** on client-side before sending to API
3. **Use HTTPS** for all requests
4. **Implement CSRF protection** for state-changing operations
5. **Sanitize user input** to prevent XSS attacks

---

**Last Updated:** March 2024  
**API Version:** 1.0.0  
**Base URL:** `https://{api-id}.execute-api.{region}.amazonaws.com/prod`
