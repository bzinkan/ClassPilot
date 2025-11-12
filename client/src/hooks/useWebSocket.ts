import { useEffect, useRef, useState } from 'react';

interface UseWebSocketOptions {
  role?: 'teacher' | 'admin';
  userId?: string;
  onMessage?: (message: any) => void;
  onConnectionChange?: (connected: boolean) => void;
  enabled?: boolean; // Allow disabling the connection
}

const MAX_RECONNECT_DELAY = 30000; // 30 seconds

export function useWebSocket(options: UseWebSocketOptions = {}) {
  const {
    role,
    userId,
    onMessage,
    onConnectionChange,
    enabled = true,
  } = options;

  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const isMountedRef = useRef(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const onMessageRef = useRef(onMessage);
  const onConnectionChangeRef = useRef(onConnectionChange);

  // Keep refs up to date without triggering reconnection
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    onConnectionChangeRef.current = onConnectionChange;
  }, [onConnectionChange]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    isMountedRef.current = true;
    
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    
    reconnectAttemptsRef.current = 0;
    
    const connectWebSocket = () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      console.log('[WebSocket] Connecting (attempt', reconnectAttemptsRef.current + 1, '):', wsUrl);
      
      try {
        const socket = new WebSocket(wsUrl);
        wsRef.current = socket;

        socket.onopen = () => {
          if (!isMountedRef.current) return;
          
          console.log("[WebSocket] Connected successfully");
          setIsConnected(true);
          onConnectionChangeRef.current?.(true);
          reconnectAttemptsRef.current = 0;
          
          // Authenticate with role and userId
          if (role && userId) {
            socket.send(JSON.stringify({ type: 'auth', role, userId }));
            console.log("[WebSocket] Sent auth message:", { role, userId });
          }
        };

        socket.onmessage = (event) => {
          if (!isMountedRef.current) return;
          
          try {
            const message = JSON.parse(event.data);
            console.log("[WebSocket] Message received:", message);
            onMessageRef.current?.(message);
          } catch (error) {
            console.error("[WebSocket] Message parse error:", error);
          }
        };

        socket.onclose = (event) => {
          console.log("[WebSocket] Disconnected, code:", event.code, "reason:", event.reason);
          
          if (!isMountedRef.current) {
            console.log("[WebSocket] Component unmounted, skipping reconnection");
            return;
          }
          
          setIsConnected(false);
          onConnectionChangeRef.current?.(false);
          wsRef.current = null;
          
          // Reconnect with exponential backoff
          reconnectAttemptsRef.current++;
          const delay = Math.min(
            1000 * Math.pow(2, reconnectAttemptsRef.current - 1),
            MAX_RECONNECT_DELAY
          );
          
          console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current})...`);
          reconnectTimeoutRef.current = setTimeout(connectWebSocket, delay);
        };

        socket.onerror = (error) => {
          if (!isMountedRef.current) return;
          
          console.error("[WebSocket] Error:", error);
          setIsConnected(false);
          onConnectionChangeRef.current?.(false);
        };
      } catch (error) {
        console.error("[WebSocket] Failed to create connection:", error);
        setIsConnected(false);
        onConnectionChangeRef.current?.(false);
        
        reconnectAttemptsRef.current++;
        const delay = Math.min(
          1000 * Math.pow(2, reconnectAttemptsRef.current - 1),
          MAX_RECONNECT_DELAY
        );
        reconnectTimeoutRef.current = setTimeout(connectWebSocket, delay);
      }
    };

    connectWebSocket();

    return () => {
      console.log("[WebSocket] Cleaning up connection");
      isMountedRef.current = false;
      
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [enabled, role, userId]); // Reconnect if role or userId changes

  return {
    ws: wsRef.current,
    isConnected,
    sendMessage: (message: any) => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(message));
      } else {
        console.warn("[WebSocket] Cannot send message - not connected");
      }
    },
  };
}
