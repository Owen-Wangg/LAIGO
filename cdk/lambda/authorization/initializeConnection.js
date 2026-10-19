/**
 * Database Connection Module for Authorizers
 *
 * Provides database connection initialization and user metadata lookup
 * for Lambda authorizers. Implements execution context caching to avoid
 * repeated database queries within the same Lambda invocation.
 */

const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const postgres = require("postgres");
const { Logger } = require("@aws-lambda-powertools/logger");
const logger = new Logger({ serviceName: "AuthorizerInit" });

const secretsManager = new SecretsManagerClient();

/**
 * Initialize database connection for authorizer Lambda
 * Reuses connection across invocations via global.sqlConnection
 */
async function initializeConnection() {
  if (global.sqlConnection) {
    return global.sqlConnection;
  }

  const { SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT } = process.env;

  if (!SM_DB_CREDENTIALS || !RDS_PROXY_ENDPOINT) {
    throw new Error(
      "Missing required environment variables: SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT",
    );
  }

  try {
    // Retrieve database credentials from Secrets Manager
    const getSecretValueCommand = new GetSecretValueCommand({
      SecretId: SM_DB_CREDENTIALS,
    });
    const secretResponse = await secretsManager.send(getSecretValueCommand);
    const credentials = JSON.parse(secretResponse.SecretString);

    // Create PostgreSQL connection via RDS Proxy
    global.sqlConnection = postgres({
      host: RDS_PROXY_ENDPOINT,
      port: credentials.port || 5432,
      database: credentials.dbname,
      username: credentials.username,
      password: credentials.password,
      // Verify the server certificate and hostname against the system trust
      // store (the RDS Proxy presents an ACM-issued certificate from a public
      // Amazon CA). Encryption alone without verification is not sufficient.
      ssl: { rejectUnauthorized: true },
      max: 1, // Single connection per Lambda instance
      idle_timeout: 20,
      connect_timeout: 10,
    });

    logger.info("Database connection initialized for authorizer");
    return global.sqlConnection;
  } catch (error) {
    logger.error("Database connection initialization failed", {
      errorType: error.name,
      errorMessage: error.message,
    });
    throw new Error("Failed to initialize database connection");
  }
}

module.exports = { initializeConnection };
