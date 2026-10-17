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
  const connectRef = useRef<() => void>(() => {});

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

    reconnectTimeoutRef.current = window.setTimeout(async () => {
      reconnectAttemptsRef.current++;

      // Refresh token before reconnecting
      if (callbacksRef.current.protocols) {
        try {
          const session = await fetchAuthSession();
          const freshToken = session.tokens?.idToken?.toString();

          if (freshToken) {
            // Rebuild protocols as [freshToken, ...static] so the application
            // subprotocol (e.g. "chat.v1") is always offered again. Sourcing the
            // static part from the ref — not from the possibly-stale current
            // protocols — prevents it from being dropped across reconnects.
            callbacksRef.current.protocols = [
              freshToken,
              ...staticSubprotocolsRef.current,
            ];
          } else {
            setConnectionState("error");
            return; // Abort reconnection - user needs to re-authenticate
          }
        } catch (error) {
          setConnectionState("error");
          return; // Abort reconnection - auth is broken
        }
      }

      if (connectRef.current) {
        connectRef.current();
      }
    }, delay);
  }, []);

  const connect = useCallback(() => {
    if (
      !url ||
      wsRef.current?.readyState === WebSocket.CONNECTING ||
      wsRef.current?.readyState === WebSocket.OPEN
    ) {
      return;
    }

    setConnectionState("connecting");

    try {
      // Use protocols from the current options ref if available. Normalize so the
      // static application subprotocols (e.g. "chat.v1") are always offered
      // alongside the token — the server selects one of these to complete the
      // handshake, and a connection that offers only the token can never succeed.
      const rawProtocols = callbacksRef.current.protocols;
      let protocols: string | string[] | undefined = rawProtocols;
      if (rawProtocols) {
        const list = Array.isArray(rawProtocols) ? rawProtocols : [rawProtocols];
        const missingStatic = staticSubprotocolsRef.current.filter(
          (p) => !list.includes(p),
        );
        protocols = [...list, ...missingStatic];
      }
      wsRef.current = protocols
        ? new WebSocket(url, protocols)
        : new WebSocket(url);

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
      setConnectionState("error");
      scheduleReconnect();
    }
  }, [url, startHeartbeat, stopHeartbeat, scheduleReconnect]);

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

    const protocols = callbacksRef.current.protocols;
    const token = Array.isArray(protocols) ? protocols[0] : protocols;
    if (!token || typeof token !== "string") {
      clearTokenRotationTimer();
      return;
    }

    const expiryMs = parseJwtExpiryMs(token);
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
  }, [
    connectionState,
    protocolsDeps,
    forceReconnect,
    clearTokenRotationTimer,
    parseJwtExpiryMs,
  ]);

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
