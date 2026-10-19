const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const {
  DynamoDBClient,
  GetItemCommand,
} = require("@aws-sdk/client-dynamodb");
const { Logger } = require("@aws-lambda-powertools/logger");
const logger = new Logger({ serviceName: "PreSignup" });

const ssmClient = new SSMClient();
const dynamoClient = new DynamoDBClient();

class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserError";
  }
}

/**
 * Cognito Pre-Signup Lambda Trigger
 *
 * Two-stage validation:
 * 1. Email domain check (existing) — validates against allowed domains in SSM.
 * 2. Whitelist check (new) — if signup mode is 'whitelist', the exact email
 *    must exist in the DynamoDB email-whitelist table.
 */
exports.handler = async (event) => {
  const domainParamName = process.env.ALLOWED_EMAIL_DOMAINS;
  const signupModeParamName = process.env.SIGNUP_MODE_PARAM;
  const whitelistTableName = process.env.WHITELIST_TABLE_NAME;

  try {
    if (!domainParamName) {
      throw new Error("Environment variable ALLOWED_EMAIL_DOMAINS is not set");
    }

    // ── Stage 1: Domain allowlist check (unchanged) ──────────────────────────
    const domainData = await ssmClient.send(
      new GetParameterCommand({ Name: domainParamName, WithDecryption: true }),
    );

    if (!domainData?.Parameter?.Value) {
      throw new Error(
        `SSM parameter ${domainParamName} not found or has no value`,
      );
    }

    const allowedDomains = domainData.Parameter.Value.split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);

    if (allowedDomains.length === 0) {
      throw new Error(
        `SSM parameter ${domainParamName} contains no allowed domains`,
      );
    }

    const email = event?.request?.userAttributes?.email;
    if (!email) {
      throw new UserError("Email attribute is required for signup");
    }

    const parts = email.split("@");
    if (parts.length < 2) {
      throw new UserError(`Invalid email address provided: ${email}`);
    }
    const emailDomain = parts.slice(1).join("@").trim().toLowerCase();
    logger.info("Signup request", { emailDomain });

    // A wildcard ("*") entry would admit every email domain, which defeats the
    // purpose of the allowlist. Treat it as a misconfiguration and fail closed:
    // block all signups until the allowlist is corrected rather than silently
    // granting every domain access to self-registration.
    if (allowedDomains.includes("*")) {
      logger.error(
        "Wildcard ('*') present in email domain allowlist; blocking signup until the allowlist is corrected",
      );
      throw new Error(
        "Signup is temporarily unavailable due to a configuration issue. Please contact an administrator.",
      );
    }

    const isDomainAllowed = allowedDomains.some(
      (allowed) => allowed === emailDomain,
    );

    if (!isDomainAllowed) {
      logger.error("Domain not allowed", { emailDomain, allowedDomains });
      throw new UserError("Signup is not available for this email address. Please contact an administrator.");
    }

    // ── Stage 2: Whitelist check (new) ───────────────────────────────────────
    if (signupModeParamName && whitelistTableName) {
      let signupMode;
      try {
        const modeData = await ssmClient.send(
          new GetParameterCommand({ Name: signupModeParamName }),
        );
        signupMode = modeData?.Parameter?.Value || "public";
      } catch (ssmError) {
        // Fail-closed: if we can't determine signup mode, block signup rather than allowing unrestricted access (AUTH-CT-06)
        logger.error("Failed to read SignupMode SSM param — failing closed", { error: ssmError });
        throw new Error("Cannot determine signup mode. Signup blocked for safety.");
      }
      logger.info("Signup mode", { signupMode });

      if (signupMode === "whitelist") {
        // Verify the exact email exists in the whitelist table
        const whitelistResult = await dynamoClient.send(
          new GetItemCommand({
            TableName: whitelistTableName,
            Key: { email: { S: email.toLowerCase().trim() } },
          }),
        );

        if (!whitelistResult.Item) {
          logger.error("Email not in whitelist");
          throw new UserError(
            "Signup is not available for this email address. Please contact an administrator.",
          );
        }

        logger.info("Email found in whitelist", {
          role: whitelistResult.Item.canonical_role?.S,
        });
      }
    }

    // All checks passed — continue signup
    return event;
  } catch (error) {
    logger.error("PreSignUp error", error);
    // If it's an intentional validation error (UserError), show it to the user.
    // Otherwise, mask it as a generic internal error.
    if (error instanceof UserError) {
      throw error;
    }
    throw new Error(
      "An error occurred during signup. Please try again later or contact an administrator.",
    );
  }
};
