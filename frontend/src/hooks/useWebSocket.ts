import { useEffect, useRef, useCallback, useState } from "react";
import { fetchAuthSession } from "aws-amplify/auth";
import {
  validateBasicStructure,
  validateMessageType,
  validateTypeSpecificFields,
  validateActionSpecificData,
} from "./useWebSocket.validation";
import type { WebSocketMessage } from "../types/websocket";

interface PendingRequest {
  action: string;
  onStart?: () => void;
  onChunk?: (content: string) => void;
  onComplete?: (data: Record<string, unknown>) => void;
  onError?: (message: string) => void;
}

interface UseWebSocketOptions {
  onMessage?: (message: WebSocketMessage) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Event) => void;
  protocols?: string | string[];
  rateLimit?: {
    maxMessages?: number;
    windowMs?: number;
  };
}

export const useWebSocket = (
  url: string | null,
  options: UseWebSocketOptions = {},
) => {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const heartbeatIntervalRef = useRef<number | null>(null);
  const tokenRotationTimeoutRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const isManualDisconnectRef = useRef(false);
  // Guards against overlapping async connect() calls creating duplicate sockets.
  const isConnectingRef = useRef(false);
  // Expiry (ms epoch) of the JWT used for the live connection, so the token
  // rotation timer can schedule a refresh against the token actually in use
  // rather than a stale one supplied by the component.
  const currentTokenExpiryRef = useRef<number | null>(null);
  const [connectionState, setConnectionState] = useState<
    "connecting" | "connected" | "disconnected" | "error"
  >("disconnected");

  // Rate limiting state
  const messageCountRef = useRef(0);
  const windowStartRef = useRef(Date.now());

  // Destructure with defaults to avoid dependency on the whole options object
  const { maxMessages = 10, windowMs = 1000 } = options.rateLimit || {};

  // Request tracking for streaming responses - must be after useState to maintain hook order
  const pendingRequestsRef = useRef<Map<string, PendingRequest>>(new Map());

  // Static (non-token) subprotocols from the caller, e.g. ["chat.v1"]. The token
  // is always protocols[0]; everything after it is an application subprotocol
  // that must be offered on every (re)connection. We snapshot it here so a token
  // refresh on reconnect can rebuild [freshToken, ...static] without ever
  // dropping the app subprotocol (which the server echoes to complete the
  // WebSocket handshake).
  const staticSubprotocolsRef = useRef<string[]>(
    Array.isArray(options.protocols) ? options.protocols.slice(1) : [],
  );

  // Generate unique request ID
  const generateRequestId = () =>
    `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Store callbacks in refs to avoid dependency issues
  const callbacksRef = useRef(options);
  useEffect(() => {
    callbacksRef.current = options;
    // Keep the static subprotocol snapshot in sync whenever the caller provides
    // a protocols array (i.e. once the token is available). Don't clobber it
    // when protocols is temporarily undefined (e.g. before auth resolves).
    if (Array.isArray(options.protocols)) {
      staticSubprotocolsRef.current = options.protocols.slice(1);
    }
  }, [options]);

  const clearTokenRotationTimer = useCallback(() => {
    if (tokenRotationTimeoutRef.current) {
      window.clearTimeout(tokenRotationTimeoutRef.current);
      tokenRotationTimeoutRef.current = null;
    }
  }, []);

  const parseJwtExpiryMs = useCallback((token: string): number | null => {
    try {
      const parts = token.split(".");
      if (parts.length < 2) return null;

      const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const padding = "=".repeat((4 - (base64.length % 4)) % 4);
      const payload = JSON.parse(window.atob(base64 + padding)) as {
        exp?: number;
      };

      return typeof payload.exp === "number" ? payload.exp * 1000 : null;
    } catch {
      return null;
    }
  }, []);

  const startHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      window.clearInterval(heartbeatIntervalRef.current);
    }

    heartbeatIntervalRef.current = window.setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send(JSON.stringify({ type: "ping" }));
        } catch (error) {
        }
      }
    }, 30000);
  }, []);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      window.clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
  }, []);

  // Ref to store connect function to avoid circular dependencies
  const connectRef = useRef<() => void | Promise<void>>(() => {});

  const scheduleReconnect = useCallback(() => {
    if (isManualDisconnectRef.current) {
      return;
    }

    if (reconnectAttemptsRef.current >= 10) {
      setConnectionState("error");
      return;
    }

    if (reconnectTimeoutRef.current) {
      window.clearTimeout(reconnectTimeoutRef.current);
    }

    const delay = Math.min(
      1000 * Math.pow(2, reconnectAttemptsRef.current),
      30000,
    );

    reconnectTimeoutRef.current = window.setTimeout(() => {
      reconnectAttemptsRef.current++;
      // connect() fetches a fresh JWT via fetchAuthSession() itself, so there is
      // no token to refresh here — this avoids reconnecting with a stale token.
      if (connectRef.current) {
        connectRef.current();
      }
    }, delay);
  }, []);

  const connect = useCallback(async () => {
    if (
      !url ||
      isConnectingRef.current ||
      wsRef.current?.readyState === WebSocket.CONNECTING ||
      wsRef.current?.readyState === WebSocket.OPEN
    ) {
      return;
    }

    // Only authenticate the socket when the caller opted into token-based
    // subprotocols (protocols provided). Non-authenticated usages connect plainly.
    const usesAuth = callbacksRef.current.protocols !== undefined;

    isConnectingRef.current = true;
    setConnectionState("connecting");

    try {
      let protocols: string | string[] | undefined;

      if (usesAuth) {
        // Always fetch a FRESH token immediately before connecting. Amplify's
        // fetchAuthSession() transparently refreshes an expired id token when a
        // valid refresh token exists, so each (re)connect uses a currently-valid
        // JWT instead of the stale one captured by the component at mount. This
        // is what prevents the "Token expired" 403 reconnect storm.
        let freshToken: string | undefined;
        try {
          const session = await fetchAuthSession();
          freshToken = session.tokens?.idToken?.toString();
        } catch {
          freshToken = undefined;
        }

        const freshTokenExpiry = freshToken
          ? parseJwtExpiryMs(freshToken)
          : null;

        // Stop instead of looping when there is no token, or when the token is
        // already expired (e.g. the refresh token itself expired and Amplify
        // returned a stale id token). Reconnecting with an expired JWT only
        // produces repeated 403s at the authorizer — the user must re-auth.
        if (!freshToken || (freshTokenExpiry !== null && freshTokenExpiry <= Date.now())) {
          isConnectingRef.current = false;
          setConnectionState("error");
          return;
        }

        currentTokenExpiryRef.current = freshTokenExpiry;
        // The token is always protocols[0]; the static application subprotocols
        // (e.g. "chat.v1") must always be offered so the server can echo one and
        // complete the handshake.
        protocols = [freshToken, ...staticSubprotocolsRef.current];
      }

      // Re-check guards after the await — the component may have unmounted or a
      // socket may already be opening/open by now.
      if (
        isManualDisconnectRef.current ||
        wsRef.current?.readyState === WebSocket.CONNECTING ||
        wsRef.current?.readyState === WebSocket.OPEN
      ) {
        isConnectingRef.current = false;
        return;
      }

      wsRef.current = protocols
        ? new WebSocket(url, protocols)
        : new WebSocket(url);
      isConnectingRef.current = false;

      wsRef.current.onopen = () => {
        setConnectionState("connected");
        reconnectAttemptsRef.current = 0;

        // Reset rate limiting on new connection
        messageCountRef.current = 0;
        windowStartRef.current = Date.now();

        startHeartbeat();
        callbacksRef.current.onConnect?.();
      };

      wsRef.current.onmessage = (event) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);

          // Validation pipeline - Step 1: Basic structure validation
          const basicValidation = validateBasicStructure(message);
          if (!basicValidation.valid) {
            // Try to extract requestId to provide error feedback
            const requestId =
              "requestId" in message
                ? (message as Record<string, unknown>).requestId
                : undefined;

            if (requestId && typeof requestId === "string") {
              const pending = pendingRequestsRef.current.get(requestId);
              if (pending) {
                pending.onError?.("An error occurred");
                pendingRequestsRef.current.delete(requestId);
              }
            }
            return;
          }

          // Validation pipeline - Step 2: Message type validation
          const typeValidation = validateMessageType(message.type || "");
          if (!typeValidation.valid) {
            // Try to provide error feedback if requestId exists
            const { requestId } = message;
            if (requestId) {
              const pending = pendingRequestsRef.current.get(requestId);
              if (pending) {
                pending.onError?.("An error occurred");
                pendingRequestsRef.current.delete(requestId);
              }
            }
            return;
          }

          // Validation pipeline - Step 3: Type-specific field validation
          const fieldValidation = validateTypeSpecificFields(
            message as unknown as Record<string, unknown>,
          );
          if (!fieldValidation.valid) {
            // Call onError callback if requestId exists with pending request
            const { requestId } = message;
            if (requestId) {
              const pending = pendingRequestsRef.current.get(requestId);
              if (pending) {
                pending.onError?.("An error occurred");
                pendingRequestsRef.current.delete(requestId);
              }
            }
            return;
          }

          if (message.type === "pong") {
            return;
          }

          // Route by requestId if present
          const { requestId, type, content, data, action } = message;
          if (requestId) {
            const pending = pendingRequestsRef.current.get(requestId);
            if (pending) {
              switch (type) {
                case "start":
                  pending.onStart?.();
                  break;
                case "chunk":
                  pending.onChunk?.(content || "");
                  break;
                case "complete":
                  // Validation pipeline - Step 4: Action-specific data validation
                  if (action && data) {
                    const dataValidation = validateActionSpecificData(
                      action,
                      data as Record<string, unknown>,
                    );
                    if (!dataValidation.valid) {
                      pending.onError?.("An error occurred");
                      pendingRequestsRef.current.delete(requestId);
                      return;
                    }
                  }
                  pending.onComplete?.(data || {});
                  pendingRequestsRef.current.delete(requestId);
                  break;
                case "error":
                  pending.onError?.(content || "Unknown error");
                  pendingRequestsRef.current.delete(requestId);
                  break;
              }
              return;
            }
          }

          // Fallback to legacy callback for messages without requestId
          callbacksRef.current.onMessage?.(message);
        } catch {
        }
      };

      wsRef.current.onclose = (event) => {
        wsRef.current = null;
        setConnectionState("disconnected");
        stopHeartbeat();
        callbacksRef.current.onDisconnect?.();

        if (!isManualDisconnectRef.current) {
          if (event.code !== 1000 && event.code !== 1001) {
            scheduleReconnect();
          }
        }
      };

      wsRef.current.onerror = (error) => {
        setConnectionState("error");
        callbacksRef.current.onError?.(error);
      };
    } catch {
      isConnectingRef.current = false;
      setConnectionState("error");
      scheduleReconnect();
    }
  }, [url, startHeartbeat, stopHeartbeat, scheduleReconnect, parseJwtExpiryMs]);

  // Update connectRef whenever connect changes
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const disconnect = useCallback(() => {
    isManualDisconnectRef.current = true;

    if (reconnectTimeoutRef.current) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    stopHeartbeat();
    clearTokenRotationTimer();
    isConnectingRef.current = false;

    if (wsRef.current) {
      wsRef.current.close(1000, "Manual disconnect");
      wsRef.current = null;
    }

    setConnectionState("disconnected");
    reconnectAttemptsRef.current = 0;
  }, [stopHeartbeat, clearTokenRotationTimer]);

  const sendMessage = useCallback(
    (message: unknown) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        // Rate limiting check
        const now = Date.now();
        if (now - windowStartRef.current > windowMs) {
          // Reset window
          windowStartRef.current = now;
          messageCountRef.current = 0;
        }

        if (messageCountRef.current >= maxMessages) {
          return false;
        }

        try {
          const messageStr = JSON.stringify(message);
          wsRef.current.send(messageStr);
          messageCountRef.current++;
          return true;
        } catch {
          return false;
        }
      }

      return false;
    },
    [connectionState, maxMessages, windowMs],
  );

  const forceReconnect = useCallback(() => {
    isManualDisconnectRef.current = false;
    reconnectAttemptsRef.current = 0;

    disconnect();

    setTimeout(() => {
      isManualDisconnectRef.current = false;
      connect();
    }, 1000);
  }, [disconnect, connect]);

  // Only depend on URL and protocols changes
  // We serialize protocols array to string for dependency checking if it's an array
  const protocolsDeps = Array.isArray(options.protocols)
    ? options.protocols.join(",")
    : options.protocols;

  useEffect(() => {
    if (connectionState !== "connected") {
      clearTokenRotationTimer();
      return;
    }

    // Use the expiry of the token actually used for the live connection, which
    // connect() records after fetching a fresh JWT.
    const expiryMs = currentTokenExpiryRef.current;
    if (!expiryMs) {
      clearTokenRotationTimer();
      return;
    }

    // Reconnect shortly before JWT expiry so connect-route auth is re-evaluated.
    const rotateLeadMs = 30 * 1000;
    const delay = Math.max(expiryMs - Date.now() - rotateLeadMs, 0);

    clearTokenRotationTimer();
    tokenRotationTimeoutRef.current = window.setTimeout(() => {
      forceReconnect();
    }, delay);

    return () => {
      clearTokenRotationTimer();
    };
  }, [connectionState, protocolsDeps, forceReconnect, clearTokenRotationTimer]);

  useEffect(() => {
    let connectTimer: number | undefined;

    if (url) {
      isManualDisconnectRef.current = false;
      // Avoid calling setState synchronously in effect
      connectTimer = window.setTimeout(() => {
        connect();
      }, 0);
    }

    return () => {
      if (connectTimer) window.clearTimeout(connectTimer);
      isManualDisconnectRef.current = true;
      disconnect();
    };
  }, [url, protocolsDeps, connect, disconnect]); // Depend on protocols so token refresh triggers reconnect

  const sendStreamingRequest = useCallback(
    (
      action: string,
      payload: Record<string, unknown>,
      callbacks: Omit<PendingRequest, "action">,
    ): string | null => {
      const requestId = generateRequestId();
      pendingRequestsRef.current.set(requestId, { action, ...callbacks });

      const success = sendMessage({ action, requestId, ...payload });
      if (!success) {
        pendingRequestsRef.current.delete(requestId);
        return null;
      }
      return requestId;
    },
    [sendMessage],
  );

  const isConnected = connectionState === "connected";

  return {
    sendMessage,
    sendStreamingRequest,
    connect,
    disconnect,
    forceReconnect,
    isConnected,
    connectionState,
  };
};
