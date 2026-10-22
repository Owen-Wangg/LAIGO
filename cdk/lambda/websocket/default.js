const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
const {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  DeleteConnectionCommand,
} = require("@aws-sdk/client-apigatewaymanagementapi");
const { Logger } = require("@aws-lambda-powertools/logger");
const logger = new Logger({ serviceName: "WsDefault" });

const lambda = new LambdaClient({});

exports.handler = async (event, context) => {
  logger.addContext(context);
  const connectionId = event.requestContext.connectionId;
  const domainName = event.requestContext.domainName;
  const stage = event.requestContext.stage;

  // Extract userId and user metadata from authorization context (passed from authorizer)
  const userId = event.requestContext.authorizer?.userId;
  const email = event.requestContext.authorizer?.email;
  const firstName = event.requestContext.authorizer?.firstName;
  const lastName = event.requestContext.authorizer?.lastName;
  const roles = JSON.parse(event.requestContext.authorizer?.roles || "[]");

  logger.info("WebSocket message received", {
    connectionId,
    routeKey: event.requestContext.routeKey,
    timestamp: new Date().toISOString(),
    userId,
  });

  // Enforce a maximum session lifetime (finding M3). The WebSocket authorizer
  // runs only at $connect, so authorization captured there would otherwise live
  // for the whole socket. Once a connection exceeds its lifetime we force-close
  // it; the client's reconnect re-runs the authorizer and re-validates roles.
  const maxSessionSeconds = parseInt(
    process.env.WS_MAX_SESSION_SECONDS || "1800",
    10,
  );
  const connectedAt = event.requestContext.connectedAt; // epoch ms
  const nowEpoch = event.requestContext.requestTimeEpoch || Date.now();
  if (
    connectedAt &&
    nowEpoch - connectedAt > maxSessionSeconds * 1000
  ) {
    logger.info("WebSocket session exceeded max lifetime; forcing reconnect", {
      connectionId,
      userId,
      sessionAgeSeconds: Math.floor((nowEpoch - connectedAt) / 1000),
      maxSessionSeconds,
    });
    const apigw = new ApiGatewayManagementApiClient({
      endpoint: `https://${domainName}/${stage}`,
    });
    try {
      await apigw.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: JSON.stringify({
            type: "session_expired",
            code: "SESSION_EXPIRED",
            content: "Your session has expired. Please reconnect to continue.",
          }),
        }),
      );
    } catch (notifyError) {
      // Best effort — the client may already be gone.
      logger.warn("Failed to notify client of session expiry");
    }
    try {
      await apigw.send(
        new DeleteConnectionCommand({ ConnectionId: connectionId }),
      );
    } catch (closeError) {
      logger.warn("Failed to close expired WebSocket connection");
    }
    return { statusCode: 200 };
  }

  try {
    // Build user object from context
    const user = {
      user_id: userId,
      email,
      first_name: firstName,
      last_name: lastName,
      roles,
    };

    // Check roles from context
    const isAdmin = user.roles.includes("admin");
    const isInstructor = user.roles.includes("instructor");
    const isStaff = isAdmin || isInstructor;

    const body = JSON.parse(event.body);
    const { action, requestId } = body;

    // Handle ping/pong for connection heartbeat
    if (action === "ping") {
      const apigw = new ApiGatewayManagementApiClient({
        endpoint: `https://${domainName}/${stage}`,
      });
      await apigw.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: JSON.stringify({ type: "pong" }),
        }),
      );
      return { statusCode: 200 };
    }

    // Handle text generation requests
    if (action === "generate_text") {
      const { case_id, sub_route, message_content } = body;

      // Log metadata only (scrub message_content to prevent PII leakage)
      logger.info("Invoking text generation", {
        case_id,
        sub_route,
        userId,
        requestId,
        messageLength: message_content?.length || 0,
      });

      const textGenPayload = {
        isWebSocket: true,
        userId: userId,
        requestId: requestId, // Pass request ID for response correlation
        queryStringParameters: {
          case_id: case_id,
          sub_route: sub_route,
        },
        body: JSON.stringify({
          message_content: message_content || "",
        }),
        requestContext: {
          connectionId: connectionId,
          domainName: domainName,
          stage: stage,
        },
      };

      await lambda.send(
        new InvokeCommand({
          FunctionName: process.env.TEXT_GEN_FUNCTION_NAME,
          InvocationType: "Event",
          Payload: JSON.stringify(textGenPayload),
        }),
      );

      logger.info("Text generation function invoked successfully");
      return { statusCode: 200 };
    }

    // Handle playground test requests
    if (action === "playground_test") {
      const {
        message_content,
        block_type,
        session_id,
        custom_prompt,
        model_id,
        temperature,
        top_p,
        max_tokens,
        case_context,
      } = body;

      // RBAC Check: Only admin and instructor can use playground features
      if (!isStaff) {
        // Log identifiers only — never the user's email (PII).
        logger.warn("Unauthorized playground access attempt", {
          userId,
          roles: user.roles,
        });
        return {
          statusCode: 403,
          body: JSON.stringify({
            error: "Forbidden: Administrative access required",
          }),
        };
      }

      console.log("Invoking playground test:", {
        block_type,
        session_id,
        userId,
        requestId,
        model_id,
      });

      const playgroundPayload = {
        isWebSocket: true,
        userId: userId,
        callerRoles: roles,
        requestId: requestId,
        queryStringParameters: {
          playground_mode: "true",
          sub_route: block_type, // Map block_type to sub_route logic if needed, or handle directly
        },
        body: JSON.stringify({
          message_content: message_content || "",
          block_type: block_type,
          session_id: session_id,
          custom_prompt: custom_prompt,
          model_id: model_id,
          temperature: temperature,
          top_p: top_p,
          max_tokens: max_tokens,
          case_context: case_context,
        }),
        requestContext: {
          connectionId: connectionId,
          domainName: domainName,
          stage: stage,
        },
      };

      await lambda.send(
        new InvokeCommand({
          FunctionName: process.env.PLAYGROUND_GEN_FUNCTION_NAME,
          InvocationType: "Event",
          Payload: JSON.stringify(playgroundPayload),
        }),
      );

      logger.info("Playground test invoked successfully");
      return { statusCode: 200 };
    }

    // Handle assess progress requests
    if (action === "assess_progress") {
      const { case_id, block_type } = body;

      console.log("Invoking assess_progress:", {
        case_id,
        block_type,
        userId,
        requestId,
      });

      const assessPayload = {
        isWebSocket: true,
        userId: userId,
        requestId: requestId,
        body: JSON.stringify({ case_id, block_type }),
        requestContext: {
          connectionId: connectionId,
          domainName: domainName,
          stage: stage,
        },
      };

      await lambda.send(
        new InvokeCommand({
          FunctionName: process.env.ASSESS_PROGRESS_FUNCTION_NAME,
          InvocationType: "Event",
          Payload: JSON.stringify(assessPayload),
        }),
      );

      logger.info("Assess progress function invoked successfully");
      return { statusCode: 200 };
    }

    // Handle playground assessment requests (admin testing assessment prompts)
    if (action === "playground_assess") {
      const { block_type, session_id, custom_prompt } = body;

      // RBAC Check: Only admin and instructor can use playground features
      if (!isStaff) {
        // Log identifiers only — never the user's email (PII).
        logger.warn("Unauthorized playground assessment attempt", {
          userId,
          roles: user.roles,
        });
        return {
          statusCode: 403,
          body: JSON.stringify({
            error: "Forbidden: Administrative access required",
          }),
        };
      }

      console.log("Invoking playground_assess:", {
        block_type,
        session_id,
        userId,
        requestId,
      });

      const playgroundAssessPayload = {
        isWebSocket: true,
        userId: userId,
        callerRoles: roles,
        requestId: requestId,
        body: JSON.stringify({
          playground_mode: true,
          block_type: block_type,
          session_id: session_id,
          custom_prompt: custom_prompt,
        }),
        requestContext: {
          connectionId: connectionId,
          domainName: domainName,
          stage: stage,
        },
      };

      await lambda.send(
        new InvokeCommand({
          FunctionName: process.env.ASSESS_PROGRESS_FUNCTION_NAME,
          InvocationType: "Event",
          Payload: JSON.stringify(playgroundAssessPayload),
        }),
      );

      logger.info("Playground assess function invoked successfully");
      return { statusCode: 200 };
    }

    // Handle summary generation requests
    if (action === "generate_summary") {
      const { case_id, sub_route } = body;

      console.log("Invoking generate_summary:", {
        case_id,
        sub_route,
        userId,
        requestId,
      });

      const summaryPayload = {
        isWebSocket: true,
        userId: userId,
        requestId: requestId,
        queryStringParameters: {
          case_id: case_id,
          sub_route: sub_route,
        },
        requestContext: {
          connectionId: connectionId,
          domainName: domainName,
          stage: stage,
        },
      };

      await lambda.send(
        new InvokeCommand({
          FunctionName: process.env.SUMMARY_GEN_FUNCTION_NAME,
          InvocationType: "Event",
          Payload: JSON.stringify(summaryPayload),
        }),
      );

      logger.info("Summary generation function invoked successfully");
      return { statusCode: 200 };
    }

    // Handle audio transcription requests
    if (action === "audio_to_text") {
      const { audio_file_id, file_name, file_type, case_title, case_id } = body;

      console.log("Invoking audio_to_text:", {
        audio_file_id,
        file_name,
        file_type,
        case_id,
        userId,
        requestId,
      });

      const audioPayload = {
        isWebSocket: true,
        userId: userId,
        requestId: requestId,
        body: JSON.stringify({
          audio_file_id,
          file_name,
          file_type,
          case_title,
          case_id,
        }),
        requestContext: {
          connectionId: connectionId,
          domainName: domainName,
          stage: stage,
        },
      };

      await lambda.send(
        new InvokeCommand({
          FunctionName: process.env.AUDIO_TO_TEXT_FUNCTION_NAME,
          InvocationType: "Event",
          Payload: JSON.stringify(audioPayload),
        }),
      );

      logger.info("Audio to text function invoked successfully");
      return { statusCode: 200 };
    }

    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Unknown action" }),
    };
  } catch (error) {
    logger.error("Error processing WebSocket message", error);

    // Handle user not found error
    if (error.message === "User not found") {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: "User not found" }),
      };
    }

    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
};
