import { useRef, useCallback } from 'react';

// ICE servers configuration - STUN for most cases, TURN for restrictive networks
const getIceServers = (): RTCIceServer[] => {
  const servers: RTCIceServer[] = [
    // Google's public STUN servers (reliable, free)
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  // Only add TURN servers if credentials are configured
  const turnUsername = import.meta.env.VITE_TURN_USERNAME;
  const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL;

  if (turnUsername && turnCredential) {
    servers.push({
      username: turnUsername,
      credential: turnCredential,
      urls: [
        'turn:us-turn7.xirsys.com:80?transport=udp',
        'turn:us-turn7.xirsys.com:3478?transport=udp',
        'turn:us-turn7.xirsys.com:80?transport=tcp',
        'turn:us-turn7.xirsys.com:3478?transport=tcp',
        'turns:us-turn7.xirsys.com:443?transport=tcp',
        'turns:us-turn7.xirsys.com:5349?transport=tcp'
      ]
    });
  }

  return servers;
};

const ICE_SERVERS = getIceServers();

interface WebRTCConnection {
  peerConnection: RTCPeerConnection;
  stream: MediaStream | null;
  onStreamReceived: (stream: MediaStream) => void;
}

export function useWebRTC(ws: WebSocket | null) {
  // Map of deviceId -> WebRTC connection
  const connectionsRef = useRef<Map<string, WebRTCConnection>>(new Map());

  // Start live view for a student
  const startLiveView = useCallback(async (deviceId: string, onStreamReceived: (stream: MediaStream) => void) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error('[WebRTC] WebSocket not connected');
      return null;
    }

    console.log(`[WebRTC] Starting live view for device ${deviceId}`);

    // Create peer connection
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    
    const connection: WebRTCConnection = {
      peerConnection: pc,
      stream: null,
      onStreamReceived
    };
    
    connectionsRef.current.set(deviceId, connection);

    // Handle incoming stream
    pc.ontrack = (event) => {
      console.log(`[WebRTC] Received track from ${deviceId}:`, event.track.kind);
      const [stream] = event.streams;
      if (stream) {
        connection.stream = stream;
        onStreamReceived(stream);
      }
    };

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'ice',
          to: deviceId,
          candidate: event.candidate.toJSON(),
        }));
      }
    };

    // Handle connection state changes
    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] Connection state for ${deviceId}:`, pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        stopLiveView(deviceId);
      }
    };

    // Request screen share from student
    ws.send(JSON.stringify({
      type: 'request-stream',
      deviceId: deviceId,
    }));

    console.log(`[WebRTC] Requested stream from ${deviceId}`);

    // Send offer immediately (student will queue it if not ready yet)
    try {
      const offer = await pc.createOffer({
        offerToReceiveVideo: true,
        offerToReceiveAudio: false,
      });
      await pc.setLocalDescription(offer);

      ws.send(JSON.stringify({
        type: 'offer',
        to: deviceId,
        sdp: pc.localDescription?.toJSON(),
      }));

      console.log(`[WebRTC] Sent offer to ${deviceId}`);
    } catch (error) {
      console.error(`[WebRTC] Error creating/sending offer for ${deviceId}:`, error);
    }

    return connection;
  }, [ws]);

  // Handle answer from student
  const handleAnswer = useCallback(async (deviceId: string, sdp: RTCSessionDescriptionInit) => {
    const connection = connectionsRef.current.get(deviceId);
    if (!connection) {
      console.error(`[WebRTC] No connection found for ${deviceId}`);
      return;
    }

    try {
      await connection.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
      console.log(`[WebRTC] Set remote description for ${deviceId}`);
    } catch (error) {
      console.error(`[WebRTC] Error setting remote description for ${deviceId}:`, error);
    }
  }, []);

  // Handle ICE candidate from student
  const handleIceCandidate = useCallback(async (deviceId: string, candidate: RTCIceCandidateInit) => {
    const connection = connectionsRef.current.get(deviceId);
    if (!connection) {
      console.error(`[WebRTC] No connection found for ${deviceId}`);
      return;
    }

    try {
      await connection.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      console.log(`[WebRTC] Added ICE candidate for ${deviceId}`);
    } catch (error) {
      console.error(`[WebRTC] Error adding ICE candidate for ${deviceId}:`, error);
    }
  }, []);


  // Stop live view for a student
  const stopLiveView = useCallback((deviceId: string, ws?: WebSocket | null) => {
    const connection = connectionsRef.current.get(deviceId);
    if (!connection) return;

    console.log(`[WebRTC] Stopping live view for ${deviceId}`);

    // Stop all tracks
    if (connection.stream) {
      connection.stream.getTracks().forEach(track => track.stop());
    }

    // Close peer connection
    connection.peerConnection.close();

    // Tell student to stop sharing
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'stop-share',
        deviceId: deviceId,
      }));
      console.log(`[WebRTC] Sent stop-share to ${deviceId}`);
    }

    // Remove from map
    connectionsRef.current.delete(deviceId);
  }, []);

  // Cleanup all connections
  const cleanup = useCallback(() => {
    console.log('[WebRTC] Cleaning up all connections');
    connectionsRef.current.forEach((_, deviceId) => {
      stopLiveView(deviceId);
    });
    connectionsRef.current.clear();
  }, [stopLiveView]);

  return {
    startLiveView,
    stopLiveView,
    handleAnswer,
    handleIceCandidate,
    cleanup,
  };
}
