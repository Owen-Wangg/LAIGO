const {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  DeleteItemCommand,
} = require("@aws-sdk/client-dynamodb");
const {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} = require("@aws-sdk/client-apigatewaymanagementapi");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const { Logger } = require("@aws-lambda-powertools/logger");
const logger = new Logger({ serviceName: "NotificationService" });

const dynamodb = new DynamoDBClient({});

/**
 * Notification Service Lambda
 * Handles notification creation, storage, and real-time delivery via WebSocket
 *
 * Supports two invocation modes:
 * 1. EventBridge events for notification creation and delivery
 * 2. REST API requests for notification queries and updates
 */
exports.handler = async (event, context) => {
  logger.addContext(context);
  logger.info("Notification Service invoked", {
    source: event.source || "API",
    eventType: event["detail-type"] || event.httpMethod,
  });

  try {
    // Handle EventBridge events
    if (event.source === "notification.system") {
      return await handleEventBridgeEvent(event);
    }

    // Handle REST API requests
    if (event.httpMethod) {
      return await handleRestApiRequest(event);
    }

    throw new Error("Unknown invocation type");
  } catch (error) {
    logger.error("Error in notification service", error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
};

/**
 * Handle EventBridge notification events
 */
async function handleEventBridgeEvent(event) {
  const { detail } = event;
  const eventType = event["detail-type"];
  const eventId = event.id; // Stable across EventBridge redeliveries of the same event

  logger.info("Processing EventBridge event", {
    eventType,
    eventId,
    recipientId: detail.recipientId, // Database user_id
    notificationType: detail.type,
  });

  // Idempotency (finding M6): EventBridge delivery is at-least-once, so the same
  // event can be delivered more than once. Claim the event id with a conditional
  // write; if it's already claimed, this is a redelivery and we skip to avoid a
  // duplicate notification.
  const claimed = await claimEventForProcessing(eventId);
  if (!claimed) {
    logger.info("Duplicate EventBridge event ignored (idempotency)", {
      eventId,
      eventType,
    });
    return { statusCode: 200 };
  }

  try {
    // Create notification record
    const notification = await createNotification(detail);

    // Attempt real-time delivery via WebSocket
    await deliverNotificationViaWebSocket(notification);
  } catch (error) {
    // Release the claim so a retry (or DLQ replay) can reprocess this event
    // rather than being permanently suppressed by the idempotency marker.
    await releaseEventClaim(eventId);
    throw error;
  }

  return { statusCode: 200 };
}

/**
 * Attempt to claim an EventBridge event id for processing using a conditional
 * write. Returns true if this invocation won the claim (first time seen), false
 * if the event was already processed (redelivery). A missing id disables dedup
 * (returns true) so processing still proceeds.
 */
async function claimEventForProcessing(eventId) {
  if (!eventId) {
    logger.warn("EventBridge event has no id; idempotency dedup skipped");
    return true;
  }
  const ttl = Math.floor(Date.now() / 1000) + 24 * 60 * 60; // 24h dedup window
  try {
    await dynamodb.send(
      new PutItemCommand({
        TableName: process.env.NOTIFICATION_TABLE_NAME,
        Item: marshall({
          PK: `IDEMPOTENCY#${eventId}`,
          SK: `IDEMPOTENCY#${eventId}`,
          processedAt: new Date().toISOString(),
          ttl,
        }),
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    return true;
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException") {
      return false;
    }
    throw error;
  }
}

/**
 * Release a previously claimed event id so a retry can reprocess it. Best effort.
 */
async function releaseEventClaim(eventId) {
  if (!eventId) return;
  try {
    await dynamodb.send(
      new DeleteItemCommand({
        TableName: process.env.NOTIFICATION_TABLE_NAME,
        Key: marshall({
          PK: `IDEMPOTENCY#${eventId}`,
          SK: `IDEMPOTENCY#${eventId}`,
        }),
      }),
    );
  } catch (error) {
    logger.warn("Failed to release idempotency claim; retry may be suppressed", {
      eventId,
    });
  }
}

/**
 * Handle REST API requests for notification management
 */
async function handleRestApiRequest(event) {
  const { httpMethod, resource, pathParameters, queryStringParameters } = event;
  const userId = event.requestContext?.authorizer?.userId;

  if (!userId) {
    return {
      statusCode: 401,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: "Unauthorized" }),
    };
  }

  const pathData = `${httpMethod} ${resource}`;

  switch (pathData) {
    case "GET /student/notifications":
      return await getNotifications(userId, queryStringParameters, event);

    case "PUT /student/notifications/{notificationId}/read":
      return await markNotificationAsRead(
        userId,
        pathParameters.notificationId,
        event,
      );

    case "PUT /student/notifications/read-all":
      return await markAllNotificationsAsRead(userId, event);

    case "PUT /student/notifications/{notificationId}/unread":
      return await markNotificationAsUnread(
        userId,
        pathParameters.notificationId,
        event,
      );

    case "DELETE /student/notifications/{notificationId}":
      return await deleteNotification(userId, pathParameters.notificationId, event);

    case "GET /student/notifications/unread-count":
      return await getUnreadCount(userId, event);

    default:
      return {
        statusCode: 404,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: "Route not found" }),
      };
  }
}

/**
 * Create a new notification record in DynamoDB
 * @param {Object} eventDetail - Event detail from EventBridge
 * @param {string} eventDetail.recipientId - Database user_id (not idp_id or cognito_id)
 * @param {string} eventDetail.type - Notification type
 * @param {string} eventDetail.title - Notification title
 * @param {string} eventDetail.message - Notification message
 * @param {Object} eventDetail.metadata - Additional metadata
 * @param {string} eventDetail.createdBy - User ID of creator (optional)
 */
async function createNotification(eventDetail) {
  const {
    type,
    recipientId, // Database user_id
    title,
    message,
    metadata = {},
    createdBy,
  } = eventDetail;

  const notificationId = generateNotificationId();
  const timestamp = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days

  const notification = {
    PK: `USER#${recipientId}`, // Database user_id
    SK: `NOTIFICATION#${timestamp}#${notificationId}`,
    GSI1PK: `NOTIFICATION#${notificationId}`,
    GSI1SK: `USER#${recipientId}`, // Database user_id
    notificationId,
    userId: recipientId, // Database user_id
    type,
    title,
    message,
    metadata,
    isRead: false,
    readStatus: "UNREAD",
    createdAt: timestamp,
    ttl,
    ...(createdBy && { createdBy }),
  };

  await dynamodb.send(
    new PutItemCommand({
      TableName: process.env.NOTIFICATION_TABLE_NAME,
      Item: marshall(notification),
    }),
  );

  logger.info("Notification created", {
    notificationId,
    userId: recipientId, // Database user_id
    type,
  });

  return notification;
}

/**
 * Deliver notification to user via WebSocket if they're online
 * @param {Object} notification - Notification object
 * @param {string} notification.userId - Database user_id (not idp_id or cognito_id)
 */
async function deliverNotificationViaWebSocket(notification) {
  const userId = notification.userId; // Database user_id

  try {
    // Get active connections for the user
    const connections = await getUserConnections(userId);

    if (connections.length === 0) {
      logger.info("No active connections for user", { userId });
      return;
    }

    const wsEndpoint = process.env.WEBSOCKET_API_ENDPOINT;
    const apigw = new ApiGatewayManagementApiClient({
      endpoint: wsEndpoint,
    });

    // Deliver to all active connections
    const deliveryPromises = connections.map(async (connection) => {
      try {
        await apigw.send(
          new PostToConnectionCommand({
            ConnectionId: connection.connectionId,
            Data: JSON.stringify({
              action: "notification_delivery",
              type: notification.type,
              notification: {
                notificationId: notification.notificationId,
                type: notification.type,
                title: notification.title,
                message: notification.message,
                metadata: notification.metadata,
                createdAt: notification.createdAt,
                isRead: notification.isRead,
              },
              timestamp: new Date().toISOString(),
            }),
          }),
        );

        logger.info("Notification delivered via WebSocket", {
          connectionId: connection.connectionId,
          notificationId: notification.notificationId,
        });
      } catch (error) {
        console.error("Failed to deliver to connection", {
          connectionId: connection.connectionId,
          error: error.message,
        });

        // If connection is stale (410 Gone), clean it up
        if (error.statusCode === 410) {
          await cleanupStaleConnection(connection.connectionId, userId);
        }
      }
    });

    await Promise.allSettled(deliveryPromises);
  } catch (error) {
    logger.error("Error delivering notification via WebSocket", error);
    // Don't throw - notification is still stored even if delivery fails
  }
}

/**
 * Get active WebSocket connections for a user
 * @param {string} userId - Database user_id (not idp_id or cognito_id)
 * @returns {Promise<Array>} Array of connection objects
 */
async function getUserConnections(userId) {
  try {
    const result = await dynamodb.send(
      new QueryCommand({
        TableName: process.env.CONNECTION_TABLE_NAME,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: {
          ":pk": { S: `USER#${userId}` }, // Database user_id
        },
      }),
    );

    return result.Items?.map((item) => unmarshall(item)) || [];
  } catch (error) {
    logger.error("Error getting user connections", error);
    return [];
  }
}

/**
 * Clean up stale WebSocket connection
 * @param {string} connectionId - WebSocket connection ID
 * @param {string} userId - Database user_id (not idp_id or cognito_id)
 */
async function cleanupStaleConnection(connectionId, userId) {
  try {
    await dynamodb.send(
      new DeleteItemCommand({
        TableName: process.env.CONNECTION_TABLE_NAME,
        Key: marshall({
          PK: `CONNECTION#${connectionId}`,
          SK: `USER#${userId}`, // Database user_id
        }),
      }),
    );

    logger.info("Cleaned up stale connection", { connectionId });
  } catch (error) {
    logger.error("Error cleaning up stale connection", error);
  }
}

/**
 * Get notifications for a user with pagination
 */
async function getNotifications(userId, queryParams = {}, event) {
  const limit = parseInt(queryParams.limit) || 20;
  const lastKey = queryParams.lastKey;

  try {
    const params = {
      TableName: process.env.NOTIFICATION_TABLE_NAME,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: {
        ":pk": { S: `USER#${userId}` },
      },
      ScanIndexForward: false, // Reverse chronological order
      Limit: limit,
    };

    if (lastKey) {
      params.ExclusiveStartKey = JSON.parse(
        Buffer.from(lastKey, "base64").toString(),
      );
    }

    const result = await dynamodb.send(new QueryCommand(params));

    const notifications =
      result.Items?.map((item) => {
        const notification = unmarshall(item);
        // Remove DynamoDB keys from response
        delete notification.PK;
        delete notification.SK;
        delete notification.GSI1PK;
        delete notification.GSI1SK;
        delete notification.ttl;
        return notification;
      }) || [];

    const response = {
      notifications,
      hasMore: !!result.LastEvaluatedKey,
    };

    if (result.LastEvaluatedKey) {
      response.nextKey = Buffer.from(
        JSON.stringify(result.LastEvaluatedKey),
      ).toString("base64");
    }

    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify(response),
    };
  } catch (error) {
    logger.error("Error getting notifications", error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: "Failed to get notifications" }),
    };
  }
}

/**
 * Mark a specific notification as read
 */
async function markNotificationAsRead(userId, notificationId, event) {
  try {
    // First, get the notification to verify ownership and get the sort key
    const getResult = await dynamodb.send(
      new QueryCommand({
        TableName: process.env.NOTIFICATION_TABLE_NAME,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk AND GSI1SK = :sk",
        ExpressionAttributeValues: {
          ":pk": { S: `NOTIFICATION#${notificationId}` },
          ":sk": { S: `USER#${userId}` },
        },
      }),
    );

    if (!getResult.Items || getResult.Items.length === 0) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: "Notification not found" }),
      };
    }

    const notification = unmarshall(getResult.Items[0]);

    // Update the notification
    await dynamodb.send(
      new UpdateItemCommand({
        TableName: process.env.NOTIFICATION_TABLE_NAME,
        Key: marshall({
          PK: notification.PK,
          SK: notification.SK,
        }),
        UpdateExpression:
          "SET isRead = :isRead, readStatus = :status, readAt = :readAt",
        ExpressionAttributeValues: marshall({
          ":isRead": true,
          ":status": "READ",
          ":readAt": new Date().toISOString(),
        }),
      }),
    );

    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ success: true }),
    };
  } catch (error) {
    logger.error("Error marking notification as read", error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: "Failed to mark notification as read" }),
    };
  }
}

/**
 * Mark a specific notification as unread
 */
async function markNotificationAsUnread(userId, notificationId, event) {
  try {
    // First, get the notification to verify ownership and get the sort key
    const getResult = await dynamodb.send(
      new QueryCommand({
        TableName: process.env.NOTIFICATION_TABLE_NAME,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk AND GSI1SK = :sk",
        ExpressionAttributeValues: {
          ":pk": { S: `NOTIFICATION#${notificationId}` },
          ":sk": { S: `USER#${userId}` },
        },
      }),
    );

    if (!getResult.Items || getResult.Items.length === 0) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: "Notification not found" }),
      };
    }

    const notification = unmarshall(getResult.Items[0]);

    // Update the notification
    await dynamodb.send(
      new UpdateItemCommand({
        TableName: process.env.NOTIFICATION_TABLE_NAME,
        Key: marshall({
          PK: notification.PK,
          SK: notification.SK,
        }),
        UpdateExpression:
          "SET isRead = :isRead, readStatus = :status REMOVE readAt",
        ExpressionAttributeValues: marshall({
          ":isRead": false,
          ":status": "UNREAD",
        }),
      }),
    );

    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ success: true }),
    };
  } catch (error) {
    logger.error("Error marking notification as unread", error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: "Failed to mark notification as unread" }),
    };
  }
}

/**
 * Delete a specific notification
 */
async function deleteNotification(userId, notificationId, event) {
  try {
    // First, get the notification to verify ownership and get the sort key
    const getResult = await dynamodb.send(
      new QueryCommand({
        TableName: process.env.NOTIFICATION_TABLE_NAME,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk AND GSI1SK = :sk",
        ExpressionAttributeValues: {
          ":pk": { S: `NOTIFICATION#${notificationId}` },
          ":sk": { S: `USER#${userId}` },
        },
      }),
    );

    if (!getResult.Items || getResult.Items.length === 0) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: "Notification not found" }),
      };
    }

    const notification = unmarshall(getResult.Items[0]);

    // Delete the notification
    await dynamodb.send(
      new DeleteItemCommand({
        TableName: process.env.NOTIFICATION_TABLE_NAME,
        Key: marshall({
          PK: notification.PK,
          SK: notification.SK,
        }),
      }),
    );

    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ success: true }),
    };
  } catch (error) {
    logger.error("Error deleting notification", error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: "Failed to delete notification" }),
    };
  }
}

/**
 * Mark all notifications as read for a user
 */
async function markAllNotificationsAsRead(userId, event) {
  try {
    let lastEvaluatedKey = undefined;
    let totalUpdated = 0;

    // Paginate through all unread notifications
    do {
      const queryParams = {
        TableName: process.env.NOTIFICATION_TABLE_NAME,
        KeyConditionExpression: "PK = :pk",
        FilterExpression: "isRead = :isRead",
        ExpressionAttributeValues: {
          ":pk": { S: `USER#${userId}` },
          ":isRead": { BOOL: false },
        },
      };
      if (lastEvaluatedKey) {
        queryParams.ExclusiveStartKey = lastEvaluatedKey;
      }

      const result = await dynamodb.send(new QueryCommand(queryParams));
      lastEvaluatedKey = result.LastEvaluatedKey;

      if (!result.Items || result.Items.length === 0) {
        continue;
      }

      // Process in batches of 25 (DynamoDB BatchWriteItem limit)
      // We use UpdateItem here since BatchWriteItem only supports Put/Delete
      const batchSize = 25;
      for (let i = 0; i < result.Items.length; i += batchSize) {
        const batch = result.Items.slice(i, i + batchSize);
        const updatePromises = batch.map((item) => {
          const notification = unmarshall(item);
          return dynamodb.send(
            new UpdateItemCommand({
              TableName: process.env.NOTIFICATION_TABLE_NAME,
              Key: marshall({
                PK: notification.PK,
                SK: notification.SK,
              }),
              UpdateExpression:
                "SET isRead = :isRead, readStatus = :status, readAt = :readAt",
              ExpressionAttributeValues: marshall({
                ":isRead": true,
                ":status": "READ",
                ":readAt": new Date().toISOString(),
              }),
            }),
          );
        });

        const results = await Promise.allSettled(updatePromises);
        const succeeded = results.filter((r) => r.status === "fulfilled").length;
        const failed = results.filter((r) => r.status === "rejected");
        totalUpdated += succeeded;

        if (failed.length > 0) {
          logger.warn("Some notifications failed to mark as read", {
            failedCount: failed.length,
            batchIndex: i,
          });
        }
      }
    } while (lastEvaluatedKey);

    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ updated: totalUpdated }),
    };
  } catch (error) {
    logger.error("Error marking all notifications as read", error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: "Failed to mark notifications as read" }),
    };
  }
}

/**
 * Get unread notification count for a user
 */
async function getUnreadCount(userId, event) {
  try {
    const result = await dynamodb.send(
      new QueryCommand({
        TableName: process.env.NOTIFICATION_TABLE_NAME,
        IndexName: "ReadStatusIndex",
        KeyConditionExpression: "PK = :pk AND readStatus = :status",
        ExpressionAttributeValues: {
          ":pk": { S: `USER#${userId}` },
          ":status": { S: "UNREAD" },
        },
        Select: "COUNT",
      }),
    );

    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ count: result.Count || 0 }),
    };
  } catch (error) {
    logger.error("Error getting unread count", error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: "Failed to get unread count" }),
    };
  }
}

/**
 * Generate a unique notification ID
 */
function generateNotificationId() {
  return `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

let corsWildcardWarned = false;

/**
 * Resolves the CORS origin based on the ALLOWED_ORIGIN env var.
 * Mirrors getOriginHeader() in cdk/lambda/handlers/utils/utils.js.
 *
 * @param {object} event - The Lambda event object (pass {} for non-HTTP contexts)
 * @returns {string} The value for the Access-Control-Allow-Origin header
 */
function getOriginHeader(event) {
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
}

/**
 * Get CORS headers for API responses
 * @param {object} [event] - Optional Lambda event for dynamic origin resolution.
 *                           For EventBridge invocations (no HTTP event), omit or pass undefined
 *                           to fall back to ALLOWED_ORIGIN or "*".
 */
function getCorsHeaders(event) {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Origin": getOriginHeader(event || {}),
    "Access-Control-Allow-Methods": "*",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none';",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  };
}
