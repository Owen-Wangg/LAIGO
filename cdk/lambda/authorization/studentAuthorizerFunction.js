/**
 * Student Authorizer Lambda Function
 *
 * This Lambda authorizer validates JWT tokens from an IDP (Identity Provider)
 * and resolves the user identifier to database userId for downstream handlers.
 *
 * Flow:
 * 1. API Gateway receives request with Authorization header
 * 2. Invokes this Lambda with the token
 * 3. Lambda verifies token signature and expiration
 * 4. Extracts "sub" claim as idpId
 * 5. Queries database to resolve idpId to userId
 * 6. Returns IAM policy with userId and user metadata in context
 *
 * Note: Authorization checks (role validation) are performed by API handlers
 * using the userId from context, not by this authorizer.
 */

const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const { CognitoJwtVerifier } = require("aws-jwt-verify");
const { initializeConnection } = require("./initializeConnection");
const { Logger } = require("@aws-lambda-powertools/logger");
const logger = new Logger({ serviceName: "StudentAuthorizer" });

// Create a Secrets Manager client
const secretsManager = new SecretsManagerClient();

// Environment variables for IDP configuration
let { SM_IDP_CREDENTIALS } = process.env;

// IAM policy response structure — built fresh per invocation to avoid
// Statement array accumulation across warm Lambda invocations.
function buildAuthResponse(principalId, effect, resource, context) {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "execute-api:Invoke",
          Effect: effect,
          Resource: resource,
        },
      ],
    },
    context: context || {},
  };
}

// JWT verifier instance (initialized once during cold start for performance)
// Caches JWKS (JSON Web Key Set) to avoid fetching on every invocation
let jwtVerifier;

// User metadata cache for the warm Lambda execution context.
// Entries carry an expiry so that role changes in the database become
// effective within a bounded window instead of persisting for the full
// lifetime of a warm container. Kept in line with the API Gateway authorizer
// result cache (authorizerResultTtlInSeconds: 60).
const USER_METADATA_CACHE_TTL_MS = 60 * 1000;
let userMetadataCache = {};

/**
 * Query database to resolve idpId to userId and retrieve user metadata.
 * Caches results across invocations with a bounded TTL so revoked roles stop
 * being honored once the entry expires.
 */
async function getUserMetadataFromDatabase(idpId, forceRefresh = false) {
  // Serve from cache only when the entry has not expired.
  const cached = userMetadataCache[idpId];
  if (!forceRefresh && cached && Date.now() < cached.expiresAt) {
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
 * Initialize JWT verifier with IDP configuration from Secrets Manager
 * Called once during Lambda cold start to set up the verifier
 */
async function initializeJwtVerifier() {
  try {
    // Retrieve IDP configuration from Secrets Manager
    const getSecretValueCommand = new GetSecretValueCommand({
      SecretId: SM_IDP_CREDENTIALS,
    });
    const secretResponse = await secretsManager.send(getSecretValueCommand);

    const credentials = JSON.parse(secretResponse.SecretString);

    // Create JWT verifier configured to validate tokens from the IDP
    // Note: NO group validation - authorization is handled by API handlers
    jwtVerifier = CognitoJwtVerifier.create({
      userPoolId: credentials.JWT_ISSUER_ID,
      tokenUse: "id", // Validate ID tokens (not access tokens)
      clientId: credentials.JWT_CLIENT_ID,
      // NO groups parameter - we don't validate groups in JWT
    });

    // Log verifier initialization (no secrets)
    logger.info("Student JWT verifier initialized", {
      issuerId: credentials.JWT_ISSUER_ID,
    });
  } catch (error) {
    logger.error("Error initializing JWT verifier", error);
    throw new Error("Failed to initialize JWT verifier");
  }
}

/**
 * Lambda handler function invoked by API Gateway for authorization
 */
exports.handler = async (event) => {
  // Initialize verifier on first invocation (cold start)
  if (!jwtVerifier) {
    await initializeJwtVerifier();
  }

  // Extract JWT token from Authorization header
  const accessToken = event.authorizationToken.toString();
  logger.info("Student authorizer invoked", { methodArn: event.methodArn });
  let payload;

  try {
    // Verify token signature and expiration (NO group validation)
    payload = await jwtVerifier.verify(accessToken);

    // Extract idpId from "sub" claim
    const idpId = payload.sub;

    // Query database to resolve idpId to userId
    let user;
    try {
      user = await getUserMetadataFromDatabase(idpId);
    } catch (error) {
      logger.error("User lookup failed", {
        errorType: error.name,
        errorMessage: error.message,
      });
      throw new Error("Unauthorized");
    }

    const parts = event.methodArn.split("/");
    const method = parts[2] || "";
    const routePath = `/${parts.slice(3).join("/")}`;
    const requestKey = `${method} ${routePath}`;

    // Shared endpoints under /student/* that are intentionally available to
    // any authenticated user, regardless of whether they hold the student role.
    const sharedRoutes = new Set([
      "GET /student/profile",
      "GET /student/role_labels",
      "GET /student/get_disclaimer",
      "POST /student/accept_disclaimer",
    ]);

    // Instructor-accessible endpoints under /student/* used by case detail views.
    // Handlers still enforce ownership/instructor-student relationship checks.
    const instructorCaseRoutes = new Set([
      "GET /student/case_page",
      "GET /student/get_transcriptions",
      "GET /student/transcription",
      "GET /student/get_summaries",
      "GET /student/feedback",
      "GET /student/get_messages",
      "GET /student/file_size_limit",
    ]);

    let roles = Array.isArray(user.roles) ? user.roles : [];
    let hasStudentRole = roles.includes("student");
    let hasInstructorRole = roles.includes("instructor");

    const isAllowedWithoutStudentRole =
      sharedRoutes.has(requestKey) ||
      (hasInstructorRole && instructorCaseRoutes.has(requestKey));

    // Enforce student role for all non-shared /student/* endpoints.
    if (!hasStudentRole && !isAllowedWithoutStudentRole) {
      // Roles can be stale in warm Lambda cache right after admin updates.
      // Re-fetch once from DB before denying.
      user = await getUserMetadataFromDatabase(idpId, true);
      roles = Array.isArray(user.roles) ? user.roles : [];
      hasStudentRole = roles.includes("student");
      hasInstructorRole = roles.includes("instructor");

      const isAllowedAfterRefresh =
        sharedRoutes.has(requestKey) ||
        (hasInstructorRole && instructorCaseRoutes.has(requestKey));

      if (!hasStudentRole && !isAllowedAfterRefresh) {
        logger.warn("Access denied: user does not have student role", {
          userId: user.user_id,
          requestKey,
        });
        throw new Error("Unauthorized");
      }
    }

    // Build the IAM policy resource to match exactly what admitted this caller.
    // The TOKEN authorizer result is cached per token for the configured TTL and
    // reused across method ARNs, so the resource must never grant more than the
    // per-route decision above.
    const base = parts.slice(0, 2).join("/");

    // Map a "METHOD /path" route key to its concrete method ARN.
    const toRouteArn = (routeKey) => {
      const spaceIndex = routeKey.indexOf(" ");
      const routeMethod = routeKey.slice(0, spaceIndex);
      const path = routeKey.slice(spaceIndex + 1);
      return `${base}/${routeMethod}${path}`;
    };

    let resource;
    if (hasStudentRole) {
      // Student role holders are entitled to the whole /student/* scope;
      // handlers enforce object-level ownership. A scoped wildcard keeps the
      // cached result usable across all of this role's endpoints.
      resource = `${base}/*/student/*`;
    } else {
      // Non-students were admitted only via the shared or instructor-case
      // allowlists. Grant exactly those routes so the cached policy cannot be
      // reused to reach any other /student/* operation.
      const allowedRoutes = [...sharedRoutes];
      if (hasInstructorRole) {
        allowedRoutes.push(...instructorCaseRoutes);
      }
      resource = allowedRoutes.map(toRouteArn);
    }

    // Build fresh IAM policy per invocation (no shared mutable state)
    return buildAuthResponse(user.user_id, "Allow", resource, {
      userId: user.user_id,
      email: user.email,
      firstName: user.first_name || "",
      lastName: user.last_name || "",
      roles: JSON.stringify(user.roles), // API Gateway requires string values
    });
  } catch (error) {
    logger.error("Authorization error", error);
    // API Gateway requires exact "Unauthorized" message for 401 response
    throw new Error("Unauthorized");
  }
};
