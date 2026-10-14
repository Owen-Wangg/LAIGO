// Database connection utility
const { initializeConnection } = require("./initializeConnection.js");
// AWS SDK imports for Cognito Identity Provider
const {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} = require("@aws-sdk/client-cognito-identity-provider");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const {
  DynamoDBClient,
  GetItemCommand,
} = require("@aws-sdk/client-dynamodb");
const { Logger } = require("@aws-lambda-powertools/logger");
const logger = new Logger({ serviceName: "AddStudentOnSignUp" });

// Environment variables for database connection
const {
  SM_DB_CREDENTIALS,
  RDS_PROXY_ENDPOINT,
  SIGNUP_MODE_PARAM,
  WHITELIST_TABLE_NAME,
} = process.env;

let sqlConnection = global.sqlConnection;
const ssmClient = new SSMClient();
const dynamoClient = new DynamoDBClient();

/**
 * Looks up the signup mode from SSM. Returns 'public' if not configured.
 * On any read failure it returns 'public', which maps to the least-privileged
 * role in the handler, so an unreadable parameter can never escalate access.
 */
async function getSignupMode() {
  if (!SIGNUP_MODE_PARAM) return "public";
  try {
    const result = await ssmClient.send(
      new GetParameterCommand({ Name: SIGNUP_MODE_PARAM }),
    );
    return result?.Parameter?.Value || "public";
  } catch (err) {
    logger.warn(
      "Could not read SignupMode SSM param; resolving to least-privileged role",
      { err },
    );
    return "public";
  }
}

/**
 * Looks up the canonical role for an email from DynamoDB whitelist.
 * Returns null if not found or table not configured.
 */
async function getWhitelistRole(email) {
  if (!WHITELIST_TABLE_NAME) return null;
  try {
    const result = await dynamoClient.send(
      new GetItemCommand({
        TableName: WHITELIST_TABLE_NAME,
        Key: { email: { S: email.toLowerCase().trim() } },
      }),
    );
    return result?.Item?.canonical_role?.S || null;
  } catch (err) {
    logger.warn("Could not read whitelist entry from DynamoDB", { err });
    return null;
  }
}

class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserError";
  }
}

/**
 * Cognito Post-Confirmation Lambda Trigger
 * Creates or updates user records in RDS database after email verification
 * Database is the single source of truth for user roles and metadata
 * Does NOT manage Cognito groups - authorization is database-driven
 */
exports.handler = async (event) => {
  // Initialize database connection if not already established
  if (!sqlConnection) {
    try {
      await initializeConnection(SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT);
      sqlConnection = global.sqlConnection;
    } catch (err) {
      logger.error("Failed to initialize database connection in post-confirmation", err);
      // We don't throw yet, we'll hit the catch at the bottom if needed
    }
  }

  const { userName, userPoolId } = event;
  const client = new CognitoIdentityProviderClient();

  try {
    if (!sqlConnection) {
      throw new Error("Database connection not established");
    }

    // Retrieve user attributes from Cognito
    const getUserCommand = new AdminGetUserCommand({
      UserPoolId: userPoolId,
      Username: userName,
    });
    const userAttributesResponse = await client.send(getUserCommand);

    // Extract user attributes
    const attributes = userAttributesResponse.UserAttributes;
    const email = attributes.find((attr) => attr.Name === "email")?.Value;
    const firstName =
      attributes.find((attr) => attr.Name === "given_name")?.Value || "";
    const lastName =
      attributes.find((attr) => attr.Name === "family_name")?.Value || "";
    const idpId = attributes.find((attr) => attr.Name === "sub")?.Value; // IDP User ID (UUID)

    // Return error if email attribute is missing
    if (!email) {
      logger.error("Email attribute missing from Cognito");
      throw new UserError("Email attribute not found in Cognito user");
    }

    // Normalize the email so storage and lookups match the lowercase form used
    // by the pre-signup trigger and the whitelist lookups.
    const normalizedEmail = email.toLowerCase().trim();

    // Look up any existing row for this identity or email, including the
    // currently bound identity so we can tell a rebind from a conflict.
    // Email is compared in canonical (lowercased, trimmed) form so rows stored
    // in a non-canonical form by earlier writes are still matched.
    const existingUsers = await sqlConnection`
      SELECT user_id, idp_id, user_email
      FROM "users"
      WHERE idp_id = ${idpId} OR lower(trim(user_email)) = ${normalizedEmail};
    `;

    const emailMatch = existingUsers.find(
      (row) =>
        typeof row.user_email === "string" &&
        row.user_email.toLowerCase().trim() === normalizedEmail,
    );
    const idpMatch = existingUsers.find((row) => row.idp_id === idpId);

    // A row already bound to a different identity must not be re-bound here:
    // doing so would hand the new identity the existing row's user_id and roles.
    // Leave it untouched and let the account proceed without a profile until an
    // administrator reconciles it (see docs/userRemovalGuide.md).
    const conflictingEmailRow =
      emailMatch && emailMatch.idp_id && emailMatch.idp_id !== idpId;

    if (conflictingEmailRow) {
      logger.warn(
        "Email already bound to an existing identity; skipping profile rebind",
      );
      return event;
    }

    // Resolve the row to update: prefer the identity match, otherwise the email
    // row that is unbound or already bound to this identity.
    const targetRow = idpMatch || emailMatch;

    if (targetRow) {
      // Update the existing row by its primary key. Roles are intentionally
      // left unchanged — this trigger never alters an existing user's roles.
      logger.info("Updating existing user in database");
      await sqlConnection`
        UPDATE "users"
        SET
          first_name = ${firstName},
          last_name = ${lastName},
          last_sign_in = CURRENT_TIMESTAMP,
          idp_id = ${idpId},
          user_email = ${normalizedEmail}
        WHERE user_id = ${targetRow.user_id}
        RETURNING *;
      `;
    } else {
      // Determine the role for the new user
      let defaultRole;

      // Check if this is the first user — always gets admin regardless of mode
      const userCount = await sqlConnection`
        SELECT COUNT(*) as count FROM "users";
      `;
      const isFirstUser = parseInt(userCount[0].count, 10) === 0;

      if (isFirstUser) {
        defaultRole = "admin";
        logger.info("First user in system, assigning admin role");
      } else {
        // Check signup mode to determine role. Any inability to determine the
        // mode or the whitelist role resolves to the least-privileged role so
        // an error path can never grant more than student access.
        const signupMode = await getSignupMode();
        logger.info("New user signup", { signupMode });

        if (signupMode === "whitelist") {
          // Look up the canonical role from the DynamoDB whitelist
          const whitelistRole = await getWhitelistRole(normalizedEmail);
          if (whitelistRole) {
            defaultRole = whitelistRole;
            logger.info("Assigning role from whitelist", { defaultRole });
          } else {
            // Whitelist check in preSignup should have blocked this; default to
            // the least-privileged role if the role cannot be determined here.
            logger.warn(
              "Whitelist role could not be determined, defaulting to student",
            );
            defaultRole = "student";
          }
        } else {
          // Public mode (and the fail-closed default): least-privileged role.
          defaultRole = "student";
        }
      }

      logger.info("Creating new user in database", {
        role: defaultRole,
        isFirstUser,
      });

      // Create new user with the determined role
      await sqlConnection`
        INSERT INTO "users" (idp_id, user_email, first_name, last_name, time_account_created, roles, last_sign_in)
        VALUES (${idpId}, ${normalizedEmail}, ${firstName}, ${lastName}, CURRENT_TIMESTAMP, ARRAY[${defaultRole}]::user_role[], CURRENT_TIMESTAMP)
        RETURNING *;
      `;

      logger.info("New user created", { role: defaultRole });
    }

    // Return event to continue post-confirmation flow
    return event;
  } catch (err) {
    logger.error("Error in post-confirmation trigger", err);
    
    // In PostConfirmation, Cognito generally doesn't pass back our error message to the UI.
    // However, we still distinguish them here for better logging logs.
    if (err instanceof UserError) {
      return event; 
    }

    // Database or internal errors:
    // We return the event so the user is confirmed in Cognito, but we've logged the failure.
    // The frontend handles the profile-missing case when the user tries to log in.
    return event;
  }
};
