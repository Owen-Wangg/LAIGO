const { initializeConnection } = require("../initializeConnection");
const { Logger } = require("@aws-lambda-powertools/logger");
const logger = new Logger({ serviceName: "HandlerUtils" });

let { SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT } = process.env;

const initConnection = async () => {
  if (!global.sqlConnection) {
    await initializeConnection(SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT);
  }
};

let corsWildcardWarned = false;

/**
 * Resolves the CORS origin for a response based on the ALLOWED_ORIGIN env var.
 *
 * - If ALLOWED_ORIGIN is not set, returns the local Vite dev-server origin
 *   (http://localhost:5173) as a non-production fallback.
 * - If ALLOWED_ORIGIN is set, returns that value.
 *
 * @param {object} event - The Lambda event object (optional, pass {} if unavailable)
 * @returns {string} The value for the Access-Control-Allow-Origin header
 */
const getOriginHeader = (event) => {
  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  if (!allowedOrigin) {
    if (!corsWildcardWarned) {
      logger.warn(
        "ALLOWED_ORIGIN is unset; CORS responses fall back to Access-Control-Allow-Origin: http://localhost:5173",
      );
      corsWildcardWarned = true;
    }
    return "http://localhost:5173";
  }

  return allowedOrigin;
};

const createResponse = (event) => ({
  statusCode: 200,
  headers: {
    "Access-Control-Allow-Headers":
      "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
    "Access-Control-Allow-Origin": getOriginHeader(event || {}),
    "Access-Control-Allow-Methods": "*",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none';",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  },
  body: "",
});

const parseBody = (body) => {
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("Invalid JSON body");
  }
};

const handleError = (error, response) => {
  response.statusCode = 500;
  logger.error("Request failed", {
    message: error?.message,
    stack: error?.stack,
  });
  response.body = JSON.stringify({
    error: "Internal server error",
  });
};

// Lambda execution context cache for user metadata.
// Entries carry an expiry so that role changes in the database become
// effective within a bounded window instead of persisting for the full
// lifetime of a warm container.
const USER_METADATA_CACHE_TTL_MS = 60 * 1000;
let userMetadataCache = {};

/**
 * Retrieves user metadata from the database by IDP ID with bounded-TTL caching
 * across the warm Lambda execution context.
 *
 * @param {string} idpId - The IDP user identifier (e.g., Cognito sub claim)
 * @returns {Promise<Object>} User object with user_id, email, first_name, last_name, roles
 * @throws {Error} Throws "User not found" if user doesn't exist in database
 */
const getUserMetadata = async (idpId) => {
  // Serve from cache only when the entry has not expired.
  const cached = userMetadataCache[idpId];
  if (cached && Date.now() < cached.expiresAt) {
    return cached.user;
  }

  // Ensure database connection is initialized
  if (!global.sqlConnection) {
    await initConnection();
  }

  const sqlConnection = global.sqlConnection;

  // Query database by idp_id column
  const result = await sqlConnection`
    SELECT user_id, user_email, first_name, last_name, roles
    FROM users
    WHERE idp_id = ${idpId};
  `;

  if (result.length === 0) {
    throw new Error("User not found");
  }

  const user = {
    user_id: result[0].user_id,
    email: result[0].user_email,
    first_name: result[0].first_name,
    last_name: result[0].last_name,
    roles: result[0].roles,
  };

  // Cache with a bounded expiry so stale roles cannot outlive the TTL.
  userMetadataCache[idpId] = {
    user,
    expiresAt: Date.now() + USER_METADATA_CACHE_TTL_MS,
  };

  return user;
};

module.exports = {
  initConnection,
  createResponse,
  getOriginHeader,
  parseBody,
  handleError,
  getSqlConnection: () => global.sqlConnection,
  getUserMetadata,
};
