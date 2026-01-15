import { useRef, useCallback, useState } from 'react';

// ICE servers configuration
const getIceServers = (): RTCIceServer[] => {
  const servers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

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

interface StudentConnection {
  peerConnection: RTCPeerConnection;
  deviceId: string;
}

export function useTeacherBroadcast(ws: WebSocket | null) {
  const [isBroadcasting, setIsBroadcasting] = useState(false);
  const [viewerCount, setViewerCount] = useState(0);
  const localStreamRef = useRef<MediaStream | null>(null);
  const connectionsRef = useRef<Map<string, StudentConnection>>(new Map());
  const pendingOffersRef = useRef<Map<string, RTCSessionDescriptionInit>>(new Map());

  // Start broadcasting teacher's screen
  const startBroadcast = useCallback(async () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error('[Broadcast] WebSocket not connected');
      throw new Error('Not connected to server');
    }

    try {
      // Capture teacher's screen
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
          displaySurface: 'monitor',
        } as MediaTrackConstraints,
        audio: false,
      });

      localStreamRef.current = stream;

      // Handle when teacher stops sharing via browser UI
      stream.getVideoTracks()[0].onended = () => {
        console.log('[Broadcast] Screen share ended by user');
        stopBroadcast();
      };

      setIsBroadcasting(true);

      // Notify server to broadcast to all students
      ws.send(JSON.stringify({
        type: 'teacher-broadcast-start',
      }));

      console.log('[Broadcast] Started broadcasting');
      return stream;
    } catch (error) {
      console.error('[Broadcast] Error starting broadcast:', error);
      throw error;
    }
  }, [ws]);

  // Stop broadcasting
  const stopBroadcast = useCallback(() => {
    console.log('[Broadcast] Stopping broadcast');

    // Stop local stream
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }

    // Close all peer connections
    connectionsRef.current.forEach((connection) => {
      connection.peerConnection.close();
    });
    connectionsRef.current.clear();
    pendingOffersRef.current.clear();

    setIsBroadcasting(false);
    setViewerCount(0);

    // Notify server
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'teacher-broadcast-stop',
      }));
    }
  }, [ws]);

  // Handle student joining the broadcast
  const handleStudentJoin = useCallback(async (deviceId: string) => {
    if (!localStreamRef.current || !ws || ws.readyState !== WebSocket.OPEN) {
      console.log('[Broadcast] Cannot add student - no stream or ws');
      return;
    }

    console.log(`[Broadcast] Student joining: ${deviceId}`);

    // Create peer connection for this student
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    const connection: StudentConnection = {
      peerConnection: pc,
      deviceId,
    };

    connectionsRef.current.set(deviceId, connection);

    // Add local stream tracks to the connection
    localStreamRef.current.getTracks().forEach(track => {
      pc.addTrack(track, localStreamRef.current!);
    });

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'broadcast-ice',
          to: deviceId,
          candidate: event.candidate.toJSON(),
        }));
      }
    };

    // Handle connection state
    pc.onconnectionstatechange = () => {
      console.log(`[Broadcast] Connection state for ${deviceId}:`, pc.connectionState);
      if (pc.connectionState === 'connected') {
        setViewerCount(prev => prev + 1);
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
        connectionsRef.current.delete(deviceId);
        setViewerCount(prev => Math.max(0, prev - 1));
      }
    };

    // Create and send offer
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      ws.send(JSON.stringify({
        type: 'broadcast-offer',
        to: deviceId,
        sdp: pc.localDescription?.toJSON(),
      }));

      console.log(`[Broadcast] Sent offer to ${deviceId}`);
    } catch (error) {
      console.error(`[Broadcast] Error creating offer for ${deviceId}:`, error);
    }
  }, [ws]);

  // Handle answer from student
  const handleStudentAnswer = useCallback(async (deviceId: string, sdp: RTCSessionDescriptionInit) => {
    const connection = connectionsRef.current.get(deviceId);
    if (!connection) {
      console.log(`[Broadcast] No connection for ${deviceId}, queueing answer`);
      return;
    }

    try {
      await connection.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
      console.log(`[Broadcast] Set remote description for ${deviceId}`);
    } catch (error) {
      console.error(`[Broadcast] Error setting remote description for ${deviceId}:`, error);
    }
  }, []);

  // Handle ICE candidate from student
  const handleStudentIce = useCallback(async (deviceId: string, candidate: RTCIceCandidateInit) => {
    const connection = connectionsRef.current.get(deviceId);
    if (!connection) {
      console.log(`[Broadcast] No connection for ${deviceId}`);
      return;
    }

    try {
      await connection.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      console.log(`[Broadcast] Added ICE candidate for ${deviceId}`);
    } catch (error) {
      console.error(`[Broadcast] Error adding ICE candidate for ${deviceId}:`, error);
    }
  }, []);

  // Handle student leaving
  const handleStudentLeave = useCallback((deviceId: string) => {
    const connection = connectionsRef.current.get(deviceId);
    if (connection) {
      connection.peerConnection.close();
      connectionsRef.current.delete(deviceId);
      setViewerCount(prev => Math.max(0, prev - 1));
      console.log(`[Broadcast] Student left: ${deviceId}`);
    }
  }, []);

  // Get local stream for preview
  const getLocalStream = useCallback(() => {
    return localStreamRef.current;
  }, []);

  return {
    isBroadcasting,
    viewerCount,
    startBroadcast,
    stopBroadcast,
    handleStudentJoin,
    handleStudentAnswer,
    handleStudentIce,
    handleStudentLeave,
    getLocalStream,
  };
}
