import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { invalidateStudentCaches } from '@/lib/cacheUtils';

interface CurrentUser {
  id: string;
  username: string;
  role: 'admin' | 'teacher';
  schoolId: string;
}

interface WebSocketContextValue {
  ws: WebSocket | null;
  isConnected: boolean;
  sendMessage: (message: any) => void;
}

const WebSocketContext = createContext<WebSocketContextValue>({
  ws: null,
  isConnected: false,
  sendMessage: () => {},
});

export function useWebSocket() {
  return useContext(WebSocketContext);
}

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const isMountedRef = useRef(true);
  const maxReconnectDelay = 30000;

  const { data: currentUserData, isSuccess: isUserDataLoaded } = useQuery<{ success: boolean; user: CurrentUser }>({
    queryKey: ['/api/me'],
  });

  const currentUser = currentUserData?.user;

  useEffect(() => {
    // Don't connect until we have authenticated user data
    if (!isUserDataLoaded || !currentUser?.id) {
      console.log("[WebSocket] Waiting for authentication before connecting...");
      return;
    }

    isMountedRef.current = true;

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
          reconnectAttemptsRef.current = 0;
          
          if (currentUser?.id) {
            socket.send(JSON.stringify({ type: 'auth', role: 'teacher', userId: currentUser.id }));
            console.log("[WebSocket] Authenticated with userId:", currentUser.id);
          }
        };

        socket.onmessage = (event) => {
          if (!isMountedRef.current) return;
          
          try {
            const message = JSON.parse(event.data);
            console.log("[WebSocket] Message received:", message);
            
            if (message.type === 'student-registered') {
              console.log("[WebSocket] Student registered, invalidating caches...", message.data);
              invalidateStudentCaches();
            }
          } catch (error) {
            console.error("[WebSocket] Message error:", error);
          }
        };

        socket.onclose = (event) => {
          console.log("[WebSocket] Disconnected, code:", event.code);
          
          if (!isMountedRef.current) {
            console.log("[WebSocket] App unmounted, skipping reconnection");
            return;
          }
          
          setIsConnected(false);
          wsRef.current = null;
          
          reconnectAttemptsRef.current++;
          const delay = Math.min(
            1000 * Math.pow(2, reconnectAttemptsRef.current - 1),
            maxReconnectDelay
          );
          
          console.log(`[WebSocket] Reconnecting in ${delay}ms...`);
          reconnectTimeoutRef.current = setTimeout(connectWebSocket, delay);
        };

        socket.onerror = (error) => {
          if (!isMountedRef.current) return;
          console.error("[WebSocket] Error:", error);
          setIsConnected(false);
        };
      } catch (error) {
        console.error("[WebSocket] Failed to create connection:", error);
        setIsConnected(false);
        
        reconnectAttemptsRef.current++;
        const delay = Math.min(
          1000 * Math.pow(2, reconnectAttemptsRef.current - 1),
          maxReconnectDelay
        );
        reconnectTimeoutRef.current = setTimeout(connectWebSocket, delay);
      }
    };

    connectWebSocket();

    return () => {
      console.log("[WebSocket] Cleaning up global connection");
      isMountedRef.current = false;
      
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setIsConnected(false);
    };
  }, [currentUser?.id, isUserDataLoaded]);

  const sendMessage = (message: any) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    } else {
      console.warn("[WebSocket] Cannot send message - not connected");
    }
  };

  return (
    <WebSocketContext.Provider value={{ ws: wsRef.current, isConnected, sendMessage }}>
      {children}
    </WebSocketContext.Provider>
  );
}
