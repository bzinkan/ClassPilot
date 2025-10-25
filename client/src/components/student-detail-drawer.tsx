import { useEffect, useRef, useState } from "react";
import { X, ExternalLink, Clock, Monitor, Video, Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { StudentStatus, Heartbeat } from "@shared/schema";
import { formatDistanceToNow, format } from "date-fns";

interface StudentDetailDrawerProps {
  student: StudentStatus | null;
  urlHistory: Heartbeat[];
  onClose: () => void;
}

export function StudentDetailDrawer({
  student,
  urlHistory,
  onClose,
}: StudentDetailDrawerProps) {
  const { toast } = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [videoLoaded, setVideoLoaded] = useState(false);
  const [pinging, setPinging] = useState(false);

  const handlePing = async () => {
    if (!student) return;
    
    setPinging(true);
    try {
      const response = await apiRequest("POST", `/api/ping/${student.deviceId}`, {
        message: "Your teacher is requesting your attention"
      });
      
      if (response.success) {
        toast({
          title: "Ping sent",
          description: `Notification sent to ${student.studentName}`,
        });
      } else {
        toast({
          variant: "destructive",
          title: "Student offline",
          description: "Unable to send notification - student is not connected",
        });
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Failed to ping",
        description: "An error occurred while sending the notification",
      });
    } finally {
      setPinging(false);
    }
  };

  useEffect(() => {
    if (!student || !student.isSharing) {
      // Cleanup if student stops sharing
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      setVideoLoaded(false);
      return;
    }

    // Setup WebSocket for signaling
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected for WebRTC signaling');
      // Authenticate as teacher
      ws.send(JSON.stringify({ type: 'auth', role: 'teacher' }));
    };

    ws.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        
        if (message.type === 'signal' && message.data.deviceId === student.deviceId) {
          const signal = message.data;
          
          if (signal.type === 'offer') {
            // Student is offering to share screen
            console.log('Received WebRTC offer from student');
            
            // Create peer connection if not exists
            if (!peerConnectionRef.current) {
              const pc = new RTCPeerConnection({
                iceServers: [
                  { urls: 'stun:stun.l.google.com:19302' },
                ],
              });
              peerConnectionRef.current = pc;

              // Handle incoming stream
              pc.ontrack = (event) => {
                console.log('Received video track from student');
                if (videoRef.current && event.streams[0]) {
                  videoRef.current.srcObject = event.streams[0];
                  setVideoLoaded(true);
                }
              };

              // Handle ICE candidates - reuse the same WebSocket
              pc.onicecandidate = (event) => {
                if (event.candidate && ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: 'signal',
                    data: {
                      type: 'ice-candidate',
                      data: event.candidate,
                      deviceId: student.deviceId,
                    },
                  }));
                }
              };

              pc.onconnectionstatechange = () => {
                console.log('WebRTC connection state:', pc.connectionState);
                if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                  setVideoLoaded(false);
                }
              };
            }

            // Handle the offer
            await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(signal.data));
            const answer = await peerConnectionRef.current.createAnswer();
            await peerConnectionRef.current.setLocalDescription(answer);
            
            // Send answer back to student
            ws.send(JSON.stringify({
              type: 'signal',
              data: {
                type: 'answer',
                data: answer,
                deviceId: student.deviceId,
              },
            }));
            
            console.log('Sent WebRTC answer to student');
            
          } else if (signal.type === 'ice-candidate' && peerConnectionRef.current) {
            // Add ICE candidate
            await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(signal.data));
            console.log('Added ICE candidate from student');
          }
        }
      } catch (error) {
        console.error('WebRTC signaling error:', error);
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
    };

    // Cleanup on unmount or student change
    return () => {
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      setVideoLoaded(false);
    };
  }, [student]);

  if (!student) return null;

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'online':
        return 'bg-status-online';
      case 'idle':
        return 'bg-status-away';
      case 'offline':
        return 'bg-status-offline';
      default:
        return 'bg-status-offline';
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'online':
        return 'Online';
      case 'idle':
        return 'Idle';
      case 'offline':
        return 'Offline';
      default:
        return 'Unknown';
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-end bg-background/80 backdrop-blur-sm">
      <div
        className="fixed inset-0"
        onClick={onClose}
        data-testid="overlay-close-drawer"
      />
      <div className="relative w-full max-w-md h-full bg-background border-l border-border shadow-2xl animate-in slide-in-from-right duration-300">
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="p-6 border-b border-border">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-2">
                  <h2 className="text-xl font-semibold truncate">
                    {student.studentName}
                  </h2>
                  <div className={`h-2.5 w-2.5 rounded-full ${getStatusColor(student.status)}`} />
                </div>
                <p className="text-sm font-mono text-muted-foreground truncate">
                  {student.deviceId}
                </p>
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <Badge variant="secondary" className="text-xs">
                    {student.classId}
                  </Badge>
                  <Badge variant="outline" className="text-xs">
                    {getStatusLabel(student.status)}
                  </Badge>
                  {student.isSharing && (
                    <Badge variant="destructive" className="text-xs animate-pulse">
                      <Video className="h-3 w-3 mr-1" />
                      Sharing
                    </Badge>
                  )}
                </div>
                <div className="mt-3">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handlePing}
                    disabled={pinging || student.status === 'offline'}
                    data-testid="button-ping-student"
                  >
                    <Bell className="h-4 w-4 mr-2" />
                    {pinging ? "Sending..." : "Ping Student"}
                  </Button>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={onClose}
                data-testid="button-close-drawer"
              >
                <X className="h-5 w-5" />
              </Button>
            </div>
          </div>

          {/* Content */}
          <ScrollArea className="flex-1">
            <div className="p-6 space-y-6">
              {/* Current Activity */}
              <div>
                <h3 className="text-sm font-medium uppercase tracking-wide text-muted-foreground mb-3">
                  Current Activity
                </h3>
                <div className="space-y-3">
                  <div className="p-4 rounded-lg bg-muted/50 border border-border">
                    <div className="flex items-start gap-2 mb-2">
                      {student.favicon && (
                        <img
                          src={student.favicon}
                          alt=""
                          className="w-4 h-4 flex-shrink-0 mt-0.5"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      )}
                      <p className="text-sm font-medium flex-1">
                        {student.activeTabTitle || "No active tab"}
                      </p>
                    </div>
                    {student.activeTabUrl && (
                      <div className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground">
                        <ExternalLink className="h-3 w-3 flex-shrink-0" />
                        <span className="truncate">{student.activeTabUrl}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-2 pt-2 border-t border-border/50">
                      <Clock className="h-3 w-3" />
                      <span>
                        {formatDistanceToNow(student.lastSeenAt, { addSuffix: true })}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Screen Share Viewer */}
              {student.isSharing && (
                <div>
                  <h3 className="text-sm font-medium uppercase tracking-wide text-muted-foreground mb-3">
                    Screen Share
                  </h3>
                  <div className="relative aspect-video rounded-lg overflow-hidden bg-black border border-border">
                    <video
                      ref={videoRef}
                      autoPlay
                      playsInline
                      muted
                      className="w-full h-full object-contain"
                      data-testid="video-screen-share"
                    />
                    {!videoLoaded && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/90">
                        <div className="text-center text-white/80">
                          <Monitor className="h-12 w-12 mx-auto mb-3 opacity-50 animate-pulse" />
                          <p className="text-sm font-medium mb-1">Connecting to student...</p>
                          <p className="text-xs opacity-70">WebRTC stream will appear here</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* URL History */}
              <div>
                <h3 className="text-sm font-medium uppercase tracking-wide text-muted-foreground mb-3">
                  Recent Activity
                </h3>
                <div className="space-y-2">
                  {urlHistory.length === 0 ? (
                    <div className="p-8 text-center">
                      <Clock className="h-8 w-8 mx-auto mb-2 text-muted-foreground/50" />
                      <p className="text-sm text-muted-foreground">No activity history yet</p>
                    </div>
                  ) : (
                    urlHistory.slice(0, 20).map((item, index) => (
                      <div
                        key={item.id || index}
                        className="p-3 rounded-md bg-muted/30 border-l-4 border-primary/20"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              {item.favicon && (
                                <img
                                  src={item.favicon}
                                  alt=""
                                  className="w-3 h-3 flex-shrink-0"
                                  onError={(e) => {
                                    (e.target as HTMLImageElement).style.display = 'none';
                                  }}
                                />
                              )}
                              <p className="text-sm font-medium truncate">
                                {item.activeTabTitle}
                              </p>
                            </div>
                            <p className="text-xs font-mono text-muted-foreground truncate">
                              {item.activeTabUrl}
                            </p>
                          </div>
                          <span className="text-xs text-muted-foreground whitespace-nowrap">
                            {format(new Date(item.timestamp), 'HH:mm')}
                          </span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}
