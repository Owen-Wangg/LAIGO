const { Logger } = require("@aws-lambda-powertools/logger");
const logger = new Logger({ serviceName: "Authorization" });

/**
 * Object-level authorization permission models.
 * - OWNER_ONLY: Only the resource owner (case student_id) can access
 * - OWNER_OR_INSTRUCTOR: Resource owner OR assigned instructor can access
 * - INSTRUCTOR_ONLY: Only assigned instructors (excludes owner)
 * - ADMIN_ONLY: Only admins can access
 */
const PERMISSION_MODELS = {
  OWNER_ONLY: "owner_only",
  OWNER_OR_INSTRUCTOR: "owner_or_instructor",
  INSTRUCTOR_ONLY: "instructor_only",
  ADMIN_ONLY: "admin_only",
};

/**
 * Check if user can access/modify a case.
 *
 * @param {string} userId - Database user_id of requesting user
 * @param {string} caseId - Case ID to check access for
 * @param {string} permissionModel - One of PERMISSION_MODELS
 * @param {object} sqlConnection - Postgres connection (postgresjs)
 * @returns {Promise<{authorized: boolean, reason?: string, caseOwnerId?: string}>}
 */
async function authorizeCaseAccess(userId, caseId, permissionModel, sqlConnection) {
  if (!userId || !caseId) {
    logger.debug("AuthorizeCaseAccess: Missing userId or caseId", {
      userId: userId ? "set" : "missing",
      caseId: caseId ? "set" : "missing",
    });
    return { authorized: false, reason: "Missing userId or caseId" };
  }

  try {
    // Fetch case owner
    const caseResult = await sqlConnection`
      SELECT student_id FROM "cases" WHERE case_id = ${caseId}
    `;

    if (caseResult.length === 0) {
      logger.debug("AuthorizeCaseAccess: Case not found", { userId, caseId });
      return { authorized: false, reason: "Case not found", code: "NOT_FOUND" };
    }

    const caseOwnerId = caseResult[0].student_id;

    // Model: owner only
    if (permissionModel === PERMISSION_MODELS.OWNER_ONLY) {
      const authorized = userId === caseOwnerId;
      if (!authorized) {
        logger.warn("AuthorizeCaseAccess: Unauthorized (owner_only)", {
          userId,
          caseId,
          caseOwnerId,
        });
      }
      return {
        authorized,
        reason: authorized
          ? undefined
          : "Access denied: user is not the case owner",
        caseOwnerId,
      };
    }

    // Model: owner OR instructor
    if (permissionModel === PERMISSION_MODELS.OWNER_OR_INSTRUCTOR) {
      if (userId === caseOwnerId) {
        return { authorized: true, caseOwnerId };
      }

      const instructorCheck = await sqlConnection`
        SELECT 1 FROM "instructor_students"
        WHERE instructor_id = ${userId} AND student_id = ${caseOwnerId}
      `;

      const authorized = instructorCheck.length > 0;
      if (!authorized) {
        logger.warn(
          "AuthorizeCaseAccess: Unauthorized (owner_or_instructor)",
          {
            userId,
            caseId,
            caseOwnerId,
          }
        );
      }
      return {
        authorized,
        reason: authorized
          ? undefined
          : "Access denied: user is not the case owner or assigned instructor",
        caseOwnerId,
      };
    }

    // Model: instructor only (excludes owner)
    if (permissionModel === PERMISSION_MODELS.INSTRUCTOR_ONLY) {
      if (userId === caseOwnerId) {
        logger.warn("AuthorizeCaseAccess: Owner attempting instructor-only op", {
          userId,
          caseId,
        });
        return {
          authorized: false,
          reason: "Access denied: case owners cannot use instructor-only operations",
          caseOwnerId,
        };
      }

      const instructorCheck = await sqlConnection`
        SELECT 1 FROM "instructor_students"
        WHERE instructor_id = ${userId} AND student_id = ${caseOwnerId}
      `;

      const authorized = instructorCheck.length > 0;
      if (!authorized) {
        logger.warn("AuthorizeCaseAccess: Unauthorized (instructor_only)", {
          userId,
          caseId,
          caseOwnerId,
        });
      }
      return {
        authorized,
        reason: authorized
          ? undefined
          : "Access denied: user is not an assigned instructor for this case",
        caseOwnerId,
      };
    }

    return {
      authorized: false,
      reason: `Unknown permission model: ${permissionModel}`,
    };
  } catch (err) {
    logger.error("AuthorizeCaseAccess: Database error", {
      userId,
      caseId,
      permissionModel,
      errorMsg: err.message,
    });
    return { authorized: false, reason: "Authorization check failed", code: "ERROR" };
  }
}

/**
 * Check if user can access an object within a case (audio file, summary, message, etc.)
 * by first resolving the case_id, then applying case access rules.
 *
 * @param {string} userId - Database user_id
 * @param {string} objectId - audio_file_id, summary_id, message_id, etc.
 * @param {string} tableName - 'audio_files', 'summaries', 'messages'
 * @param {string} permissionModel - PERMISSION_MODELS constant
 * @param {object} sqlConnection - Postgres connection
 * @returns {Promise<{authorized: boolean, reason?: string, caseId?: string}>}
 */
async function authorizeObjectAccess(
  userId,
  objectId,
  tableName,
  permissionModel,
  sqlConnection
) {
  if (!userId || !objectId || !tableName) {
    logger.debug("AuthorizeObjectAccess: Missing required parameters", {
      userId: userId ? "set" : "missing",
      objectId: objectId ? "set" : "missing",
      tableName: tableName ? "set" : "missing",
    });
    return { authorized: false, reason: "Missing userId, objectId, or tableName" };
  }

  try {
    // Resolve case_id from object
    let caseId;
    if (tableName === "audio_files") {
      const result = await sqlConnection`
        SELECT case_id FROM "audio_files" WHERE audio_file_id = ${objectId}
      `;
      if (result.length === 0) {
        logger.debug("AuthorizeObjectAccess: Audio file not found", {
          userId,
          objectId,
        });
        return { authorized: false, reason: "Audio file not found", code: "NOT_FOUND" };
      }
      caseId = result[0].case_id;
    } else if (tableName === "summaries") {
      const result = await sqlConnection`
        SELECT case_id FROM "summaries" WHERE summary_id = ${objectId}
      `;
      if (result.length === 0) {
        logger.debug("AuthorizeObjectAccess: Summary not found", {
          userId,
          objectId,
        });
        return { authorized: false, reason: "Summary not found", code: "NOT_FOUND" };
      }
      caseId = result[0].case_id;
    } else if (tableName === "messages") {
      const result = await sqlConnection`
        SELECT case_id FROM "messages" WHERE message_id = ${objectId}
      `;
      if (result.length === 0) {
        logger.debug("AuthorizeObjectAccess: Message not found", {
          userId,
          objectId,
        });
        return { authorized: false, reason: "Message not found", code: "NOT_FOUND" };
      }
      caseId = result[0].case_id;
    } else {
      logger.error("AuthorizeObjectAccess: Unsupported table", { tableName });
      return { authorized: false, reason: `Unsupported table: ${tableName}` };
    }

    // Recursive check: case access determines object access
    const caseAuth = await authorizeCaseAccess(userId, caseId, permissionModel, sqlConnection);
    return {
      ...caseAuth,
      caseId,
    };
  } catch (err) {
    logger.error("AuthorizeObjectAccess: Database error", {
      userId,
      objectId,
      tableName,
      permissionModel,
      errorMsg: err.message,
    });
    return { authorized: false, reason: "Authorization check failed", code: "ERROR" };
  }
}

module.exports = {
  PERMISSION_MODELS,
  authorizeCaseAccess,
  authorizeObjectAccess,
};
