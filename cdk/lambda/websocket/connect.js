const {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
} = require("@aws-sdk/client-dynamodb");
const { Logger } = require("@aws-lambda-powertools/logger");
const logger = new Logger({ serviceName: "WsConnect" });

const dynamodb = new DynamoDBClient({});

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const userId = event.requestContext.authorizer?.userId;
  const userEmail = event.requestContext.authorizer?.email;

  logger.info("WebSocket connection established", {
    connectionId,
    userId,
    userEmail,
    timestamp: new Date().toISOString(),
  });

  // Store connection-to-user mapping in DynamoDB for notification targeting
  if (userId) {
    try {
      // Check current connection count for this user
      const existingConnections = await dynamodb.send(
        new QueryCommand({
          TableName: process.env.CONNECTION_TABLE_NAME,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :pk",
          ExpressionAttributeValues: {
            ":pk": { S: `USER#${userId}` },
          },
          Select: "COUNT",
        }),
      );

      const maxConnections = parseInt(
        process.env.MAX_CONNECTIONS_PER_USER || "5",
      );

      if (existingConnections.Count >= maxConnections) {
        logger.warn("WebSocket connection limit reached", {
          userId,
          currentCount: existingConnections.Count,
          maxConnections,
        });

        return {
          statusCode: 429,
          body: "Too many concurrent connections. Please close another session.",
        };
      }

      const ttl = Math.floor(Date.now() / 1000) + 2 * 60 * 60; // 2 hours from now
      const connectedAt = new Date().toISOString();

      await dynamodb.send(
        new PutItemCommand({
          TableName: process.env.CONNECTION_TABLE_NAME,
          Item: {
            PK: { S: `CONNECTION#${connectionId}` },
            SK: { S: `USER#${userId}` },
            GSI1PK: { S: `USER#${userId}` },
            GSI1SK: { S: `CONNECTION#${connectionId}` },
            connectionId: { S: connectionId },
            userId: { S: userId },
            connectedAt: { S: connectedAt },
            ttl: { N: ttl.toString() },
          },
        }),
      );

      logger.info("WebSocket connection stored in DynamoDB", {
        connectionId,
        userId,
      });
    } catch (error) {
      logger.error("Failed to process WebSocket connection in DynamoDB", error);
      // Don't fail the connection for this error
    }
  }

  // Connection valid (authorized by Lambda Authorizer)
  const response = { statusCode: 200, body: "Connected" };

  // Negotiate the WebSocket subprotocol. Per RFC 6455, the server may only
  // select a subprotocol the client actually offered; returning one the client
  // did not send causes the browser to fail the handshake. We echo a fixed
  // "chat.v1" protocol name (never the raw token, to avoid credential leakage
  // in logs — AUTH-WS-04), but ONLY when the client offered it. Older clients
  // that send just the token get no subprotocol back, which browsers accept.
  const headers = event.headers || {};
  const protocolHeader =
    headers["Sec-WebSocket-Protocol"] || headers["sec-websocket-protocol"];

  if (protocolHeader) {
    const offeredProtocols = protocolHeader
      .split(",")
      .map((p) => p.trim());

    if (offeredProtocols.includes("chat.v1")) {
      response.headers = {
        "Sec-WebSocket-Protocol": "chat.v1",
      };
    }
  }

  return response;
};
