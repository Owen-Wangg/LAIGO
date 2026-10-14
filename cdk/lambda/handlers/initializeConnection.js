// PostgreSQL client library
const postgres = require("postgres");
// AWS SDK imports for Secrets Manager
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const { Logger } = require("@aws-lambda-powertools/logger");
const logger = new Logger({ serviceName: "HandlerConnection" });

// Initialize Secrets Manager client for retrieving database credentials
const secretsManager = new SecretsManagerClient();

/**
 * Initialize PostgreSQL database connection using credentials from Secrets Manager.
 * Creates a global connection object for reuse across Lambda invocations.
 * Includes connection health check to detect and recover from stale connections.
 *
 * @param {string} SM_DB_CREDENTIALS - Secrets Manager secret name containing DB credentials
 * @param {string} RDS_PROXY_ENDPOINT - RDS Proxy endpoint for database connection
 */
async function initializeConnection(SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT) {
  // If connection already exists, verify it's still healthy
  if (global.sqlConnection) {
    try {
      await global.sqlConnection`SELECT 1`;
      return; // Connection is healthy, reuse it
    } catch (error) {
      logger.warn("Stale database connection detected, reconnecting...", {
        error: error.message,
      });
      // Close the stale connection gracefully
      try {
        await global.sqlConnection.end({ timeout: 2 });
      } catch (closeErr) {
        // Ignore close errors on stale connections
      }
      global.sqlConnection = null;
    }
  }

  let credentials;
  try {
    // Retrieve database credentials from AWS Secrets Manager
    const getSecretValueCommand = new GetSecretValueCommand({
      SecretId: SM_DB_CREDENTIALS,
    });
    const secretResponse = await secretsManager.send(getSecretValueCommand);

    // Parse JSON credentials from secret
    credentials = JSON.parse(secretResponse.SecretString);

    logger.info("Connecting to database via RDS Proxy");

    // Create PostgreSQL connection with pool configuration matching authorizer settings
    global.sqlConnection = postgres({
      host: RDS_PROXY_ENDPOINT,
      port: credentials.port || 5432,
      username: credentials.username,
      password: credentials.password,
      database: credentials.dbname,
      // Verify the server certificate and hostname against the system trust
      // store (the RDS Proxy presents an ACM-issued certificate from a public
      // Amazon CA). Encryption alone without verification is not sufficient.
      ssl: { rejectUnauthorized: true },
      max: 1,              // Single connection per Lambda instance (Lambda is single-threaded)
      idle_timeout: 20,    // Close idle connections after 20 seconds
      connect_timeout: 10, // Timeout connection attempts after 10 seconds
    });

    // Test connection with simple query
    await global.sqlConnection`SELECT 1`;

    logger.info("Database connection initialized and tested successfully");
  } catch (error) {
    logger.error("Error initializing database connection", {
      host: RDS_PROXY_ENDPOINT,
      username: credentials ? credentials.username : undefined,
      database: credentials ? credentials.dbname : undefined,
      error: error.message,
    });
    global.sqlConnection = null;
    throw new Error(`Failed to initialize database connection: ${error.message}`);
  }
}

module.exports = { initializeConnection };
