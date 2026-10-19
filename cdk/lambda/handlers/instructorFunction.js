const {
  initConnection,
  createResponse,
  parseBody,
  handleError,
  getSqlConnection,
} = require("./utils/utils");
const { PERMISSION_MODELS, authorizeCaseAccess } = require("./utils/authorization");
const { deleteChatHistory } = require("./utils/deleteChatHistory");
const { Logger } = require("@aws-lambda-powertools/logger");
const logger = new Logger({ serviceName: "InstructorFunction" });

const {
  EventBridgeClient,
  PutEventsCommand,
} = require("@aws-sdk/client-eventbridge");

const eventBridgeClient = new EventBridgeClient({});

/**
 * Publish feedback notification event to EventBridge
 * @param {string} caseId - Case ID
 * @param {string} studentUserId - Database user_id of the student (not idp_id)
 * @param {string} instructorUserId - Database user_id of the instructor (not idp_id)
 * @param {string} messageContent - Feedback message content
 * @param {string} caseTitle - Case title
 * @param {string} instructorName - Instructor's full name
 */
async function publishFeedbackNotificationEvent(
  caseId,
  studentUserId, // Database user_id
  instructorUserId, // Database user_id
  messageContent,
  caseTitle,
  instructorName,
) {
  try {
    const eventBusName = process.env.NOTIFICATION_EVENT_BUS_NAME;
    if (!eventBusName) {
      logger.warn(
        "NOTIFICATION_EVENT_BUS_NAME not configured, skipping notification",
      );
      return;
    }

    const eventDetail = {
      type: "feedback",
      recipientId: studentUserId, // Database user_id
      title: `Feedback from ${instructorName} on ${caseTitle}`,
      message: messageContent,
      metadata: {
        caseId: caseId,
        caseName: caseTitle,
        instructorId: instructorUserId, // Database user_id
        instructorName: instructorName,
        feedbackPreview:
          messageContent.substring(0, 100) +
          (messageContent.length > 100 ? "..." : ""),
      },
      createdBy: instructorUserId, // Database user_id
    };

    const response = await eventBridgeClient.send(
      new PutEventsCommand({
        Entries: [
          {
            Source: "notification.system",
            DetailType: "Feedback Notification",
            Detail: JSON.stringify(eventDetail),
            EventBusName: eventBusName,
          },
        ],
      }),
    );
    logger.info("Published feedback notification event", { response });
  } catch (error) {
    logger.error("Error publishing feedback notification event", error);
    // Don't fail the main operation if notification fails
  }
}

const routes = {
  "GET /instructor/students": async (event, env) => {
    const { response, user, sqlConnection } = env;
    try {
      const userId = user.user_id;

      // Fetch the student details
      const data = await sqlConnection`
            SELECT u.student_id, u.first_name, u.last_name 
            FROM "instructor_students" i
            JOIN "users" u ON i.student_id = u.user_id
            WHERE i.instructor_id = ${userId};
          `;

      response.body = JSON.stringify(data);
    } catch (err) {
      console.error("/instructor/students error:", err);
      handleError(err, response);
    }
  },
  "GET /instructor/cases_to_review": async (event, env) => {
    const { response, user, sqlConnection } = env;
    try {
      const instructorUserId = user.user_id;

      // Query to get cases explicitly assigned to this instructor for review
      const data = await sqlConnection`
            SELECT c.*, u.first_name, u.last_name 
            FROM cases c
            JOIN case_reviewers cr ON c.case_id = cr.case_id
            JOIN users u ON c.student_id = u.user_id
            JOIN instructor_students isr ON isr.instructor_id = cr.reviewer_id
              AND isr.student_id = c.student_id
            WHERE cr.reviewer_id = ${instructorUserId}
            AND c.status = 'submitted'
            AND c.sent_to_review = true;
          `;

      response.body = JSON.stringify(data);
    } catch (err) {
      console.error("/instructor/cases_to_review error:", err);
      handleError(err, response);
    }
  },
  "PUT /instructor/send_feedback": async (event, env) => {
    const { response, user, sqlConnection } = env;
    if (!event.queryStringParameters?.case_id || !event.body) {
      response.statusCode = 400;
      response.body = JSON.stringify({
        error: "Missing required parameters: case_id or body",
      });
      return;
    }

    const { case_id } = event.queryStringParameters;
    let message_content;
    try {
      const parsedBody = parseBody(event.body);
      message_content = parsedBody.message_content;
    } catch (e) {
      response.statusCode = 400;
      response.body = JSON.stringify({ error: "Invalid JSON body" });
      return;
    }

    if (!message_content) {
      response.statusCode = 400;
      response.body = JSON.stringify({
        error: "Missing message_content in body",
      });
      return;
    }

    try {
      const user_id = user.user_id;
      const instructorName = `${user.first_name} ${user.last_name}`;

      // BOLA: Check if instructor is assigned to the student for this case
      const authResult = await authorizeCaseAccess(
        user_id,
        case_id,
        PERMISSION_MODELS.INSTRUCTOR_ONLY,
        sqlConnection
      );

      if (!authResult.authorized) {
        response.statusCode = authResult.code === "NOT_FOUND" ? 404 : 403;
        response.body = JSON.stringify({ error: authResult.reason });
        return;
      }

      // Get student_id and case_title from the case
      const caseResult = await sqlConnection`
            SELECT c.student_id, c.case_title
            FROM "cases" c
            WHERE c.case_id = ${case_id};
          `;

      if (caseResult.length === 0) {
        response.statusCode = 404;
        response.body = JSON.stringify({
          error: "Case not found",
        });
        return;
      }
      const student_id = caseResult[0].student_id;
      const case_title = caseResult[0].case_title;

      // Insert message
      await sqlConnection`
              INSERT INTO "messages" (
                  message_id, 
                  instructor_id, 
                  message_content, 
                  case_id, 
                  time_sent
              ) VALUES (
                  uuid_generate_v4(), 
                  ${user_id},
                  ${message_content}, 
                  ${case_id}, 
                  CURRENT_TIMESTAMP
              );
          `;

      // Update case status
      await sqlConnection`
            UPDATE "cases"
            SET 
              sent_to_review = false,
              status = 'reviewed'
            WHERE case_id = ${case_id};
          `;

      // Publish feedback notification event using database user_ids
      await publishFeedbackNotificationEvent(
        case_id,
        student_id, // Database user_id
        user_id, // Database user_id (instructor)
        message_content,
        case_title,
        instructorName,
      );

      response.body = JSON.stringify({
        message: "Feedback sent successfully",
      });
    } catch (err) {
      console.error("/instructor/send_feedback error:", err);
      handleError(err, response);
    }
  },
  "GET /instructor/name": async (event, env) => {
    const { response, user, sqlConnection } = env;
    if (!event.queryStringParameters?.user_email) {
      response.statusCode = 400;
      response.body = JSON.stringify({
        error: "Missing required parameter: user_email",
      });
      return;
    }
    const user_email = event.queryStringParameters.user_email;
    try {
      const userData = await sqlConnection`
            SELECT u.first_name
            FROM "users" u
            INNER JOIN "instructor_students" i ON i.student_id = u.user_id
            WHERE u.user_email = ${user_email}
              AND i.instructor_id = ${user.user_id};
          `;

      if (userData.length > 0) {
        response.body = JSON.stringify({ name: userData[0].first_name });
      } else {
        // Uniform 404 avoids confirming whether an email is registered
        response.statusCode = 404;
        response.body = JSON.stringify({ error: "User not found" });
      }
    } catch (err) {
      console.error("/instructor/name error:", err);
      handleError(err, response);
    }
  },
  "GET /instructor/view_students": async (event, env) => {
    const { response, user, sqlConnection } = env;
    try {
      const instructorId = user.user_id;

      // Get student_ids associated with the instructor
      const studentIdsResult = await sqlConnection`
            SELECT student_id FROM "instructor_students" WHERE instructor_id = ${instructorId};
          `;

      const studentIds = studentIdsResult.map((row) => row.student_id);

      if (studentIds.length === 0) {
        response.body = JSON.stringify({ cases: [], totalCount: 0 });
        return;
      }

      const params = event.queryStringParameters || {};
      const page = parseInt(params.page || "0", 10);
      const limit = parseInt(params.limit || "10", 10);
      const offset = page * limit;
      const search = params.search ? `%${params.search}%` : null;
      const status = params.status && params.status !== "All" ? params.status.toLowerCase() : null;

      let dataQuery;
      let countQuery;

      if (search && status) {
        countQuery = sqlConnection`
          SELECT COUNT(*) as exact_count
          FROM "cases" c
          JOIN "users" u ON c.student_id = u.user_id
          WHERE c.student_id = ANY(${studentIds})
          AND (c.case_title ILIKE ${search} OR u.first_name ILIKE ${search} OR u.last_name ILIKE ${search} OR CAST(c.jurisdiction AS TEXT) ILIKE ${search} OR c.case_id::text ILIKE ${search})
          AND c.status::text = ${status};
        `;
        dataQuery = sqlConnection`
          SELECT c.*, u.first_name, u.last_name
          FROM "cases" c
          JOIN "users" u ON c.student_id = u.user_id
          WHERE c.student_id = ANY(${studentIds})
          AND (c.case_title ILIKE ${search} OR u.first_name ILIKE ${search} OR u.last_name ILIKE ${search} OR CAST(c.jurisdiction AS TEXT) ILIKE ${search} OR c.case_id::text ILIKE ${search})
          AND c.status::text = ${status}
          ORDER BY c.last_updated DESC
          LIMIT ${limit} OFFSET ${offset};
        `;
      } else if (search) {
        countQuery = sqlConnection`
          SELECT COUNT(*) as exact_count
          FROM "cases" c
          JOIN "users" u ON c.student_id = u.user_id
          WHERE c.student_id = ANY(${studentIds})
          AND (c.case_title ILIKE ${search} OR u.first_name ILIKE ${search} OR u.last_name ILIKE ${search} OR CAST(c.jurisdiction AS TEXT) ILIKE ${search} OR c.case_id::text ILIKE ${search});
        `;
        dataQuery = sqlConnection`
          SELECT c.*, u.first_name, u.last_name
          FROM "cases" c
          JOIN "users" u ON c.student_id = u.user_id
          WHERE c.student_id = ANY(${studentIds})
          AND (c.case_title ILIKE ${search} OR u.first_name ILIKE ${search} OR u.last_name ILIKE ${search} OR CAST(c.jurisdiction AS TEXT) ILIKE ${search} OR c.case_id::text ILIKE ${search})
          ORDER BY c.last_updated DESC
          LIMIT ${limit} OFFSET ${offset};
        `;
      } else if (status) {
        countQuery = sqlConnection`
          SELECT COUNT(*) as exact_count
          FROM "cases" c
          WHERE c.student_id = ANY(${studentIds})
          AND c.status::text = ${status};
        `;
        dataQuery = sqlConnection`
          SELECT c.*, u.first_name, u.last_name
          FROM "cases" c
          JOIN "users" u ON c.student_id = u.user_id
          WHERE c.student_id = ANY(${studentIds})
          AND c.status::text = ${status}
          ORDER BY c.last_updated DESC
          LIMIT ${limit} OFFSET ${offset};
        `;
      } else {
        countQuery = sqlConnection`
          SELECT COUNT(*) as exact_count
          FROM "cases" c
          WHERE c.student_id = ANY(${studentIds});
        `;
        dataQuery = sqlConnection`
          SELECT c.*, u.first_name, u.last_name
          FROM "cases" c
          JOIN "users" u ON c.student_id = u.user_id
          WHERE c.student_id = ANY(${studentIds})
          ORDER BY c.last_updated DESC
          LIMIT ${limit} OFFSET ${offset};
        `;
      }

      const [countResult, cases] = await Promise.all([countQuery, dataQuery]);
      const totalCount = parseInt(countResult[0].exact_count, 10);

      response.body = JSON.stringify({ cases, totalCount });
    } catch (err) {
      console.error("/instructor/view_students error:", err);
      handleError(err, response);
    }
  },
  "GET /instructor/prompts": async (event, env) => {
    const { response, sqlConnection } = env;
    // SECURITY: Use trusted cognito_id from authorizer
    try {
      const { category, block_type, prompt_scope } =
        event.queryStringParameters || {};

      // Base query for active prompts
      let query = `
            SELECT 
              prompt_version_id,
              category,
              block_type,
              prompt_scope,
              version_number,
              version_name,
              prompt_text,
              time_created
            FROM prompt_versions
            WHERE is_active = true
          `;

      const params = [];
      if (category) {
        query += ` AND category = $${params.length + 1}`;
        params.push(category);
      }
      if (block_type) {
        query += ` AND block_type = $${params.length + 1}`;
        params.push(block_type);
      }
      if (prompt_scope) {
        query += ` AND prompt_scope = $${params.length + 1}`;
        params.push(prompt_scope);
      }

      query += ` ORDER BY category, prompt_scope, block_type`;

      // Using 'unsafe' for dynamic query construction appropriately with parameters
      const prompts = await sqlConnection.unsafe(query, params);

      response.body = JSON.stringify(prompts);
    } catch (err) {
      console.error("/instructor/prompts error:", err);
      handleError(err, response);
    }
  },
  "DELETE /instructor/delete_case": async (event, env) => {
    const { response, user, sqlConnection } = env;
    if (!event.queryStringParameters?.case_id) {
      response.statusCode = 400;
      response.body = JSON.stringify({
        error: "Missing required parameter: case_id",
      });
      return;
    }
    const deleteCaseId = event.queryStringParameters.case_id;
    try {
      // BOLA: Check if instructor can access this case
      const authResult = await authorizeCaseAccess(
        user.user_id,
        deleteCaseId,
        PERMISSION_MODELS.OWNER_OR_INSTRUCTOR,
        sqlConnection
      );

      if (!authResult.authorized) {
        response.statusCode = authResult.code === "NOT_FOUND" ? 404 : 403;
        response.body = JSON.stringify({ error: authResult.reason });
        return;
      }

      const tableName = process.env.TABLE_NAME;
      if (!tableName) {
        throw new Error("TABLE_NAME is not configured");
      }

      // Remove privileged AI chat content before deleting the case record
      await deleteChatHistory(tableName, deleteCaseId);

      // PostgreSQL child rows cascade via FK constraints (including case_reviewers)
      await sqlConnection`
            DELETE FROM "cases" WHERE case_id = ${deleteCaseId};
          `;

      response.body = JSON.stringify({
        message: "Case deleted successfully",
      });
    } catch (err) {
      console.error("/instructor/delete_case error:", err);
      handleError(err, response);
    }
  },
  "PUT /instructor/archive_case": async (event, env) => {
    const { response, user, sqlConnection } = env;
    if (!event.queryStringParameters?.case_id) {
      response.statusCode = 400;
      response.body = JSON.stringify({
        error: "Missing required parameter: case_id",
      });
      return;
    }
    const archiveCaseId = event.queryStringParameters.case_id;
    try {
      // BOLA: Check if instructor can access this case
      const authResult = await authorizeCaseAccess(
        user.user_id,
        archiveCaseId,
        PERMISSION_MODELS.OWNER_OR_INSTRUCTOR,
        sqlConnection
      );

      if (!authResult.authorized) {
        response.statusCode = authResult.code === "NOT_FOUND" ? 404 : 403;
        response.body = JSON.stringify({ error: authResult.reason });
        return;
      }

      // Archive case
      await sqlConnection`
            UPDATE "cases"
            SET status = 'archived'
            WHERE case_id = ${archiveCaseId};
          `;

      response.body = JSON.stringify({
        message: "Case archived successfully",
      });
    } catch (err) {
      console.error("/instructor/archive_case error:", err);
      handleError(err, response);
    }
  },
  "PUT /instructor/unarchive_case": async (event, env) => {
    const { response, user, sqlConnection } = env;
    if (!event.queryStringParameters?.case_id) {
      response.statusCode = 400;
      response.body = JSON.stringify({
        error: "Missing required parameter: case_id",
      });
      return;
    }
    const unarchiveCaseId = event.queryStringParameters.case_id;
    try {
      // BOLA: Check if instructor can access this case
      const authResult = await authorizeCaseAccess(
        user.user_id,
        unarchiveCaseId,
        PERMISSION_MODELS.OWNER_OR_INSTRUCTOR,
        sqlConnection
      );

      if (!authResult.authorized) {
        response.statusCode = authResult.code === "NOT_FOUND" ? 404 : 403;
        response.body = JSON.stringify({ error: authResult.reason });
        return;
      }

      // Unarchive case
      await sqlConnection`
            UPDATE "cases"
            SET status = 'in_progress'
            WHERE case_id = ${unarchiveCaseId};
          `;

      response.body = JSON.stringify({
        message: "Case unarchived successfully",
      });
    } catch (err) {
      console.error("/instructor/unarchive_case error:", err);
      handleError(err, response);
    }
  },
  "DELETE /instructor/delete_feedback": async (event, env) => {
    const { response, user, sqlConnection } = env;
    if (!event.queryStringParameters?.message_id) {
      response.statusCode = 400;
      response.body = JSON.stringify({
        error: "Missing required parameter: message_id",
      });
      return;
    }
    const deleteMessageId = event.queryStringParameters.message_id;
    try {
      const instructorId = user.user_id;

      // Get message and its author
      const messageResult = await sqlConnection`
            SELECT instructor_id FROM "messages" WHERE message_id = ${deleteMessageId};
          `;
      if (messageResult.length === 0) {
        response.statusCode = 404;
        response.body = JSON.stringify({ error: "Feedback not found" });
        return;
      }
      const messageAuthorId = messageResult[0].instructor_id;

      // Check permission: Instructor must be the author of the message
      if (instructorId !== messageAuthorId) {
        response.statusCode = 403;
        response.body = JSON.stringify({
          error: "Permission denied: You can only delete your own feedback.",
        });
        return;
      }

      // Delete message
      await sqlConnection`
            DELETE FROM "messages" WHERE message_id = ${deleteMessageId};
          `;

      response.body = JSON.stringify({
        message: "Feedback deleted successfully",
      });
    } catch (err) {
      console.error("/instructor/delete_feedback error:", err);
      handleError(err, response);
    }
  },
};

exports.handler = async (event, context) => {
  logger.addContext(context);
  const response = createResponse(event);

  // Initialize the database connection if not already initialized
  try {
    await initConnection();
  } catch (err) {
    console.error("Database connection failed:", err);
    response.statusCode = 500;
    response.body = JSON.stringify({
      error: "Service unavailable (DB connection)",
    });
    return response;
  }

  // Extract userId and user metadata from authorization context
  const userId = event.requestContext?.authorizer?.userId;
  const email = event.requestContext?.authorizer?.email;
  const firstName = event.requestContext?.authorizer?.firstName;
  const lastName = event.requestContext?.authorizer?.lastName;
  const roles = JSON.parse(event.requestContext?.authorizer?.roles || "[]");

  const user = {
    user_id: userId,
    email,
    first_name: firstName,
    last_name: lastName,
    roles,
  };

  // Defense-in-depth: verify instructor role at handler level (AUTH-RBAC-03)
  if (!Array.isArray(roles) || !roles.includes("instructor")) {
    response.statusCode = 403;
    response.body = JSON.stringify({ error: "Forbidden" });
    return response;
  }

  const sqlConnection = getSqlConnection();

  try {
    const pathData = event.httpMethod + " " + event.resource;
    const env = { event, response, user, user_id: userId, sqlConnection };

    const handlerConfig = routes[pathData];
    if (handlerConfig) {
      await handlerConfig(event, env);
    } else {
      response.statusCode = 404;
      response.body = JSON.stringify({ error: "Route not found" });
    }
  } catch (error) {
    logger.error("Critical Handler Error:", error);
    handleError(error, response);
  }

  return response;
};
