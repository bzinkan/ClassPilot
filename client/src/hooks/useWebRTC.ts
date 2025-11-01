import { useRef, useCallback } from 'react';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

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

    // Request screen share from student (but don't send offer yet)
    // The offer will be sent when we receive 'peer-ready' signal
    ws.send(JSON.stringify({
      type: 'request-stream',
      deviceId: deviceId,
    }));

    console.log(`[WebRTC] Requested stream from ${deviceId}, waiting for peer-ready signal...`);

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

  // Handle peer-ready signal from student (student's peer connection is ready)
  const handlePeerReady = useCallback(async (deviceId: string) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error('[WebRTC] WebSocket not connected');
      return;
    }

    const connection = connectionsRef.current.get(deviceId);
    if (!connection) {
      console.error(`[WebRTC] No connection found for ${deviceId}`);
      return;
    }

    console.log(`[WebRTC] Peer ready for ${deviceId}, creating and sending offer`);

    try {
      // Create offer
      const offer = await connection.peerConnection.createOffer({
        offerToReceiveVideo: true,
        offerToReceiveAudio: false,
      });
      await connection.peerConnection.setLocalDescription(offer);

      // Send offer to student
      ws.send(JSON.stringify({
        type: 'offer',
        to: deviceId,
        sdp: connection.peerConnection.localDescription?.toJSON(),
      }));

      console.log(`[WebRTC] Sent offer to ${deviceId}`);
    } catch (error) {
      console.error(`[WebRTC] Error creating/sending offer for ${deviceId}:`, error);
    }
  }, [ws]);

  // Stop live view for a student
  const stopLiveView = useCallback((deviceId: string) => {
    const connection = connectionsRef.current.get(deviceId);
    if (!connection) return;

    console.log(`[WebRTC] Stopping live view for ${deviceId}`);

    // Stop all tracks
    if (connection.stream) {
      connection.stream.getTracks().forEach(track => track.stop());
    }

    // Close peer connection
    connection.peerConnection.close();

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
    handlePeerReady,
    cleanup,
  };
}
