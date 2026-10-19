const { CognitoJwtVerifier } = require("aws-jwt-verify");
const { initializeConnection } = require("./initializeConnection");
const { Logger } = require("@aws-lambda-powertools/logger");
const logger = new Logger({ serviceName: "WsAuthorizer" });

let jwtVerifier;

// User metadata cache for the warm Lambda execution context.
// Entries carry an expiry so that role changes in the database become
// effective within a bounded window instead of persisting for the full
// lifetime of a warm container. This bounds freshness at connect time only;
// an already-open socket retains the roles captured at $connect for the life
// of its connection record (see websocket/connect.js TTL).
const USER_METADATA_CACHE_TTL_MS = 60 * 1000;
let userMetadataCache = {};

/**
 * Query database to resolve idpId to userId and retrieve user metadata.
 * Caches results across invocations with a bounded TTL so revoked roles stop
 * being honored at connect time once the entry expires.
 */
async function getUserMetadataFromDatabase(idpId) {
  // Serve from cache only when the entry has not expired.
  const cached = userMetadataCache[idpId];
  if (cached && Date.now() < cached.expiresAt) {
    logger.info("Using cached user metadata");
    return cached.user;
  }

  // Ensure database connection is initialized
  if (!global.sqlConnection) {
    await initializeConnection();
  }

  const sqlConnection = global.sqlConnection;

  try {
    // Query database by idp_id
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
  } catch (error) {
    logger.error("Database query failed", {
      errorType: error.name,
      errorMessage: error.message,
    });
    throw error;
  }
}

/**
 * Lambda Authorizer for WebSocket $connect route.
 * Validates JWT token and returns IAM Policy Document.
 *
 * Flow:
 * 1. Extracts JWT token from headers/query
 * 2. Verifies token signature and expiration
 * 3. Extracts "sub" claim as idpId
 * 4. Queries database to resolve idpId to userId
 * 5. Returns IAM policy with userId and user metadata in context
 *
 * Note: Authorization checks (role validation) are performed by WebSocket handlers
 * using the userId from context, not JWT claims.
 */
exports.handler = async (event) => {
  const methodArn = event.methodArn;
  const timestamp = new Date().toISOString();

  try {
    const token = extractToken(event);

    if (!token) {
      logger.warn("WebSocket authorizer: missing token", { timestamp });
      throw new Error("Unauthorized");
    }

    // Initialize JWT verifier (IDP-agnostic)
    if (!jwtVerifier) {
      jwtVerifier = CognitoJwtVerifier.create({
        userPoolId: process.env.JWT_ISSUER_ID,
        tokenUse: "id",
        clientId: process.env.JWT_CLIENT_ID,
        // NO groups parameter - we don't validate groups in JWT
      });
    }

    // Validate JWT and extract sub claim
    const decoded = await jwtVerifier.verify(token);
    const idpId = decoded.sub;

    // Query database to resolve idpId to userId
    let user;
    try {
      user = await getUserMetadataFromDatabase(idpId);
    } catch (error) {
      logger.error("User lookup failed", {
        errorType: error.name,
        errorMessage: error.message,
        timestamp,
      });
      throw new Error("Unauthorized");
    }

    logger.info("WebSocket connection authorized", {
      timestamp,
      userId: user.user_id,
    });

    // Return IAM Policy allowing the connection
    // Pass userId and user metadata to downstream handlers via context
    return generatePolicy(user.user_id, "Allow", methodArn, {
      userId: user.user_id,
      email: user.email,
      firstName: user.first_name || "",
      lastName: user.last_name || "",
      roles: JSON.stringify(user.roles), // API Gateway requires string values
    });
  } catch (error) {
    logger.error("WebSocket authorizer: token validation failed", {
      timestamp,
      reason: error?.message,
    });
    // Return explicit Deny policy
    return generatePolicy("unauthorized", "Deny", methodArn);
  }
};

function extractToken(event) {
  // Check Authorization header
  const headers = event.headers || {};
  const authHeader = headers.Authorization || headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }

  // Check Sec-WebSocket-Protocol header (primary browser path)
  const protocolHeader =
    headers["Sec-WebSocket-Protocol"] || headers["sec-websocket-protocol"];
  if (protocolHeader) {
    const protocols = protocolHeader.split(",").map((p) => p.trim());
    // Return the first protocol which we assume is the token
    if (protocols.length > 0) return protocols[0];
  }

  // Query string ?token= fallback REMOVED (AUTH-WS-01)
  // Placing JWTs in URLs leaks credentials via CloudWatch logs, browser history, and proxy logs.
  // Frontend uses Sec-WebSocket-Protocol exclusively; non-browser clients use Authorization header.

  return undefined;
}

/**
 * Generate IAM Policy Document for API Gateway WebSocket Authorizer
 */
function generatePolicy(principalId, effect, resource, context = {}) {
  const authResponse = {
    principalId: principalId,
  };

  if (effect && resource) {
    authResponse.policyDocument = {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "execute-api:Invoke",
          Effect: effect,
          Resource: resource,
        },
      ],
    };
  }

  // Add context to pass user info to downstream handlers
  if (Object.keys(context).length > 0) {
    authResponse.context = context;
  }

  return authResponse;
}
