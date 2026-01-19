import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Monitor, Users, Activity, Settings as SettingsIcon, LogOut, Download, Calendar, Shield, AlertTriangle, UserCog, Plus, X, GraduationCap, WifiOff, Video, MonitorPlay, TabletSmartphone, Lock, Unlock, Layers, Route, CheckSquare, XSquare, User, List, ShieldBan, Eye, EyeOff, Timer, Clock, BarChart3, Trash2, UsersRound, Filter, Hand, MessageSquareOff, MessageSquare, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { StudentTile } from "@/components/student-tile";
import { StudentDetailDrawer } from "@/components/student-detail-drawer";
import { RemoteControlToolbar } from "@/components/remote-control-toolbar";
import { ThemeToggle } from "@/components/theme-toggle";
import { TeacherFab } from "@/components/teacher-fab";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useWebRTC } from "@/hooks/useWebRTC";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { StudentStatus, AggregatedStudentStatus, Heartbeat, Settings, FlightPath, Group, Session, BlockList, Subgroup } from "@shared/schema";
import { isWithinTrackingHours } from "@shared/utils";

// Helper to normalize grade levels (strip "th", "rd", "st", "nd" suffixes)
function normalizeGrade(grade: string | null | undefined): string | null {
  if (!grade) return null;
  const trimmed = grade.trim();
  if (!trimmed) return null;
  // Remove ordinal suffixes (1st, 2nd, 3rd, 4th, etc.)
  return trimmed.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');
}

interface CurrentUser {
  id: string;
  username: string;
  role: string;
  schoolName: string;
  impersonating?: boolean;
}

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const [selectedStudent, setSelectedStudent] = useState<AggregatedStudentStatus | null>(null);
  const [selectedStudentIds, setSelectedStudentIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedGrade, setSelectedGrade] = useState<string>(() => {
    // Initialize from localStorage if available
    try {
      const saved = localStorage.getItem('classpilot-selected-grade');
      return saved || "";
    } catch {
      return "";
    }
  });
  const [wsConnected, setWsConnected] = useState(false);
  const [liveStreams, setLiveStreams] = useState<Map<string, MediaStream>>(new Map());
  const [tileRevisions, setTileRevisions] = useState<Record<string, number>>({});
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportStartDate, setExportStartDate] = useState("");
  const [exportEndDate, setExportEndDate] = useState("");
  const [showGradeDialog, setShowGradeDialog] = useState(false);
  const [newGrade, setNewGrade] = useState("");
  const [showOpenTabDialog, setShowOpenTabDialog] = useState(false);
  const [openTabUrl, setOpenTabUrl] = useState("");
  const [showCloseTabsDialog, setShowCloseTabsDialog] = useState(false);
  // Track selected tabs by composite key: "studentId|deviceId|url"
  const [selectedTabsToClose, setSelectedTabsToClose] = useState<Set<string>>(new Set());
  const [showApplyFlightPathDialog, setShowApplyFlightPathDialog] = useState(false);
  const [selectedFlightPathId, setSelectedFlightPathId] = useState("");
  const [showFlightPathViewerDialog, setShowFlightPathViewerDialog] = useState(false);
  const [showApplyBlockListDialog, setShowApplyBlockListDialog] = useState(false);
  const [selectedBlockListId, setSelectedBlockListId] = useState("");
  const [showBlockListViewerDialog, setShowBlockListViewerDialog] = useState(false);
  const [showAttentionDialog, setShowAttentionDialog] = useState(false);
  const [attentionMessage, setAttentionMessage] = useState("Please look up!");
  const [attentionActive, setAttentionActive] = useState(false);
  const [showTimerDialog, setShowTimerDialog] = useState(false);
  const [timerMinutes, setTimerMinutes] = useState(5);
  const [timerSeconds, setTimerSeconds] = useState(0);
  const [timerMessage, setTimerMessage] = useState("");
  const [timerActive, setTimerActive] = useState(false);
  const [showPollDialog, setShowPollDialog] = useState(false);
  const [showPollResultsDialog, setShowPollResultsDialog] = useState(false);
  const [pollQuestion, setPollQuestion] = useState("");
  const [pollOptions, setPollOptions] = useState(["", ""]);
  const [activePoll, setActivePoll] = useState<{ id: string; question: string; options: string[] } | null>(null);
  const [pollResults, setPollResults] = useState<{ option: number; count: number }[]>([]);
  const [pollTotalResponses, setPollTotalResponses] = useState(0);
  const [selectedSubgroupId, setSelectedSubgroupId] = useState<string>("");
  const [subgroupMembers, setSubgroupMembers] = useState<Set<string>>(new Set());
  const [raisedHands, setRaisedHands] = useState<Map<string, { studentId: string; studentName: string; studentEmail: string; timestamp: string }>>(new Map());
  const [studentMessages, setStudentMessages] = useState<Array<{ id: string; studentId: string; studentName: string; studentEmail: string; message: string; messageType: string; timestamp: string; read: boolean }>>([]);
  const [replyingToMessage, setReplyingToMessage] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const { toast } = useToast();
  const notifiedViolations = useRef<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const isMountedRef = useRef(true); // Track if component is mounted
  const invalidateTimeoutRef = useRef<NodeJS.Timeout | null>(null); // Debounce WebSocket invalidations
  const optimisticUpdateUntilRef = useRef<number>(0); // Skip WS refetches until this timestamp
  const maxReconnectDelay = 30000; // 30 seconds max delay
  const [wsAuthenticated, setWsAuthenticated] = useState(false); // Track WebSocket auth state

  // WebRTC hook for live video streaming
  const webrtc = useWebRTC(wsRef.current);

  const { data: students = [], refetch } = useQuery<AggregatedStudentStatus[]>({
    queryKey: ['/api/students-aggregated'],
    // Custom refetch interval that respects optimistic update period
    refetchInterval: () => {
      // Skip polling during optimistic update period to prevent flickering
      if (Date.now() < optimisticUpdateUntilRef.current) {
        return false; // Don't refetch
      }
      return 10000; // Poll every 10 seconds
    },
  });

  const { data: urlHistory = [] } = useQuery<Heartbeat[]>({
    queryKey: ['/api/heartbeats', selectedStudent?.primaryDeviceId],
    enabled: !!selectedStudent,
  });

  const { data: settings } = useQuery<Settings>({
    queryKey: ['/api/settings'],
  });

  const { data: flightPaths = [] } = useQuery<FlightPath[]>({
    queryKey: ['/api/flight-paths'],
  });

  const { data: blockLists = [] } = useQuery<BlockList[]>({
    queryKey: ['/api/block-lists'],
  });

  const { data: currentUserData } = useQuery<{ success: boolean; user: CurrentUser }>({
    queryKey: ['/api/me'],
  });

  const currentUser = currentUserData?.user;

  // Fetch active session and groups
  const { data: activeSession } = useQuery<Session | null>({
    queryKey: ['/api/sessions/active'],
    refetchInterval: 10000, // Check every 10 seconds
  });

  const { data: groups = [] } = useQuery<Group[]>({
    queryKey: ['/api/teacher/groups'],
  });

  // Fetch subgroups for the active session's group
  const { data: subgroups = [] } = useQuery<Subgroup[]>({
    queryKey: ['/api/groups', activeSession?.groupId, 'subgroups'],
    queryFn: async () => {
      if (!activeSession?.groupId) return [];
      const res = await apiRequest('GET', `/api/groups/${activeSession.groupId}/subgroups`);
      const data = await res.json();
      return data.subgroups || [];
    },
    enabled: !!activeSession?.groupId,
  });

  // Fetch students in the active session's group
  const { data: sessionStudentIds = [] } = useQuery<string[]>({
    queryKey: ['/api/groups', activeSession?.groupId, 'students'],
    enabled: !!activeSession?.groupId,
    select: (data: any[]) => data.map((s: any) => s.id),
  });

  // Fetch initial raised hands
  const { data: initialRaisedHands } = useQuery<{ raisedHands: { id: string; studentId: string; studentName: string; studentEmail: string; timestamp: string }[] }>({
    queryKey: ['/api/teacher/raised-hands'],
    refetchInterval: 30000, // Refresh every 30 seconds as backup
  });

  // Fetch initial student messages
  const { data: initialStudentMessages } = useQuery<{ messages: Array<{ id: string; studentId: string; studentName: string; studentEmail: string; message: string; messageType: string; createdAt: string }> }>({
    queryKey: ['/api/teacher/messages'],
    refetchInterval: 30000, // Refresh every 30 seconds as backup
  });

  // Sync initial raised hands to state
  useEffect(() => {
    if (initialRaisedHands?.raisedHands) {
      const handsMap = new Map<string, { studentId: string; studentName: string; studentEmail: string; timestamp: string }>();
      initialRaisedHands.raisedHands.forEach(hand => {
        handsMap.set(hand.studentId, {
          studentId: hand.studentId,
          studentName: hand.studentName,
          studentEmail: hand.studentEmail,
          timestamp: hand.timestamp,
        });
      });
      setRaisedHands(handsMap);
    }
  }, [initialRaisedHands]);

  // Sync initial student messages to state
  useEffect(() => {
    if (initialStudentMessages?.messages) {
      setStudentMessages(initialStudentMessages.messages.map(msg => ({
        id: msg.id,
        studentId: msg.studentId,
        studentName: msg.studentName,
        studentEmail: msg.studentEmail,
        message: msg.message,
        messageType: msg.messageType,
        timestamp: msg.createdAt,
        read: false,
      })));
    }
  }, [initialStudentMessages]);

  // WebSocket connection with automatic reconnection
  useEffect(() => {
    // Mark component as mounted (important for React StrictMode double-invocation)
    isMountedRef.current = true;
    
    // Clear any stale reconnection timeouts from previous mounts
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    
    // Reset reconnection attempts counter for fresh mount
    reconnectAttemptsRef.current = 0;
    
    const connectWebSocket = () => {
      // Clear any existing reconnection timeout
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      // Close existing connection if any
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      console.log('[Dashboard] Connecting to WebSocket (attempt', reconnectAttemptsRef.current + 1, '):', wsUrl);
      
      try {
        const socket = new WebSocket(wsUrl);
        wsRef.current = socket;

        socket.onopen = () => {
          if (!isMountedRef.current) return; // Don't update state if unmounted
          
          console.log("[Dashboard] WebSocket connected successfully");
          setWsConnected(true);
          reconnectAttemptsRef.current = 0; // Reset reconnection counter on successful connection
          
          // Authenticate as teacher with userId
          if (currentUser?.id) {
            socket.send(JSON.stringify({ type: 'auth', role: 'teacher', userId: currentUser.id }));
            console.log("[Dashboard] Sent auth message with userId:", currentUser.id);
          } else {
            console.warn("[Dashboard] Cannot authenticate - currentUser not available yet");
          }
        };

        socket.onmessage = (event) => {
          if (!isMountedRef.current) return; // Don't process messages if unmounted

          try {
            const message = JSON.parse(event.data);
            console.log("[Dashboard] WebSocket message received:", message);

            // Handle authentication response
            if (message.type === 'auth-success') {
              console.log("[Dashboard] WebSocket authenticated successfully");
              setWsAuthenticated(true);
            }

            if (message.type === 'auth-error') {
              console.error("[Dashboard] WebSocket auth error:", message.message);
              setWsAuthenticated(false);
            }

            if (message.type === 'student-update') {
              // Skip refetches during optimistic update period to prevent flickering
              // After lock/unlock/flight path actions, we show optimistic state for 3 seconds
              // before allowing WebSocket updates to trigger refetches
              if (Date.now() < optimisticUpdateUntilRef.current) {
                console.log("[Dashboard] Skipping refetch during optimistic update period");
                return;
              }

              // Debounce invalidations to coalesce multiple rapid updates into one refetch
              if (invalidateTimeoutRef.current) {
                clearTimeout(invalidateTimeoutRef.current);
              }
              invalidateTimeoutRef.current = setTimeout(() => {
                // Double-check we're still outside optimistic period
                if (Date.now() < optimisticUpdateUntilRef.current) {
                  console.log("[Dashboard] Skipping delayed refetch during optimistic update period");
                  return;
                }
                console.log("[Dashboard] Student update detected, invalidating queries...");
                queryClient.invalidateQueries({ queryKey: ['/api/students-aggregated'] });
                invalidateTimeoutRef.current = null;
              }, 300); // 300ms debounce - coalesces rapid updates
            }

            // Handle WebRTC signaling messages
            if (message.type === 'answer') {
              console.log("[Dashboard] Received WebRTC answer from", message.from);
              webrtc.handleAnswer(message.from, message.sdp);
            }

            if (message.type === 'ice') {
              console.log("[Dashboard] Received ICE candidate from", message.from);
              webrtc.handleIceCandidate(message.from, message.candidate);
            }

            // Handle raised hand notifications
            if (message.type === 'hand-raised') {
              console.log("[Dashboard] Hand raised:", message.data);
              setRaisedHands(prev => {
                const newMap = new Map(prev);
                newMap.set(message.data.studentId, {
                  studentId: message.data.studentId,
                  studentName: message.data.studentName,
                  studentEmail: message.data.studentEmail,
                  timestamp: message.data.timestamp,
                });
                return newMap;
              });
              toast({
                title: "✋ Hand Raised",
                description: `${message.data.studentName} is asking for help`,
              });
            }

            if (message.type === 'hand-lowered') {
              console.log("[Dashboard] Hand lowered:", message.data);
              setRaisedHands(prev => {
                const newMap = new Map(prev);
                newMap.delete(message.data.studentId);
                return newMap;
              });
            }

            // Handle student messages (two-way chat)
            if (message.type === 'student-message') {
              console.log("[Dashboard] Student message received:", message.data);
              const newMsg = {
                id: message.data.id,
                studentId: message.data.studentId,
                studentName: message.data.studentName,
                studentEmail: message.data.studentEmail,
                message: message.data.message,
                messageType: message.data.messageType,
                timestamp: message.data.timestamp,
                read: false,
              };
              setStudentMessages(prev => [newMsg, ...prev]);
              toast({
                title: message.data.messageType === 'question' ? "❓ Question" : "💬 Message",
                description: `${message.data.studentName}: ${message.data.message.slice(0, 50)}${message.data.message.length > 50 ? '...' : ''}`,
              });
            }

            } catch (error) {
            console.error("[Dashboard] WebSocket message error:", error);
          }
        };

        socket.onclose = (event) => {
          console.log("[Dashboard] WebSocket disconnected, code:", event.code, "reason:", event.reason);
          
          // Only update state and reconnect if component is still mounted
          if (!isMountedRef.current) {
            console.log("[Dashboard] Component unmounted, skipping reconnection");
            return;
          }
          
          setWsConnected(false);
          setWsAuthenticated(false); // Reset auth state on disconnect
          wsRef.current = null;
          
          // Attempt to reconnect with exponential backoff
          reconnectAttemptsRef.current++;
          const delay = Math.min(
            1000 * Math.pow(2, reconnectAttemptsRef.current - 1), // Exponential: 1s, 2s, 4s, 8s, 16s...
            maxReconnectDelay // Cap at 30 seconds
          );
          
          console.log(`[Dashboard] Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current})...`);
          reconnectTimeoutRef.current = setTimeout(connectWebSocket, delay);
        };

        socket.onerror = (error) => {
          if (!isMountedRef.current) return; // Don't update state if unmounted
          
          console.error("[Dashboard] WebSocket error:", error);
          setWsConnected(false);
        };
      } catch (error) {
        console.error("[Dashboard] Failed to create WebSocket:", error);
        setWsConnected(false);
        
        // Attempt to reconnect
        reconnectAttemptsRef.current++;
        const delay = Math.min(
          1000 * Math.pow(2, reconnectAttemptsRef.current - 1),
          maxReconnectDelay
        );
        reconnectTimeoutRef.current = setTimeout(connectWebSocket, delay);
      }
    };

    // Initial connection
    connectWebSocket();

    // Cleanup on unmount
    return () => {
      console.log("[Dashboard] Cleaning up WebSocket connection");
      isMountedRef.current = false; // Mark as unmounted to prevent reconnection
      
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      
      // Clean up WebRTC connections
      webrtc.cleanup();
    };
  }, []); // Empty deps - WebSocket connection should only be created once

  // Re-authenticate when currentUser becomes available (for teachers)
  useEffect(() => {
    if (!currentUser?.id) {
      console.log("[Dashboard] Waiting for currentUser...");
      return;
    }
    if (!wsRef.current) {
      console.log("[Dashboard] WebSocket not ready yet, will auth on connect");
      return;
    }
    if (wsRef.current.readyState !== WebSocket.OPEN) {
      console.log("[Dashboard] WebSocket not open yet, state:", wsRef.current.readyState);
      return;
    }
    if (wsAuthenticated) {
      console.log("[Dashboard] Already authenticated, skipping re-auth");
      return;
    }
    console.log("[Dashboard] Sending auth with userId:", currentUser.id);
    wsRef.current.send(JSON.stringify({ type: 'auth', role: currentUser.role || 'teacher', userId: currentUser.id }));
  }, [currentUser?.id, currentUser?.role, wsConnected, wsAuthenticated]);

  // Set initial grade when settings load and validate saved grade
  useEffect(() => {
    if (settings?.gradeLevels && settings.gradeLevels.length > 0) {
      // If no grade selected or saved grade is not in current grade levels, set to first grade
      if (!selectedGrade || !settings.gradeLevels.includes(selectedGrade)) {
        setSelectedGrade(settings.gradeLevels[0]);
      }
    }
  }, [settings, selectedGrade]);

  // Save selected grade to localStorage whenever it changes
  useEffect(() => {
    if (selectedGrade) {
      try {
        localStorage.setItem('classpilot-selected-grade', selectedGrade);
      } catch (error) {
        console.warn('Failed to save selected grade to localStorage:', error);
      }
    }
  }, [selectedGrade]);

  // Check if student is off-task (not on allowed domains OR camera is active)
  const isStudentOffTask = (student: AggregatedStudentStatus): boolean => {
    // Camera active = always off-task
    if (student.cameraActive) return true;
    
    // Only check if allowedDomains is configured and has entries
    if (!settings?.allowedDomains || settings.allowedDomains.length === 0) return false;
    if (!student.activeTabUrl) return false;
    if (student.status !== 'online') return false; // Only check online students
    
    try {
      const hostname = new URL(student.activeTabUrl).hostname.toLowerCase();
      
      // Check if student is on any allowed domain (flexible matching)
      const isOnAllowedDomain = settings.allowedDomains.some(allowed => {
        const allowedLower = allowed.toLowerCase().trim();
        
        // Flexible domain matching: check if the allowed domain appears in the hostname
        // This allows ixl.com to match: ixl.com, www.ixl.com, signin.ixl.com, etc.
        return (
          hostname === allowedLower ||                        // Exact match: ixl.com
          hostname.endsWith('.' + allowedLower) ||            // Subdomain: www.ixl.com
          hostname.includes('.' + allowedLower + '.') ||      // Middle segment: sub.ixl.com.au
          hostname.startsWith(allowedLower + '.') ||          // Starts with: ixl.com.au
          hostname.includes(allowedLower)                     // Contains anywhere (most flexible)
        );
      });
      
      return !isOnAllowedDomain; // Off-task if NOT on allowed domain
    } catch {
      return false;
    }
  };

  // Helper function to get last name for sorting
  const getLastName = (fullName: string | null): string => {
    if (!fullName) return '';
    
    const nameParts = fullName.trim().split(/\s+/);
    
    // If there's only one part (no space), use the whole name
    if (nameParts.length === 1) {
      return nameParts[0].toLowerCase();
    }
    
    // Otherwise, use the last part as the last name
    return nameParts[nameParts.length - 1].toLowerCase();
  };

  // Selection handlers
  const toggleStudentSelection = (studentId: string) => {
    setSelectedStudentIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(studentId)) {
        newSet.delete(studentId);
      } else {
        newSet.add(studentId);
      }
      return newSet;
    });
  };

  const selectAll = () => {
    const allStudentIds = filteredStudents.map((s) => s.studentId);
    setSelectedStudentIds(new Set(allStudentIds));
  };

  const clearSelection = () => {
    setSelectedStudentIds(new Set());
  };

  // Live view handlers
  const handleStartLiveView = async (deviceId: string) => {
    // Ensure WebSocket is authenticated before starting WebRTC
    if (!wsAuthenticated) {
      console.warn('[Dashboard] Cannot start live view - WebSocket not authenticated yet');
      toast({
        title: "Not Ready",
        description: "Please wait for connection to be established",
        variant: "destructive",
      });
      return;
    }

    await webrtc.startLiveView(deviceId, (stream) => {
      console.log(`[Dashboard] Received stream for ${deviceId}`);
      setLiveStreams((prev) => {
        const newMap = new Map(prev);
        newMap.set(deviceId, stream);
        return newMap;
      });
    });
  };

  // Refresh a single tile by bumping its revision
  const refreshTile = (deviceId: string) => {
    setTileRevisions((prev) => ({ 
      ...prev, 
      [deviceId]: (prev[deviceId] ?? 0) + 1 
    }));
  };

  const handleStopLiveView = (deviceId: string) => {
    console.log(`[Dashboard] Stopping live view for ${deviceId}`);
    
    // Stop WebRTC connection and notify student
    webrtc.stopLiveView(deviceId, wsRef.current);
    
    // Clear stream from state
    setLiveStreams((prev) => {
      const newMap = new Map(prev);
      newMap.delete(deviceId);
      return newMap;
    });
    
    // Force tile remount to ensure clean UI
    refreshTile(deviceId);
  };

  // Session-only filtered students (no search filter) - used for stats
  const sessionFilteredStudents = students.filter((student) => {
    // Filter by active session (only show students in current session's group)
    if (activeSession && sessionStudentIds.length > 0) {
      if (!sessionStudentIds.includes(student.studentId)) return false;
    }
    
    // Filter by gradeLevel field ONLY for admins (teachers use session-based filtering)
    if (currentUser?.role === 'school_admin') {
      return normalizeGrade(student.gradeLevel) === normalizeGrade(selectedGrade);
    }
    
    // Teachers: no grade filtering (managed by session)
    return true;
  });

  // Full filtered students list (includes search filter) - used for display
  const filteredStudents = sessionFilteredStudents
    .filter((student) => {
      const matchesSearch =
        (student.studentName || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        student.studentId.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (student.classId ?? '').toLowerCase().includes(searchQuery.toLowerCase());

      // Filter by subgroup if one is selected
      const matchesSubgroup = !selectedSubgroupId || subgroupMembers.has(student.studentId);

      return matchesSearch && matchesSubgroup;
    })
    .sort((a, b) => {
      // Sort alphabetically by last name only
      const aLastName = getLastName(a.studentName);
      const bLastName = getLastName(b.studentName);

      return aLastName.localeCompare(bLastName);
    });

  // Count stats from session-filtered students (not search-filtered)
  // This ensures stats stay accurate while searching
  const statsStudents = sessionFilteredStudents;
  
  const onlineCount = statsStudents.filter((s) => s.status === 'online').length;
  const idleCount = statsStudents.filter((s) => s.status === 'idle').length;
  const offlineCount = statsStudents.filter((s) => s.status === 'offline').length;
  const offTaskCount = statsStudents.filter(isStudentOffTask).length;

  // Convert selected student IDs to all associated device IDs for remote control
  const getTargetDeviceIds = (): string[] | undefined => {
    if (selectedStudentIds.size === 0) return undefined; // All students
    
    const deviceIds: string[] = [];
    students.forEach(student => {
      if (selectedStudentIds.has(student.studentId)) {
        // Add all devices for this student
        student.devices.forEach(device => {
          if (device.deviceId) {
            deviceIds.push(device.deviceId);
          }
        });
        // Also add primary device if it exists and isn't in the devices array
        if (student.primaryDeviceId && !deviceIds.includes(student.primaryDeviceId)) {
          deviceIds.push(student.primaryDeviceId);
        }
      }
    });
    
    return deviceIds.length > 0 ? deviceIds : undefined;
  };

  // Get unique open tabs from selected students (or all if none selected)
  const relevantStudents = selectedStudentIds.size > 0 
    ? students.filter(s => selectedStudentIds.has(s.studentId))
    : students;
  
  // Use allOpenTabs if available, otherwise fall back to active tab (with deviceId tracking)
  const openTabs = relevantStudents
    .flatMap(s => {
      // Prefer allOpenTabs if available (shows ALL tabs from ALL devices)
      if (s.allOpenTabs && s.allOpenTabs.length > 0) {
        return s.allOpenTabs
          .filter((tab: any) => tab.url && !tab.url.startsWith('chrome://')) // Filter out privileged URLs
          .map((tab: any) => ({
            url: tab.url,
            title: tab.title || 'Untitled',
            studentName: s.studentName,
            studentId: s.studentId,
            deviceId: tab.deviceId, // Track which device has this tab
          }));
      } 
      // Fall back to active tab (backwards compatibility - only if primaryDeviceId exists)
      else if (s.activeTabUrl && s.activeTabUrl.trim() && !s.activeTabUrl.startsWith('chrome://') && s.primaryDeviceId) {
        return [{
          url: s.activeTabUrl,
          title: s.activeTabTitle || 'Untitled',
          studentName: s.studentName,
          studentId: s.studentId,
          deviceId: s.primaryDeviceId, // Use primary device for fallback
        }];
      } 
      // No tabs to show for this student
      else {
        return [];
      }
    })
    .sort((a, b) => a.title.localeCompare(b.title));

  // Check for blocked domain violations and show notifications
  useEffect(() => {
    if (!settings?.blockedDomains || settings.blockedDomains.length === 0) return;

    students.forEach((student) => {
      const deviceId = student.primaryDeviceId;
      
      if (!student.activeTabUrl) {
        // Clear all violations for this device if no URL
        const keysToDelete = Array.from(notifiedViolations.current).filter(key => key.startsWith(deviceId + '-'));
        keysToDelete.forEach(key => notifiedViolations.current.delete(key));
        return;
      }

      const violationKey = `${deviceId}-${student.activeTabUrl}`;
      
      // Check if student is on blocked domain
      const isBlocked = settings.blockedDomains!.some(blocked => {
        try {
          const hostname = new URL(student.activeTabUrl!).hostname.toLowerCase();
          const blockedLower = blocked.toLowerCase().trim();
          return hostname === blockedLower || hostname.endsWith('.' + blockedLower);
        } catch {
          return false;
        }
      });

      if (isBlocked) {
        // Only notify if this is a new violation (not previously notified)
        if (!notifiedViolations.current.has(violationKey)) {
          toast({
            variant: "destructive",
            title: "Blocked Domain Accessed",
            description: `${student.studentName} is accessing a blocked domain: ${student.activeTabUrl}`,
          });
          notifiedViolations.current.add(violationKey);
        }
      } else {
        // Student is not on blocked domain - clear all violations for this device
        const keysToDelete = Array.from(notifiedViolations.current).filter(key => key.startsWith(deviceId + '-'));
        keysToDelete.forEach(key => notifiedViolations.current.delete(key));
      }
    });
  }, [students, settings, toast]);

  const handleLogout = () => {
    // Clear auth and redirect to login
    setLocation("/");
  };

  const handleOpenExportDialog = () => {
    // Set default dates: last 7 days
    const end = new Date();
    const start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    
    setExportEndDate(end.toISOString().split('T')[0]);
    setExportStartDate(start.toISOString().split('T')[0]);
    setShowExportDialog(true);
  };

  const handleExportCSV = () => {
    if (!exportStartDate || !exportEndDate) {
      toast({
        variant: "destructive",
        title: "Invalid Dates",
        description: "Please select both start and end dates",
      });
      return;
    }

    const startDate = new Date(exportStartDate).toISOString();
    const endDate = new Date(exportEndDate + 'T23:59:59').toISOString();
    
    window.location.href = `/api/export/activity?startDate=${startDate}&endDate=${endDate}`;
    toast({
      title: "Exporting Data",
      description: `Downloading activity report from ${exportStartDate} to ${exportEndDate}...`,
    });
    setShowExportDialog(false);
  };

  const updateGradesMutation = useMutation({
    mutationFn: async (gradeLevels: string[]) => {
      if (!settings) throw new Error("Settings not loaded");
      
      const payload = {
        schoolId: settings.schoolId,
        schoolName: settings.schoolName,
        wsSharedKey: settings.wsSharedKey,
        retentionHours: settings.retentionHours,
        blockedDomains: settings.blockedDomains || [],
        allowedDomains: settings.allowedDomains || [],
        ipAllowlist: settings.ipAllowlist || [],
        gradeLevels,
      };
      
      const res = await apiRequest('POST', '/api/settings', payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/settings'] });
      toast({
        title: "Success",
        description: "Grade levels updated successfully",
      });
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    },
  });

  const handleAddGrade = () => {
    if (!newGrade.trim()) {
      toast({
        variant: "destructive",
        title: "Invalid Grade",
        description: "Please enter a grade level",
      });
      return;
    }

    const currentGrades = settings?.gradeLevels || [];
    if (currentGrades.includes(newGrade.trim())) {
      toast({
        variant: "destructive",
        title: "Duplicate Grade",
        description: "This grade level already exists",
      });
      return;
    }

    const newGrades = [...currentGrades, newGrade.trim()];
    updateGradesMutation.mutate(newGrades);
    setNewGrade("");
  };

  const handleDeleteGrade = (grade: string) => {
    const currentGrades = settings?.gradeLevels || [];
    if (currentGrades.length <= 1) {
      toast({
        variant: "destructive",
        title: "Cannot Delete",
        description: "You must have at least one grade level",
      });
      return;
    }

    const newGrades = currentGrades.filter(g => g !== grade);
    updateGradesMutation.mutate(newGrades);
  };

  // Session control mutations
  const startSessionMutation = useMutation({
    mutationFn: async (groupId: string) => {
      const res = await apiRequest('POST', '/api/sessions/start', { groupId });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/sessions/active'], exact: false });
      queryClient.invalidateQueries({ queryKey: ['/api/groups'], exact: false });
      queryClient.invalidateQueries({ queryKey: ['/api/teacher/groups'], exact: false });
      const group = groups.find(g => g.id === data.groupId);
      toast({
        title: "Class Started",
        description: `Now teaching: ${group?.name || 'Unknown Class'}`,
      });
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    },
  });

  const endSessionMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/sessions/end', {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/sessions/active'], exact: false });
      queryClient.invalidateQueries({ queryKey: ['/api/groups'], exact: false });
      queryClient.invalidateQueries({ queryKey: ['/api/teacher/groups'], exact: false });
      toast({
        title: "Class Ended",
        description: "Class session has been ended",
      });
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    },
  });

  // Stop impersonating (for super admins)
  const stopImpersonateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/super-admin/stop-impersonate', {});
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Stopped Impersonating",
        description: "Returned to your super admin account",
      });
      // Redirect to super admin schools page
      setTimeout(() => {
        window.location.href = "/super-admin/schools";
      }, 500);
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    },
  });

  // Helper to refresh screenshots for targeted devices after a delay
  // This gives the extension time to navigate and capture the new screen
  const refreshScreenshotsForDevices = (targetDeviceIds?: string[]) => {
    const deviceIds = targetDeviceIds || students.filter(s => s.status === 'online' || s.status === 'idle').map(s => s.primaryDeviceId).filter((id): id is string => !!id);

    // Refresh after 2 seconds (give extension time to navigate and capture)
    setTimeout(() => {
      deviceIds.forEach(deviceId => {
        queryClient.invalidateQueries({ queryKey: ['/api/device/screenshot', deviceId] });
      });
    }, 2000);

    // Refresh again after 5 seconds for good measure
    setTimeout(() => {
      deviceIds.forEach(deviceId => {
        queryClient.invalidateQueries({ queryKey: ['/api/device/screenshot', deviceId] });
      });
    }, 5000);
  };

  // Remote control mutations
  const openTabMutation = useMutation({
    mutationFn: async ({ url, targetDeviceIds }: { url: string; targetDeviceIds?: string[] }) => {
      const res = await apiRequest('POST', '/api/remote/open-tab', { url, targetDeviceIds });
      const data = await res.json();
      return { ...data, targetDeviceIds };
    },
    onSuccess: (data) => {
      toast({
        title: "Success",
        description: data.message,
      });
      setShowOpenTabDialog(false);
      setOpenTabUrl("");
      // Refresh screenshots after opening tab so thumbnail updates
      refreshScreenshotsForDevices(data.targetDeviceIds);
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    },
  });

  const closeTabsMutation = useMutation({
    mutationFn: async ({ closeAll, pattern, specificUrls, targetDeviceIds, tabsToClose }: { closeAll?: boolean; pattern?: string; specificUrls?: string[]; targetDeviceIds?: string[]; tabsToClose?: Array<{ deviceId: string; url: string }> }) => {
      const res = await apiRequest('POST', '/api/remote/close-tabs', { closeAll, pattern, specificUrls, targetDeviceIds, tabsToClose });
      const data = await res.json();
      // Collect device IDs from tabsToClose or targetDeviceIds for screenshot refresh
      const affectedDeviceIds = tabsToClose?.map(t => t.deviceId) || targetDeviceIds;
      return { ...data, affectedDeviceIds };
    },
    onSuccess: (data) => {
      toast({
        title: "Success",
        description: data.message,
      });
      setShowCloseTabsDialog(false);
      setSelectedTabsToClose(new Set());
      // Refresh screenshots after closing tabs so thumbnail updates
      if (data.affectedDeviceIds) {
        refreshScreenshotsForDevices(data.affectedDeviceIds);
      }
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    },
  });

  const lockScreenMutation = useMutation({
    mutationFn: async ({ url, targetDeviceIds, devicesToLock }: { url: string; targetDeviceIds?: string[]; devicesToLock: string[] }) => {
      const res = await apiRequest('POST', '/api/remote/lock-screen', { url, targetDeviceIds });
      const data = await res.json();
      return { ...data, deviceCount: devicesToLock.length };
    },
    onMutate: async ({ targetDeviceIds }) => {
      // Block refetches for 15 seconds to preserve optimistic state
      optimisticUpdateUntilRef.current = Date.now() + 15000;

      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['/api/students-aggregated'] });

      // Snapshot the previous value
      const previousStudents = queryClient.getQueryData(['/api/students-aggregated']);

      // Calculate devices to lock
      const devicesToLock = targetDeviceIds || students.filter(s => s.status === 'online' || s.status === 'idle').map(s => s.primaryDeviceId).filter((id): id is string => !!id);

      // Optimistically update to locked state
      queryClient.setQueryData<AggregatedStudentStatus[]>(['/api/students-aggregated'], (old) =>
        old?.map(s => devicesToLock.includes(s.primaryDeviceId ?? '') ? { ...s, screenLocked: true } : s)
      );

      return { previousStudents, devicesToLock };
    },
    onSuccess: (data) => {
      toast({
        title: "Success",
        description: `Locked screen for ${data.deviceCount} student(s)`,
      });
    },
    onError: (error: Error, _, context) => {
      // Revert optimistic update on error
      optimisticUpdateUntilRef.current = 0; // Allow refetches again
      if (context?.previousStudents) {
        queryClient.setQueryData(['/api/students-aggregated'], context.previousStudents);
      }
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    },
  });

  const unlockScreenMutation = useMutation({
    mutationFn: async ({ targetDeviceIds, devicesToUnlock }: { targetDeviceIds?: string[]; devicesToUnlock: string[] }) => {
      const res = await apiRequest('POST', '/api/remote/unlock-screen', { targetDeviceIds });
      const data = await res.json();
      return { ...data, deviceCount: devicesToUnlock.length };
    },
    onMutate: async ({ targetDeviceIds }) => {
      // Block refetches for 15 seconds to preserve optimistic state
      optimisticUpdateUntilRef.current = Date.now() + 15000;

      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['/api/students-aggregated'] });

      // Snapshot the previous value
      const previousStudents = queryClient.getQueryData(['/api/students-aggregated']);

      // Calculate devices to unlock
      const devicesToUnlock = targetDeviceIds || students.filter(s => s.status === 'online' || s.status === 'idle').map(s => s.primaryDeviceId).filter((id): id is string => !!id);

      // Optimistically update to unlocked state
      queryClient.setQueryData<AggregatedStudentStatus[]>(['/api/students-aggregated'], (old) =>
        old?.map(s => devicesToUnlock.includes(s.primaryDeviceId ?? '') ? { ...s, screenLocked: false } : s)
      );

      return { previousStudents, devicesToUnlock };
    },
    onSuccess: (data) => {
      toast({
        title: "Success",
        description: `Unlocked screen for ${data.deviceCount} student(s)`,
      });
    },
    onError: (error: Error, _, context) => {
      // Revert optimistic update on error
      optimisticUpdateUntilRef.current = 0; // Allow refetches again
      if (context?.previousStudents) {
        queryClient.setQueryData(['/api/students-aggregated'], context.previousStudents);
      }
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    },
  });

  // Remote control handlers
  const handleOpenTab = () => {
    if (!openTabUrl.trim()) {
      toast({
        variant: "destructive",
        title: "Invalid URL",
        description: "Please enter a valid URL",
      });
      return;
    }
    
    // Normalize URL - add https:// if no protocol specified
    let normalizedUrl = openTabUrl.trim();
    if (!normalizedUrl.match(/^https?:\/\//i)) {
      normalizedUrl = 'https://' + normalizedUrl;
    }
    
    const targetDeviceIds = getTargetDeviceIds();
    openTabMutation.mutate({ url: normalizedUrl, targetDeviceIds });
  };

  // Close selected tabs (from checkboxes in the Tabs dialog)
  const handleCloseTabs = () => {
    if (selectedTabsToClose.size === 0) {
      toast({
        variant: "destructive",
        title: "No Tabs Selected",
        description: "Please select at least one tab to close",
      });
      return;
    }

    // Parse composite keys "studentId|deviceId|url" into structured data
    const tabsToClose: Array<{ deviceId: string; url: string }> = [];
    selectedTabsToClose.forEach(compositeKey => {
      const parts = compositeKey.split('|');
      if (parts.length === 3) {
        const [, deviceId, url] = parts; // studentId not needed
        tabsToClose.push({ deviceId, url });
      }
    });

    closeTabsMutation.mutate({ tabsToClose });
    // Clear selection after closing
    setSelectedTabsToClose(new Set());
  };

  // Close a single tab on a specific device
  const handleCloseSingleTab = (deviceId: string, url: string) => {
    closeTabsMutation.mutate({ tabsToClose: [{ deviceId, url }] });
  };

  const handleLockScreen = () => {
    const targetDeviceIds = getTargetDeviceIds();
    const devicesToLock = targetDeviceIds || students.filter(s => s.status === 'online' || s.status === 'idle').map(s => s.primaryDeviceId).filter((id): id is string => !!id);
    // Send "CURRENT_URL" to lock students to their current page
    lockScreenMutation.mutate({ url: "CURRENT_URL", targetDeviceIds, devicesToLock });
  };

  const handleUnlockScreen = () => {
    const targetDeviceIds = getTargetDeviceIds();
    const devicesToUnlock = targetDeviceIds || students.filter(s => s.status === 'online' || s.status === 'idle').map(s => s.primaryDeviceId).filter((id): id is string => !!id);
    unlockScreenMutation.mutate({ targetDeviceIds, devicesToUnlock });
  };

  // Apply Flight Path mutation
  const applyFlightPathMutation = useMutation({
    mutationFn: async ({ flightPathId, allowedDomains, targetDeviceIds, flightPathName, devicesToApply }: { flightPathId: string; allowedDomains: string[]; targetDeviceIds?: string[]; flightPathName?: string; devicesToApply: string[] }) => {
      const res = await apiRequest('POST', '/api/remote/apply-flight-path', { flightPathId, allowedDomains, targetDeviceIds });
      const data = await res.json();
      return { ...data, deviceCount: devicesToApply.length, flightPathName, devicesToApply };
    },
    onMutate: async ({ targetDeviceIds, flightPathName }) => {
      // Block refetches for 15 seconds to preserve optimistic state
      optimisticUpdateUntilRef.current = Date.now() + 15000;

      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['/api/students-aggregated'] });

      // Snapshot the previous value
      const previousStudents = queryClient.getQueryData(['/api/students-aggregated']);

      // Calculate devices to apply
      const devicesToApply = targetDeviceIds || students.filter(s => s.status === 'online' || s.status === 'idle').map(s => s.primaryDeviceId).filter((id): id is string => !!id);

      // Optimistically update to show flight path active
      queryClient.setQueryData<AggregatedStudentStatus[]>(['/api/students-aggregated'], (old) =>
        old?.map(s => devicesToApply.includes(s.primaryDeviceId ?? '') ? { ...s, flightPathActive: true, activeFlightPathName: flightPathName } : s)
      );

      return { previousStudents, devicesToApply };
    },
    onSuccess: (data) => {
      toast({
        title: "Success",
        description: `Applied "${data.flightPathName}" to ${data.deviceCount} student(s)`,
      });
      setShowApplyFlightPathDialog(false);
      setSelectedFlightPathId("");
      // Refresh screenshots after applying flight path so thumbnail updates
      refreshScreenshotsForDevices(data.devicesToApply);
    },
    onError: (error: Error, _, context) => {
      // Revert optimistic update on error
      optimisticUpdateUntilRef.current = 0; // Allow refetches again
      if (context?.previousStudents) {
        queryClient.setQueryData(['/api/students-aggregated'], context.previousStudents);
      }
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    },
  });

  // Remove Flight Path mutation
  const removeFlightPathMutation = useMutation({
    mutationFn: async ({ targetDeviceIds }: { targetDeviceIds: string[] }) => {
      const res = await apiRequest('POST', '/api/remote/remove-flight-path', { targetDeviceIds });
      const data = await res.json();
      return { ...data, deviceCount: targetDeviceIds.length };
    },
    onMutate: async ({ targetDeviceIds }) => {
      // Block refetches for 15 seconds to preserve optimistic state
      optimisticUpdateUntilRef.current = Date.now() + 15000;

      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['/api/students-aggregated'] });

      // Snapshot the previous value
      const previousStudents = queryClient.getQueryData(['/api/students-aggregated']);

      // Optimistically update to show flight path removed
      queryClient.setQueryData<AggregatedStudentStatus[]>(['/api/students-aggregated'], (old) =>
        old?.map(s => targetDeviceIds.includes(s.primaryDeviceId ?? '') ? { ...s, flightPathActive: false, activeFlightPathName: undefined } : s)
      );

      return { previousStudents };
    },
    onSuccess: (data) => {
      toast({
        title: "Success",
        description: `Removed flight path from ${data.deviceCount} student(s)`,
      });
    },
    onError: (error: Error, _, context) => {
      // Revert optimistic update on error
      optimisticUpdateUntilRef.current = 0; // Allow refetches again
      if (context?.previousStudents) {
        queryClient.setQueryData(['/api/students-aggregated'], context.previousStudents);
      }
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    },
  });

  // Flight Path handlers
  const handleApplyFlightPath = () => {
    if (!selectedFlightPathId) {
      toast({
        variant: "destructive",
        title: "No Flight Path Selected",
        description: "Please select a flight path to apply",
      });
      return;
    }

    const flightPath = flightPaths.find(fp => fp.id === selectedFlightPathId);
    if (!flightPath) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Selected flight path not found",
      });
      return;
    }

    const targetDeviceIds = getTargetDeviceIds();
    const devicesToApply = targetDeviceIds || students.filter(s => s.status === 'online' || s.status === 'idle').map(s => s.primaryDeviceId).filter((id): id is string => !!id);
    applyFlightPathMutation.mutate({
      flightPathId: flightPath.id,
      allowedDomains: flightPath.allowedDomains || [],
      targetDeviceIds,
      flightPathName: flightPath.flightPathName,
      devicesToApply,
    });
  };

  const handleRemoveFlightPath = (deviceId: string) => {
    removeFlightPathMutation.mutate({ targetDeviceIds: [deviceId] });
  };

  // Apply Block List mutation
  const applyBlockListMutation = useMutation({
    mutationFn: async ({ blockListId, targetDeviceIds }: { blockListId: string; targetDeviceIds?: string[] }) => {
      const res = await apiRequest('POST', `/api/block-lists/${blockListId}/apply`, { targetDeviceIds });
      const data = await res.json();
      return data;
    },
    onSuccess: (data) => {
      const blockList = blockLists.find(bl => bl.id === selectedBlockListId);
      toast({
        title: "Success",
        description: `Applied "${blockList?.name || 'Block List'}" to ${data.sentTo || 0} student(s)`,
      });
      setShowApplyBlockListDialog(false);
      setSelectedBlockListId("");
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    },
  });

  // Remove Block List mutation
  const removeBlockListMutation = useMutation({
    mutationFn: async ({ targetDeviceIds }: { targetDeviceIds?: string[] }) => {
      const res = await apiRequest('POST', '/api/block-lists/remove', { targetDeviceIds });
      const data = await res.json();
      return data;
    },
    onSuccess: (data) => {
      toast({
        title: "Success",
        description: `Removed block list from ${data.sentTo || 0} student(s)`,
      });
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    },
  });

  // Block List handlers
  const handleApplyBlockList = () => {
    if (!selectedBlockListId) {
      toast({
        variant: "destructive",
        title: "No Block List Selected",
        description: "Please select a block list to apply",
      });
      return;
    }

    const targetDeviceIds = getTargetDeviceIds();
    applyBlockListMutation.mutate({
      blockListId: selectedBlockListId,
      targetDeviceIds,
    });
  };

  const handleRemoveBlockList = () => {
    const targetDeviceIds = getTargetDeviceIds();
    removeBlockListMutation.mutate({ targetDeviceIds });
  };

  // Attention Mode mutation
  const attentionModeMutation = useMutation({
    mutationFn: async ({ active, message, targetDeviceIds }: { active: boolean; message: string; targetDeviceIds?: string[] }) => {
      const res = await apiRequest('POST', '/api/remote/attention-mode', { active, message, targetDeviceIds });
      const data = await res.json();
      return data;
    },
    onSuccess: (data, variables) => {
      setAttentionActive(variables.active);
      toast({
        title: variables.active ? "Attention Mode Enabled" : "Attention Mode Disabled",
        description: variables.active
          ? `Showing "${variables.message}" to ${data.sentTo || 0} student(s)`
          : `Released ${data.sentTo || 0} student(s)`,
      });
      if (!variables.active) {
        setShowAttentionDialog(false);
      }
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    },
  });

  // Timer mutation
  const timerMutation = useMutation({
    mutationFn: async ({ action, seconds, message, targetDeviceIds }: { action: 'start' | 'stop'; seconds?: number; message?: string; targetDeviceIds?: string[] }) => {
      const res = await apiRequest('POST', '/api/remote/timer', { action, seconds, message, targetDeviceIds });
      const data = await res.json();
      return data;
    },
    onSuccess: (data, variables) => {
      setTimerActive(variables.action === 'start');
      toast({
        title: variables.action === 'start' ? "Timer Started" : "Timer Stopped",
        description: variables.action === 'start'
          ? `${Math.floor((variables.seconds || 0) / 60)}:${String((variables.seconds || 0) % 60).padStart(2, '0')} timer sent to ${data.sentTo || 0} student(s)`
          : `Stopped timer for ${data.sentTo || 0} student(s)`,
      });
      if (variables.action === 'start') {
        setShowTimerDialog(false);
      }
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    },
  });

  // Attention Mode handlers
  const handleAttentionMode = (active: boolean) => {
    const targetDeviceIds = getTargetDeviceIds();
    attentionModeMutation.mutate({
      active,
      message: attentionMessage,
      targetDeviceIds,
    });
  };

  // Timer handlers
  const handleStartTimer = () => {
    const totalSeconds = (timerMinutes * 60) + timerSeconds;
    if (totalSeconds <= 0) {
      toast({
        variant: "destructive",
        title: "Invalid Timer",
        description: "Please set a time greater than 0",
      });
      return;
    }
    const targetDeviceIds = getTargetDeviceIds();
    timerMutation.mutate({
      action: 'start',
      seconds: totalSeconds,
      message: timerMessage,
      targetDeviceIds,
    });
  };

  const handleStopTimer = () => {
    const targetDeviceIds = getTargetDeviceIds();
    timerMutation.mutate({
      action: 'stop',
      targetDeviceIds,
    });
  };

  // Poll mutation
  const pollMutation = useMutation({
    mutationFn: async ({ question, options, targetDeviceIds }: { question: string; options: string[]; targetDeviceIds?: string[] }) => {
      const res = await apiRequest('POST', '/api/polls/create', { question, options, targetDeviceIds });
      const data = await res.json();
      return data;
    },
    onSuccess: (data) => {
      setActivePoll({ id: data.poll.id, question: data.poll.question, options: data.poll.options });
      setPollResults([]);
      setPollTotalResponses(0);
      toast({
        title: "Poll Created",
        description: `Poll sent to ${data.sentTo || 0} student(s)`,
      });
      setShowPollDialog(false);
      setPollQuestion("");
      setPollOptions(["", ""]);
      // Start polling for results
      startPollResultsPolling(data.poll.id);
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    },
  });

  // Close poll mutation
  const closePollMutation = useMutation({
    mutationFn: async ({ pollId, targetDeviceIds }: { pollId: string; targetDeviceIds?: string[] }) => {
      const res = await apiRequest('POST', `/api/polls/${pollId}/close`, { targetDeviceIds });
      const data = await res.json();
      return data;
    },
    onSuccess: () => {
      setActivePoll(null);
      setShowPollResultsDialog(false);
      toast({
        title: "Poll Closed",
        description: "Poll has been closed",
      });
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    },
  });

  // Dismiss hand mutation
  const dismissHandMutation = useMutation({
    mutationFn: async (studentId: string) => {
      const res = await apiRequest('POST', `/api/teacher/dismiss-hand/${studentId}`);
      const data = await res.json();
      return data;
    },
    onSuccess: (_, studentId) => {
      setRaisedHands(prev => {
        const newMap = new Map(prev);
        newMap.delete(studentId);
        return newMap;
      });
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    },
  });

  // Reply to student message mutation
  const replyToMessageMutation = useMutation({
    mutationFn: async ({ studentId, message }: { studentId: string; message: string }) => {
      const res = await apiRequest('POST', '/api/teacher/reply', { studentId, message });
      const data = await res.json();
      return data;
    },
    onSuccess: () => {
      setReplyingToMessage(null);
      setReplyText("");
      toast({
        title: "Reply Sent",
        description: "Your reply has been sent to the student",
      });
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    },
  });

  // Mark student message as read
  const markMessageRead = (messageId: string) => {
    setStudentMessages(prev => prev.map(msg =>
      msg.id === messageId ? { ...msg, read: true } : msg
    ));
  };

  // Dismiss/remove student message
  const dismissMessage = (messageId: string) => {
    setStudentMessages(prev => prev.filter(msg => msg.id !== messageId));
  };

  // Toggle hand raising mutation
  const toggleHandRaisingMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await apiRequest('POST', '/api/settings/hand-raising', { enabled });
      const data = await res.json();
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/settings'] });
      toast({
        title: data.enabled ? "Hand Raising Enabled" : "Hand Raising Disabled",
        description: data.enabled
          ? "Students can now raise their hands"
          : "Students cannot raise their hands",
      });
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    },
  });

  // Poll results polling
  const pollResultsIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const startPollResultsPolling = (pollId: string) => {
    // Clear any existing interval
    if (pollResultsIntervalRef.current) {
      clearInterval(pollResultsIntervalRef.current);
    }

    // Fetch immediately
    fetchPollResults(pollId);

    // Poll every 2 seconds
    pollResultsIntervalRef.current = setInterval(() => {
      fetchPollResults(pollId);
    }, 2000);
  };

  const fetchPollResults = async (pollId: string) => {
    try {
      const res = await apiRequest('GET', `/api/polls/${pollId}/results`);
      const data = await res.json();
      setPollResults(data.results || []);
      setPollTotalResponses(data.totalResponses || 0);

      // If poll is closed, stop polling
      if (!data.poll.isActive) {
        if (pollResultsIntervalRef.current) {
          clearInterval(pollResultsIntervalRef.current);
          pollResultsIntervalRef.current = null;
        }
      }
    } catch (err) {
      console.error('Error fetching poll results:', err);
    }
  };

  // Cleanup poll interval on unmount
  useEffect(() => {
    return () => {
      if (pollResultsIntervalRef.current) {
        clearInterval(pollResultsIntervalRef.current);
      }
    };
  }, []);

  // Fetch subgroup members when subgroup is selected
  useEffect(() => {
    if (selectedSubgroupId) {
      apiRequest('GET', `/api/subgroups/${selectedSubgroupId}/members`)
        .then(res => res.json())
        .then(data => {
          setSubgroupMembers(new Set(data.members || []));
        })
        .catch(err => {
          console.error('Error fetching subgroup members:', err);
          setSubgroupMembers(new Set());
        });
    } else {
      setSubgroupMembers(new Set());
    }
  }, [selectedSubgroupId]);

  // Poll handlers
  const handleCreatePoll = () => {
    const validOptions = pollOptions.filter(opt => opt.trim() !== '');
    if (!pollQuestion.trim()) {
      toast({
        variant: "destructive",
        title: "Invalid Poll",
        description: "Please enter a question",
      });
      return;
    }
    if (validOptions.length < 2) {
      toast({
        variant: "destructive",
        title: "Invalid Poll",
        description: "Please enter at least 2 options",
      });
      return;
    }
    const targetDeviceIds = getTargetDeviceIds();
    pollMutation.mutate({
      question: pollQuestion.trim(),
      options: validOptions,
      targetDeviceIds,
    });
  };

  const handleClosePoll = () => {
    if (!activePoll) return;
    const targetDeviceIds = getTargetDeviceIds();
    closePollMutation.mutate({
      pollId: activePoll.id,
      targetDeviceIds,
    });
  };

  const addPollOption = () => {
    if (pollOptions.length < 5) {
      setPollOptions([...pollOptions, ""]);
    }
  };

  const removePollOption = (index: number) => {
    if (pollOptions.length > 2) {
      setPollOptions(pollOptions.filter((_, i) => i !== index));
    }
  };

  const updatePollOption = (index: number, value: string) => {
    const newOptions = [...pollOptions];
    newOptions[index] = value;
    setPollOptions(newOptions);
  };

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="sticky top-0 z-40 glass-panel border-b border-white/20">
        <div className="max-w-screen-2xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-lg">
                <Monitor className="h-7 w-7 text-primary-foreground" />
              </div>
              <div>
                <h1 className="text-2xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">ClassPilot</h1>
                <p className="text-xs text-muted-foreground font-medium">
                  {currentUser?.role === 'school_admin' ? 'Admin Dashboard' : 'Teacher Dashboard'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant={wsConnected ? "default" : "secondary"}
                className="text-xs"
                data-testid="badge-connection-status"
              >
                <div className={`h-2 w-2 rounded-full mr-1.5 ${wsConnected ? 'bg-status-online animate-pulse' : 'bg-status-offline'}`} />
                {wsConnected ? 'Connected' : 'Disconnected'}
              </Badge>
              {settings?.enableTrackingHours && (
                <Badge
                  variant={isWithinTrackingHours(
                    settings.enableTrackingHours,
                    settings.trackingStartTime,
                    settings.trackingEndTime,
                    settings.schoolTimezone,
                    settings.trackingDays
                  ) ? "default" : "secondary"}
                  className="text-xs"
                  data-testid="badge-tracking-status"
                >
                  <div className={`h-2 w-2 rounded-full mr-1.5 ${isWithinTrackingHours(
                    settings.enableTrackingHours,
                    settings.trackingStartTime,
                    settings.trackingEndTime,
                    settings.schoolTimezone,
                    settings.trackingDays
                  ) ? 'bg-status-online animate-pulse' : 'bg-amber-500'}`} />
                  {isWithinTrackingHours(
                    settings.enableTrackingHours,
                    settings.trackingStartTime,
                    settings.trackingEndTime,
                    settings.schoolTimezone,
                    settings.trackingDays
                  ) ? 'Tracking Active' : 'Tracking Paused'}
                </Badge>
              )}
              {currentUser?.role === 'teacher' && (
                <>
                  {activeSession ? (
                    <>
                      <Badge variant="default" className="text-xs" data-testid="badge-active-session">
                        <div className="h-2 w-2 rounded-full mr-1.5 bg-green-500 animate-pulse" />
                        {groups.find(g => g.id === activeSession.groupId)?.name || 'Active Class'}
                      </Badge>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => endSessionMutation.mutate()}
                        disabled={endSessionMutation.isPending}
                        data-testid="button-end-session"
                      >
                        <X className="h-4 w-4 mr-2" />
                        End Class
                      </Button>
                    </>
                  ) : (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="default"
                          size="sm"
                          disabled={groups.length === 0}
                          data-testid="button-start-session"
                        >
                          <Plus className="h-4 w-4 mr-2" />
                          Start Class
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-56">
                        <DropdownMenuLabel>Select Class</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {groups.length === 0 ? (
                          <div className="px-2 py-6 text-center text-sm text-muted-foreground">
                            No classes configured
                          </div>
                        ) : (
                          groups.map((group) => (
                            <DropdownMenuCheckboxItem
                              key={group.id}
                              onSelect={() => startSessionMutation.mutate(group.id)}
                              data-testid={`menu-item-start-${group.id}`}
                            >
                              <div className="flex flex-col">
                                <span className="font-medium">{group.name}</span>
                                {group.description && (
                                  <span className="text-xs text-muted-foreground">{group.description}</span>
                                )}
                              </div>
                            </DropdownMenuCheckboxItem>
                          ))
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </>
              )}
              {currentUser?.impersonating && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => stopImpersonateMutation.mutate()}
                  disabled={stopImpersonateMutation.isPending}
                  data-testid="button-stop-impersonating"
                >
                  <UserCog className="h-4 w-4 mr-2" />
                  Stop Impersonating
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleOpenExportDialog}
                data-testid="button-export-excel"
              >
                <Download className="h-4 w-4 mr-2" />
                Export CSV
              </Button>
              {currentUser?.role === 'school_admin' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowGradeDialog(true)}
                  data-testid="button-manage-grades"
                >
                  <GraduationCap className="h-4 w-4 mr-2" />
                  Manage Grades
                </Button>
              )}
              {currentUser?.role === 'teacher' && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setLocation("/my-settings")}
                  data-testid="button-my-settings"
                  title="My Settings"
                >
                  <User className="h-5 w-5" />
                </Button>
              )}
              {currentUser?.role === 'school_admin' && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setLocation("/admin")}
                    data-testid="button-admin"
                  >
                    <Shield className="h-5 w-5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setLocation("/settings")}
                    data-testid="button-settings"
                  >
                    <SettingsIcon className="h-5 w-5" />
                  </Button>
                </>
              )}
              <ThemeToggle />
              <Button
                variant="ghost"
                size="icon"
                onClick={handleLogout}
                data-testid="button-logout"
              >
                <LogOut className="h-5 w-5" />
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-screen-2xl mx-auto px-6 py-8">
        {/* Remote Control Toolbar - only show if admin OR teacher with active session */}
        {(currentUser?.role === 'school_admin' || (currentUser?.role === 'teacher' && activeSession)) && (
          <RemoteControlToolbar 
            selectedStudentIds={selectedStudentIds}
            students={filteredStudents}
            onToggleStudent={toggleStudentSelection}
            onClearSelection={clearSelection}
            selectedGrade={selectedGrade}
            onGradeChange={setSelectedGrade}
            userRole={currentUser?.role}
          />
        )}
        
        {/* Stats Cards - only show if admin OR teacher with active session */}
        {(currentUser?.role === 'school_admin' || (currentUser?.role === 'teacher' && activeSession)) && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <div className="p-5 rounded-xl bg-gradient-to-br from-green-50 to-emerald-50 dark:from-green-950/30 dark:to-emerald-950/30 border border-green-200 dark:border-green-800/50 shadow-lg hover-elevate transition-all duration-300">
            <div className="flex items-center gap-4">
              <div className="h-14 w-14 rounded-xl bg-green-500 flex items-center justify-center shadow-md">
                <Users className="h-7 w-7 text-white" />
              </div>
              <div>
                <p className="text-3xl font-bold text-green-700 dark:text-green-400" data-testid="text-online-count">{onlineCount}</p>
                <p className="text-sm text-green-600 dark:text-green-500 font-medium">Online Now</p>
              </div>
            </div>
          </div>
          <div className="p-5 rounded-xl bg-gradient-to-br from-amber-50 to-yellow-50 dark:from-amber-950/30 dark:to-yellow-950/30 border border-amber-200 dark:border-amber-800/50 shadow-lg hover-elevate transition-all duration-300">
            <div className="flex items-center gap-4">
              <div className="h-14 w-14 rounded-xl bg-amber-500 flex items-center justify-center shadow-md">
                <Activity className="h-7 w-7 text-white" />
              </div>
              <div>
                <p className="text-3xl font-bold text-amber-700 dark:text-amber-400" data-testid="text-idle-count">{idleCount}</p>
                <p className="text-sm text-amber-600 dark:text-amber-500 font-medium">Idle</p>
              </div>
            </div>
          </div>
          <div className="p-5 rounded-xl bg-gradient-to-br from-gray-50 to-slate-50 dark:from-gray-950/30 dark:to-slate-950/30 border border-gray-200 dark:border-gray-800/50 shadow-lg hover-elevate transition-all duration-300">
            <div className="flex items-center gap-4">
              <div className="h-14 w-14 rounded-xl bg-gray-500 flex items-center justify-center shadow-md">
                <WifiOff className="h-7 w-7 text-white" />
              </div>
              <div>
                <p className="text-3xl font-bold text-gray-700 dark:text-gray-400" data-testid="text-offline-count">{offlineCount}</p>
                <p className="text-sm text-gray-600 dark:text-gray-500 font-medium">Offline</p>
              </div>
            </div>
          </div>
          <div className="p-5 rounded-xl bg-gradient-to-br from-red-50 to-rose-50 dark:from-red-950/30 dark:to-rose-950/30 border border-red-200 dark:border-red-800/50 shadow-lg hover-elevate transition-all duration-300">
            <div className="flex items-center gap-4">
              <div className="h-14 w-14 rounded-xl bg-red-500 flex items-center justify-center shadow-md">
                <AlertTriangle className="h-7 w-7 text-white" />
              </div>
              <div>
                <p className="text-3xl font-bold text-red-700 dark:text-red-400" data-testid="text-offtask-count">{offTaskCount}</p>
                <p className="text-sm text-red-600 dark:text-red-500 font-medium">Off-Task Alert</p>
              </div>
            </div>
          </div>
          </div>
        )}

        {/* Search Bar + Selection Controls - only show if admin OR teacher with active session */}
        {(currentUser?.role === 'school_admin' || (currentUser?.role === 'teacher' && activeSession)) && (
          <div className="flex items-center justify-between gap-4 flex-wrap mb-8">
          <Input
            placeholder="Search student"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            data-testid="input-search-students"
            className="max-w-md h-12 text-base shadow-sm"
          />
          
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-sm px-3 py-1" data-testid="badge-selection-count">
              Target: {selectedStudentIds.size > 0 ? `${selectedStudentIds.size} selected` : "All students"}
            </Badge>
            
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="button-select-students"
                >
                  <Users className="h-4 w-4 mr-1" />
                  Select
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64 max-h-96 overflow-y-auto">
                <DropdownMenuLabel>Select Students</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {filteredStudents.length === 0 ? (
                  <div className="px-2 py-6 text-center text-sm text-muted-foreground">
                    No students available
                  </div>
                ) : (
                  filteredStudents
                    .slice()
                    .sort((a, b) => (a.studentName || '').localeCompare(b.studentName || ''))
                    .map((student) => (
                      <DropdownMenuCheckboxItem
                        key={student.studentId}
                        checked={selectedStudentIds.has(student.studentId)}
                        onCheckedChange={() => toggleStudentSelection(student.studentId)}
                        onSelect={(e) => e.preventDefault()}
                        data-testid={`dropdown-item-student-${student.studentId}`}
                      >
                        {student.studentName || 'Unnamed Student'}
                      </DropdownMenuCheckboxItem>
                    ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              size="sm"
              variant="ghost"
              onClick={clearSelection}
              disabled={selectedStudentIds.size === 0}
              data-testid="button-clear-selection"
            >
              <XSquare className="h-4 w-4 mr-1" />
              Clear Selection
            </Button>
          </div>
          </div>
        )}

        {/* Control Buttons - only show if admin OR teacher with active session */}
        {(currentUser?.role === 'school_admin' || (currentUser?.role === 'teacher' && activeSession)) && (
          <div className="flex items-center gap-2 flex-wrap mb-8">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowOpenTabDialog(true)}
            data-testid="button-open-tab"
            className="text-blue-600 dark:text-blue-400"
          >
            <MonitorPlay className="h-4 w-4 mr-2" />
            Open Tab
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowCloseTabsDialog(true)}
            data-testid="button-tabs"
            className="text-blue-600 dark:text-blue-400"
          >
            <List className="h-4 w-4 mr-2" />
            Tabs
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={handleLockScreen}
            disabled={lockScreenMutation.isPending}
            data-testid="button-lock-screen"
            className="text-amber-600 dark:text-amber-400"
          >
            <Lock className="h-4 w-4 mr-2" />
            Lock Screen
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={handleUnlockScreen}
            disabled={unlockScreenMutation.isPending}
            data-testid="button-unlock-screen"
            className="text-amber-600 dark:text-amber-400"
          >
            <Unlock className="h-4 w-4 mr-2" />
            Unlock Screen
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowApplyFlightPathDialog(true)}
            data-testid="button-apply-flight-path"
            className="text-purple-600 dark:text-purple-400"
          >
            <Layers className="h-4 w-4 mr-2" />
            Apply Flight Path
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowFlightPathViewerDialog(true)}
            data-testid="button-flight-path"
            className="text-purple-600 dark:text-purple-400"
          >
            <Route className="h-4 w-4 mr-2" />
            Flight Path
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowApplyBlockListDialog(true)}
            data-testid="button-apply-block-list"
            className="text-red-600 dark:text-red-400"
          >
            <ShieldBan className="h-4 w-4 mr-2" />
            Apply Block List
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowBlockListViewerDialog(true)}
            data-testid="button-block-list"
            className="text-red-600 dark:text-red-400"
          >
            <Shield className="h-4 w-4 mr-2" />
            Block List
          </Button>

          <Button
            size="sm"
            variant={attentionActive ? "default" : "outline"}
            onClick={() => attentionActive ? handleAttentionMode(false) : setShowAttentionDialog(true)}
            disabled={attentionModeMutation.isPending}
            data-testid="button-attention"
            className={attentionActive ? "bg-indigo-600 hover:bg-indigo-700 text-white" : "text-indigo-600 dark:text-indigo-400"}
          >
            {attentionActive ? <EyeOff className="h-4 w-4 mr-2" /> : <Eye className="h-4 w-4 mr-2" />}
            {attentionActive ? "Release" : "Attention"}
          </Button>

          <Button
            size="sm"
            variant={timerActive ? "default" : "outline"}
            onClick={() => timerActive ? handleStopTimer() : setShowTimerDialog(true)}
            disabled={timerMutation.isPending}
            data-testid="button-timer"
            className={timerActive ? "bg-teal-600 hover:bg-teal-700 text-white" : "text-teal-600 dark:text-teal-400"}
          >
            {timerActive ? <Clock className="h-4 w-4 mr-2" /> : <Timer className="h-4 w-4 mr-2" />}
            {timerActive ? "Stop Timer" : "Timer"}
          </Button>

          <Button
            size="sm"
            variant={activePoll ? "default" : "outline"}
            onClick={() => activePoll ? setShowPollResultsDialog(true) : setShowPollDialog(true)}
            disabled={pollMutation.isPending}
            data-testid="button-poll"
            className={activePoll ? "bg-violet-600 hover:bg-violet-700 text-white" : "text-violet-600 dark:text-violet-400"}
          >
            <BarChart3 className="h-4 w-4 mr-2" />
            {activePoll ? `Poll (${pollTotalResponses})` : "Poll"}
          </Button>

          {/* Raised Hands */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant={raisedHands.size > 0 ? "default" : "outline"}
                data-testid="button-raised-hands"
                className={raisedHands.size > 0 ? "bg-amber-500 hover:bg-amber-600 text-white animate-pulse" : "text-amber-600 dark:text-amber-400"}
              >
                <Hand className="h-4 w-4 mr-2" />
                {raisedHands.size > 0 ? `Hands (${raisedHands.size})` : "Hands"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuLabel className="flex items-center justify-between">
                <span>Raised Hands</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleHandRaisingMutation.mutate(!(settings?.handRaisingEnabled !== false))}
                  className="h-6 px-2 text-xs"
                >
                  <MessageSquareOff className="h-3 w-3 mr-1" />
                  {settings?.handRaisingEnabled !== false ? "Disable" : "Enable"}
                </Button>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {raisedHands.size === 0 ? (
                <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                  No raised hands
                </div>
              ) : (
                Array.from(raisedHands.values()).map((hand) => (
                  <DropdownMenuItem
                    key={hand.studentId}
                    className="flex items-center justify-between cursor-pointer"
                    onClick={() => dismissHandMutation.mutate(hand.studentId)}
                  >
                    <div className="flex items-center">
                      <Hand className="h-4 w-4 mr-2 text-amber-500" />
                      <div>
                        <div className="font-medium">{hand.studentName}</div>
                        <div className="text-xs text-muted-foreground">
                          {new Date(hand.timestamp).toLocaleTimeString()}
                        </div>
                      </div>
                    </div>
                    <X className="h-4 w-4 text-muted-foreground hover:text-foreground" />
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Student Messages (Two-Way Chat) */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant={studentMessages.filter(m => !m.read).length > 0 ? "default" : "outline"}
                data-testid="button-student-messages"
                className={studentMessages.filter(m => !m.read).length > 0 ? "bg-blue-500 hover:bg-blue-600 text-white animate-pulse" : "text-blue-600 dark:text-blue-400"}
              >
                <MessageSquare className="h-4 w-4 mr-2" />
                {studentMessages.filter(m => !m.read).length > 0 ? `Messages (${studentMessages.filter(m => !m.read).length})` : "Messages"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80">
              <DropdownMenuLabel>Student Messages</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {studentMessages.length === 0 ? (
                <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                  No messages from students
                </div>
              ) : (
                <div className="max-h-80 overflow-y-auto">
                  {studentMessages.slice(0, 10).map((msg) => (
                    <div
                      key={msg.id}
                      className={`px-3 py-2 border-b last:border-b-0 ${!msg.read ? 'bg-blue-50 dark:bg-blue-950' : ''}`}
                      onClick={() => markMessageRead(msg.id)}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={`text-xs px-1.5 py-0.5 rounded ${msg.messageType === 'question' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300' : 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'}`}>
                              {msg.messageType === 'question' ? '?' : 'msg'}
                            </span>
                            <span className="font-medium text-sm truncate">{msg.studentName}</span>
                          </div>
                          <p className="text-sm text-foreground mt-1 break-words">{msg.message}</p>
                          <div className="text-xs text-muted-foreground mt-1">
                            {new Date(msg.timestamp).toLocaleTimeString()}
                          </div>
                        </div>
                        <div className="flex flex-col gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0"
                            onClick={(e) => {
                              e.stopPropagation();
                              setReplyingToMessage(replyingToMessage === msg.id ? null : msg.id);
                              setReplyText("");
                            }}
                          >
                            <Send className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0"
                            onClick={(e) => {
                              e.stopPropagation();
                              dismissMessage(msg.id);
                            }}
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                      {replyingToMessage === msg.id && (
                        <div className="mt-2 flex gap-2" onClick={(e) => e.stopPropagation()}>
                          <Input
                            value={replyText}
                            onChange={(e) => setReplyText(e.target.value)}
                            placeholder="Type reply..."
                            className="h-8 text-sm"
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && replyText.trim()) {
                                replyToMessageMutation.mutate({ studentId: msg.studentId, message: replyText.trim() });
                              }
                            }}
                          />
                          <Button
                            size="sm"
                            className="h-8"
                            disabled={!replyText.trim() || replyToMessageMutation.isPending}
                            onClick={() => {
                              if (replyText.trim()) {
                                replyToMessageMutation.mutate({ studentId: msg.studentId, message: replyText.trim() });
                              }
                            }}
                          >
                            <Send className="h-3 w-3" />
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Subgroup Filter */}
          {subgroups.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="button-subgroup-filter"
                  className={selectedSubgroupId ? "text-pink-600 dark:text-pink-400 border-pink-300" : "text-pink-600 dark:text-pink-400"}
                >
                  <UsersRound className="h-4 w-4 mr-2" />
                  {selectedSubgroupId
                    ? subgroups.find(s => s.id === selectedSubgroupId)?.name || "Subgroup"
                    : "Subgroups"}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Filter by Subgroup</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={!selectedSubgroupId}
                  onCheckedChange={() => setSelectedSubgroupId("")}
                >
                  All Students
                </DropdownMenuCheckboxItem>
                {subgroups.map((subgroup) => (
                  <DropdownMenuCheckboxItem
                    key={subgroup.id}
                    checked={selectedSubgroupId === subgroup.id}
                    onCheckedChange={() => setSelectedSubgroupId(subgroup.id)}
                  >
                    <span
                      className="w-3 h-3 rounded-full mr-2"
                      style={{ backgroundColor: subgroup.color || '#9333ea' }}
                    />
                    {subgroup.name}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          </div>
        )}

        {/* Student Tiles */}
        {currentUser?.role === 'teacher' && !activeSession ? (
          <div className="py-20 text-center">
            <div className="h-20 w-20 mx-auto mb-6 rounded-2xl bg-muted/30 flex items-center justify-center">
              <Calendar className="h-10 w-10 text-muted-foreground/50" />
            </div>
            <h3 className="text-xl font-semibold mb-2">No Active Class Session</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto mb-6">
              Start a class session to view and monitor your students. Click "Start Class" in the top right to select a class period.
            </p>
            {groups.length === 0 && (
              <p className="text-xs text-muted-foreground max-w-md mx-auto">
                You don't have any class groups yet. Contact your administrator to have students assigned to your classes.
              </p>
            )}
          </div>
        ) : filteredStudents.length === 0 ? (
          <div className="py-20 text-center">
            <div className="h-20 w-20 mx-auto mb-6 rounded-2xl bg-muted/30 flex items-center justify-center">
              <Monitor className="h-10 w-10 text-muted-foreground/50" />
            </div>
            <h3 className="text-xl font-semibold mb-2">No students found</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              {searchQuery
                ? "Try adjusting your search query to find students"
                : "No student devices are currently registered. Students will appear here when they connect with the Chrome extension."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 2xl:grid-cols-6 gap-6">
            {filteredStudents.map((student) => {
              const primaryDeviceId = student.primaryDeviceId ?? undefined;
              const tileRevision = primaryDeviceId ? tileRevisions[primaryDeviceId] ?? 0 : 0;

              return (
                <StudentTile
                  key={`${student.studentId}-${primaryDeviceId ?? "no-device"}-${tileRevision}`}
                  student={student}
                  onClick={() => setSelectedStudent(student)}
                  blockedDomains={settings?.blockedDomains || []}
                  isOffTask={isStudentOffTask(student)}
                  isSelected={selectedStudentIds.has(student.studentId)}
                  onToggleSelect={() => toggleStudentSelection(student.studentId)}
                  liveStream={primaryDeviceId ? liveStreams.get(primaryDeviceId) || null : null}
                  onStartLiveView={primaryDeviceId ? () => handleStartLiveView(primaryDeviceId) : undefined}
                  onStopLiveView={primaryDeviceId ? () => handleStopLiveView(primaryDeviceId) : undefined}
                  onEndLiveRefresh={primaryDeviceId ? () => refreshTile(primaryDeviceId) : undefined}
                  onBlockRefetches={() => { optimisticUpdateUntilRef.current = Date.now() + 15000; }}
                />
              );
            })}
          </div>
        )}
      </main>

      {/* Student Detail Drawer */}
      {selectedStudent && (
        <StudentDetailDrawer
          student={selectedStudent}
          urlHistory={urlHistory}
          allowedDomains={settings?.allowedDomains || []}
          onClose={() => setSelectedStudent(null)}
        />
      )}

      {/* Export Dialog */}
      <Dialog open={showExportDialog} onOpenChange={setShowExportDialog}>
        <DialogContent data-testid="dialog-export-excel">
          <DialogHeader>
            <DialogTitle>Export Activity Report</DialogTitle>
            <DialogDescription>
              Select a date range to export student activity data as CSV (.csv)
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="start-date">Start Date</Label>
              <Input
                id="start-date"
                type="date"
                value={exportStartDate}
                onChange={(e) => setExportStartDate(e.target.value)}
                data-testid="input-export-start-date"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="end-date">End Date</Label>
              <Input
                id="end-date"
                type="date"
                value={exportEndDate}
                onChange={(e) => setExportEndDate(e.target.value)}
                data-testid="input-export-end-date"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowExportDialog(false)} data-testid="button-cancel-export">
              Cancel
            </Button>
            <Button onClick={handleExportCSV} data-testid="button-confirm-export">
              <Download className="h-4 w-4 mr-2" />
              Export
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Grade Management Dialog */}
      <Dialog open={showGradeDialog} onOpenChange={setShowGradeDialog}>
        <DialogContent data-testid="dialog-manage-grades">
          <DialogHeader>
            <DialogTitle>Manage Grade Levels</DialogTitle>
            <DialogDescription>
              Add or remove grade levels that appear as filter tabs on the dashboard
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* Current Grades */}
            <div className="space-y-2">
              <Label>Current Grade Levels</Label>
              <div className="flex flex-wrap gap-2">
                {settings?.gradeLevels?.map((grade) => (
                  <Badge key={grade} variant="secondary" className="text-sm px-3 py-1" data-testid={`badge-grade-${grade}`}>
                    {grade}
                    <button
                      onClick={() => handleDeleteGrade(grade)}
                      className="ml-2 hover:text-destructive"
                      data-testid={`button-delete-grade-${grade}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            </div>

            {/* Add New Grade */}
            <div className="space-y-2">
              <Label htmlFor="new-grade">Add New Grade Level</Label>
              <div className="flex gap-2">
                <Input
                  id="new-grade"
                  placeholder="e.g., 5th, K, Pre-K"
                  value={newGrade}
                  onChange={(e) => setNewGrade(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleAddGrade();
                    }
                  }}
                  data-testid="input-new-grade"
                />
                <Button 
                  onClick={handleAddGrade} 
                  disabled={updateGradesMutation.isPending}
                  data-testid="button-add-grade"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => {
                setShowGradeDialog(false);
                setNewGrade("");
              }}
              data-testid="button-close-grade-dialog"
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Open Tab Dialog */}
      <Dialog open={showOpenTabDialog} onOpenChange={setShowOpenTabDialog}>
        <DialogContent data-testid="dialog-open-tab">
          <DialogHeader>
            <DialogTitle>Open Tab on Student Devices</DialogTitle>
            <DialogDescription>
              {selectedStudentIds.size > 0
                ? `Open a URL on ${selectedStudentIds.size} selected student(s)`
                : "Open a URL on all student devices"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="open-tab-url">URL to Open</Label>
              <Input
                id="open-tab-url"
                type="url"
                placeholder="https://example.com"
                value={openTabUrl}
                onChange={(e) => setOpenTabUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !openTabMutation.isPending) {
                    handleOpenTab();
                  }
                }}
                data-testid="input-open-tab-url"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowOpenTabDialog(false)} data-testid="button-cancel-open-tab">
              Cancel
            </Button>
            <Button onClick={handleOpenTab} disabled={openTabMutation.isPending} data-testid="button-confirm-open-tab">
              <MonitorPlay className="h-4 w-4 mr-2" />
              Open Tab
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Tabs Dialog */}
      <Dialog open={showCloseTabsDialog} onOpenChange={setShowCloseTabsDialog}>
        <DialogContent className="max-w-2xl" data-testid="dialog-tabs">
          <DialogHeader>
            <DialogTitle>Open Tabs ({openTabs.length})</DialogTitle>
            <DialogDescription>
              {selectedStudentIds.size > 0
                ? `Viewing tabs from ${selectedStudentIds.size} selected student(s)`
                : "Viewing tabs from all students"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {openTabs.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                No tabs are currently open on {selectedStudentIds.size > 0 ? 'selected students' : 'any student devices'}
              </p>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setSelectedTabsToClose(new Set(openTabs.map(t => `${t.studentId}|${t.deviceId}|${t.url}`)))}
                    data-testid="button-select-all-tabs"
                    className="h-8"
                  >
                    <CheckSquare className="h-3 w-3 mr-1" />
                    Select All
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setSelectedTabsToClose(new Set())}
                    data-testid="button-clear-tabs"
                    className="h-8"
                  >
                    <XSquare className="h-3 w-3 mr-1" />
                    Clear
                  </Button>
                  <span className="text-xs text-muted-foreground ml-auto">
                    {selectedTabsToClose.size} selected
                  </span>
                </div>
                <div className="border rounded-md max-h-80 overflow-y-auto">
                  {openTabs.map((tab) => {
                    const compositeKey = `${tab.studentId}|${tab.deviceId}|${tab.url}`;
                    const hostname = (() => {
                      try { return new URL(tab.url).hostname; } catch { return tab.url; }
                    })();
                    return (
                      <div
                        key={compositeKey}
                        className="flex items-center gap-3 p-3 hover:bg-muted/50 border-b last:border-b-0 group"
                        data-testid={`tab-row-${tab.deviceId}-${encodeURIComponent(tab.url)}`}
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 shrink-0"
                          checked={selectedTabsToClose.has(compositeKey)}
                          onChange={(e) => {
                            const newSet = new Set(selectedTabsToClose);
                            if (e.target.checked) {
                              newSet.add(compositeKey);
                            } else {
                              newSet.delete(compositeKey);
                            }
                            setSelectedTabsToClose(newSet);
                          }}
                          data-testid={`checkbox-tab-${encodeURIComponent(tab.url)}`}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium truncate">{tab.title}</span>
                          </div>
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <span className="truncate">{hostname}</span>
                            <span>•</span>
                            <span className="shrink-0">{tab.studentName}</span>
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0 opacity-50 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => handleCloseSingleTab(tab.deviceId, tab.url)}
                          disabled={closeTabsMutation.isPending}
                          title="Close this tab"
                          data-testid={`button-close-tab-${encodeURIComponent(tab.url)}`}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setShowCloseTabsDialog(false)} data-testid="button-close-tabs-dialog">
              Done
            </Button>
            {selectedTabsToClose.size > 0 && (
              <Button
                variant="destructive"
                onClick={handleCloseTabs}
                disabled={closeTabsMutation.isPending}
                data-testid="button-close-selected-tabs"
              >
                <X className="h-4 w-4 mr-2" />
                Close Selected ({selectedTabsToClose.size})
              </Button>
            )}
            {openTabs.length > 0 && (
              <Button
                variant="destructive"
                onClick={() => {
                  const targetDeviceIds = getTargetDeviceIds();
                  closeTabsMutation.mutate({ closeAll: true, targetDeviceIds });
                }}
                disabled={closeTabsMutation.isPending}
                data-testid="button-close-all-tabs"
              >
                <TabletSmartphone className="h-4 w-4 mr-2" />
                Close All Tabs
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Apply Flight Path Dialog */}
      <Dialog open={showApplyFlightPathDialog} onOpenChange={setShowApplyFlightPathDialog}>
        <DialogContent data-testid="dialog-apply-flight-path">
          <DialogHeader>
            <DialogTitle>Apply Flight Path to Students</DialogTitle>
            <DialogDescription>
              {selectedStudentIds.size > 0
                ? `Apply a flight path to ${selectedStudentIds.size} selected student(s)`
                : "Apply a flight path to all students"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="flight-path-select">Select Flight Path</Label>
              <Select value={selectedFlightPathId} onValueChange={setSelectedFlightPathId}>
                <SelectTrigger id="flight-path-select" data-testid="select-flight-path">
                  <SelectValue placeholder="Choose a flight path" />
                </SelectTrigger>
                <SelectContent>
                  {flightPaths.map((flightPath) => (
                    <SelectItem key={flightPath.id} value={flightPath.id} data-testid={`option-flight-path-${flightPath.id}`}>
                      {flightPath.flightPathName}
                    </SelectItem>
                  ))}
                  {flightPaths.length === 0 && (
                    <div className="p-2 text-sm text-muted-foreground">
                      No flight paths available
                    </div>
                  )}
                </SelectContent>
              </Select>
              {selectedFlightPathId && (() => {
                const fp = flightPaths.find(f => f.id === selectedFlightPathId);
                return fp ? (
                  <div className="mt-2 p-3 bg-muted/30 rounded-md">
                    <p className="text-xs font-medium mb-1">Description:</p>
                    <p className="text-xs text-muted-foreground mb-2">{fp.description || "No description provided"}</p>
                    <p className="text-xs font-medium mb-1">Allowed Domains ({fp.allowedDomains?.length || 0}):</p>
                    <div className="flex flex-wrap gap-1">
                      {fp.allowedDomains && fp.allowedDomains.length > 0 ? (
                        fp.allowedDomains.map((domain, idx) => (
                          <Badge key={idx} variant="secondary" className="text-xs">
                            {domain}
                          </Badge>
                        ))
                      ) : (
                        <p className="text-xs text-muted-foreground">No restrictions</p>
                      )}
                    </div>
                  </div>
                ) : null;
              })()}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowApplyFlightPathDialog(false)} data-testid="button-cancel-apply-flight-path">
              Cancel
            </Button>
            <Button onClick={handleApplyFlightPath} disabled={applyFlightPathMutation.isPending} data-testid="button-confirm-apply-flight-path">
              <Layers className="h-4 w-4 mr-2" />
              Apply Flight Path
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Flight Path Viewer Dialog */}
      <Dialog open={showFlightPathViewerDialog} onOpenChange={setShowFlightPathViewerDialog}>
        <DialogContent className="max-w-2xl" data-testid="dialog-flight-path-viewer">
          <DialogHeader>
            <DialogTitle>Flight Path Status</DialogTitle>
            <DialogDescription>
              View which flight paths students are currently on
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[400px] overflow-y-auto">
            <table className="w-full">
              <thead className="border-b sticky top-0 bg-background">
                <tr>
                  <th className="text-left p-2 text-sm font-medium">Student</th>
                  <th className="text-left p-2 text-sm font-medium">Flight Path</th>
                  <th className="text-left p-2 text-sm font-medium">Status</th>
                  <th className="text-left p-2 text-sm font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {students.map((student) => {
                  const primaryDeviceId = student.primaryDeviceId ?? undefined;

                  return (
                    <tr key={student.studentId} className="border-b" data-testid={`row-student-${student.studentId}`}>
                      <td className="p-2 text-sm">{student.studentName}</td>
                      <td className="p-2">
                        {student.flightPathActive && student.activeFlightPathName ? (
                          <Badge variant="secondary" className="text-xs" data-testid={`badge-flight-path-${student.studentId}`}>
                            {student.activeFlightPathName}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">No flight path</span>
                        )}
                      </td>
                      <td className="p-2">
                        <Badge 
                          variant={student.status === 'online' ? 'default' : student.status === 'idle' ? 'secondary' : 'outline'}
                          className="text-xs"
                          data-testid={`badge-status-${student.studentId}`}
                        >
                          {student.status}
                        </Badge>
                      </td>
                      <td className="p-2">
                        {student.flightPathActive && primaryDeviceId ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleRemoveFlightPath(primaryDeviceId)}
                            disabled={removeFlightPathMutation.isPending}
                            data-testid={`button-remove-flight-path-${student.studentId}`}
                            className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                          >
                            <X className="h-3 w-3 mr-1" />
                            Remove
                          </Button>
                        ) : student.screenLocked && primaryDeviceId ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => unlockScreenMutation.mutate({ targetDeviceIds: [primaryDeviceId], devicesToUnlock: [primaryDeviceId] })}
                            disabled={unlockScreenMutation.isPending}
                            data-testid={`button-unlock-screen-${student.studentId}`}
                            className="h-7 px-2 text-xs"
                          >
                            <Unlock className="h-3 w-3 mr-1" />
                            Unlock
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {students.length === 0 && (
                  <tr>
                    <td colSpan={4} className="p-4 text-center text-sm text-muted-foreground">
                      No students found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <DialogFooter>
            <Button onClick={() => setShowFlightPathViewerDialog(false)} data-testid="button-close-flight-path-viewer">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Apply Block List Dialog */}
      <Dialog open={showApplyBlockListDialog} onOpenChange={setShowApplyBlockListDialog}>
        <DialogContent data-testid="dialog-apply-block-list">
          <DialogHeader>
            <DialogTitle>Apply Block List to Students</DialogTitle>
            <DialogDescription>
              {selectedStudentIds.size > 0
                ? `Apply a block list to ${selectedStudentIds.size} selected student(s)`
                : "Apply a block list to all online students"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="block-list-select">Select Block List</Label>
              <Select value={selectedBlockListId} onValueChange={setSelectedBlockListId}>
                <SelectTrigger id="block-list-select" data-testid="select-block-list">
                  <SelectValue placeholder="Choose a block list" />
                </SelectTrigger>
                <SelectContent>
                  {blockLists.map((blockList) => (
                    <SelectItem key={blockList.id} value={blockList.id} data-testid={`option-block-list-${blockList.id}`}>
                      {blockList.name}
                    </SelectItem>
                  ))}
                  {blockLists.length === 0 && (
                    <div className="p-2 text-sm text-muted-foreground">
                      No block lists available. Create one in My Settings.
                    </div>
                  )}
                </SelectContent>
              </Select>
              {selectedBlockListId && (() => {
                const bl = blockLists.find(b => b.id === selectedBlockListId);
                return bl ? (
                  <div className="mt-2 p-3 bg-muted/30 rounded-md">
                    <p className="text-xs font-medium mb-1">Description:</p>
                    <p className="text-xs text-muted-foreground mb-2">{bl.description || "No description provided"}</p>
                    <p className="text-xs font-medium mb-1">Blocked Domains ({bl.blockedDomains?.length || 0}):</p>
                    <div className="flex flex-wrap gap-1">
                      {bl.blockedDomains && bl.blockedDomains.length > 0 ? (
                        bl.blockedDomains.map((domain, idx) => (
                          <Badge key={idx} variant="destructive" className="text-xs">
                            {domain}
                          </Badge>
                        ))
                      ) : (
                        <p className="text-xs text-muted-foreground">No domains</p>
                      )}
                    </div>
                  </div>
                ) : null;
              })()}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowApplyBlockListDialog(false)} data-testid="button-cancel-apply-block-list">
              Cancel
            </Button>
            <Button onClick={handleApplyBlockList} disabled={applyBlockListMutation.isPending || !selectedBlockListId} data-testid="button-confirm-apply-block-list">
              <ShieldBan className="h-4 w-4 mr-2" />
              Apply Block List
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Block List Viewer Dialog */}
      <Dialog open={showBlockListViewerDialog} onOpenChange={setShowBlockListViewerDialog}>
        <DialogContent className="max-w-2xl" data-testid="dialog-block-list-viewer">
          <DialogHeader>
            <DialogTitle>Block List Status</DialogTitle>
            <DialogDescription>
              Manage active block lists for your students. Block lists are session-based and will be removed when students disconnect.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between p-3 bg-muted/30 rounded-md">
              <div>
                <p className="text-sm font-medium">Remove Block List from All Students</p>
                <p className="text-xs text-muted-foreground">This will remove any teacher-applied block list from all online students</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRemoveBlockList}
                disabled={removeBlockListMutation.isPending}
                className="text-destructive hover:text-destructive"
                data-testid="button-remove-all-block-lists"
              >
                <X className="h-4 w-4 mr-2" />
                Remove All
              </Button>
            </div>
            <div className="border-t pt-4">
              <p className="text-sm font-medium mb-2">Your Block Lists</p>
              {blockLists.length === 0 ? (
                <p className="text-sm text-muted-foreground">No block lists created yet. Create one in My Settings.</p>
              ) : (
                <div className="space-y-2 max-h-[250px] overflow-y-auto">
                  {blockLists.map((bl) => (
                    <div key={bl.id} className="flex items-center justify-between p-3 border rounded-md" data-testid={`block-list-item-${bl.id}`}>
                      <div className="flex-1">
                        <p className="text-sm font-medium">{bl.name}</p>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {bl.blockedDomains?.slice(0, 3).map((domain, idx) => (
                            <Badge key={idx} variant="secondary" className="text-xs">
                              {domain}
                            </Badge>
                          ))}
                          {(bl.blockedDomains?.length || 0) > 3 && (
                            <Badge variant="secondary" className="text-xs">
                              +{(bl.blockedDomains?.length || 0) - 3} more
                            </Badge>
                          )}
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSelectedBlockListId(bl.id);
                          setShowBlockListViewerDialog(false);
                          setShowApplyBlockListDialog(true);
                        }}
                        data-testid={`button-quick-apply-${bl.id}`}
                      >
                        <ShieldBan className="h-4 w-4 mr-2" />
                        Apply
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setShowBlockListViewerDialog(false)} data-testid="button-close-block-list-viewer">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Attention Mode Dialog */}
      <Dialog open={showAttentionDialog} onOpenChange={setShowAttentionDialog}>
        <DialogContent data-testid="dialog-attention-mode">
          <DialogHeader>
            <DialogTitle>Attention Mode</DialogTitle>
            <DialogDescription>
              {selectedStudentIds.size > 0
                ? `Get the attention of ${selectedStudentIds.size} selected student(s)`
                : "Get the attention of all students"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="attention-message">Message to Display</Label>
              <Input
                id="attention-message"
                value={attentionMessage}
                onChange={(e) => setAttentionMessage(e.target.value)}
                placeholder="Please look up!"
                data-testid="input-attention-message"
              />
              <p className="text-xs text-muted-foreground">
                This message will be shown full-screen on student devices until you release them.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAttentionDialog(false)} data-testid="button-cancel-attention">
              Cancel
            </Button>
            <Button
              onClick={() => handleAttentionMode(true)}
              disabled={attentionModeMutation.isPending}
              className="bg-indigo-600 hover:bg-indigo-700"
              data-testid="button-activate-attention"
            >
              <Eye className="h-4 w-4 mr-2" />
              Activate Attention Mode
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Timer Dialog */}
      <Dialog open={showTimerDialog} onOpenChange={setShowTimerDialog}>
        <DialogContent data-testid="dialog-timer">
          <DialogHeader>
            <DialogTitle>Start Timer</DialogTitle>
            <DialogDescription>
              {selectedStudentIds.size > 0
                ? `Display a countdown timer for ${selectedStudentIds.size} selected student(s)`
                : "Display a countdown timer for all students"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Quick Presets</Label>
              <div className="flex gap-2 flex-wrap">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setTimerMinutes(1); setTimerSeconds(0); }}
                  data-testid="button-timer-1min"
                >
                  1 min
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setTimerMinutes(3); setTimerSeconds(0); }}
                  data-testid="button-timer-3min"
                >
                  3 min
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setTimerMinutes(5); setTimerSeconds(0); }}
                  data-testid="button-timer-5min"
                >
                  5 min
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setTimerMinutes(10); setTimerSeconds(0); }}
                  data-testid="button-timer-10min"
                >
                  10 min
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setTimerMinutes(15); setTimerSeconds(0); }}
                  data-testid="button-timer-15min"
                >
                  15 min
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Custom Time</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min="0"
                  max="60"
                  value={timerMinutes}
                  onChange={(e) => setTimerMinutes(Math.max(0, Math.min(60, parseInt(e.target.value) || 0)))}
                  className="w-20"
                  data-testid="input-timer-minutes"
                />
                <span className="text-sm text-muted-foreground">min</span>
                <Input
                  type="number"
                  min="0"
                  max="59"
                  value={timerSeconds}
                  onChange={(e) => setTimerSeconds(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))}
                  className="w-20"
                  data-testid="input-timer-seconds"
                />
                <span className="text-sm text-muted-foreground">sec</span>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="timer-message">Optional Message</Label>
              <Input
                id="timer-message"
                value={timerMessage}
                onChange={(e) => setTimerMessage(e.target.value)}
                placeholder="e.g., Complete the assignment"
                data-testid="input-timer-message"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTimerDialog(false)} data-testid="button-cancel-timer">
              Cancel
            </Button>
            <Button
              onClick={handleStartTimer}
              disabled={timerMutation.isPending}
              className="bg-teal-600 hover:bg-teal-700"
              data-testid="button-start-timer"
            >
              <Timer className="h-4 w-4 mr-2" />
              Start Timer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Poll Dialog */}
      <Dialog open={showPollDialog} onOpenChange={setShowPollDialog}>
        <DialogContent className="max-w-lg" data-testid="dialog-poll">
          <DialogHeader>
            <DialogTitle>Create Poll</DialogTitle>
            <DialogDescription>
              {selectedStudentIds.size > 0
                ? `Send a poll to ${selectedStudentIds.size} selected student(s)`
                : "Send a poll to all students"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="poll-question">Question</Label>
              <Input
                id="poll-question"
                value={pollQuestion}
                onChange={(e) => setPollQuestion(e.target.value)}
                placeholder="What do you think about...?"
                data-testid="input-poll-question"
              />
            </div>
            <div className="space-y-2">
              <Label>Options (2-5)</Label>
              <div className="space-y-2">
                {pollOptions.map((option, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full bg-violet-100 dark:bg-violet-900 text-violet-600 dark:text-violet-400 flex items-center justify-center text-sm font-medium flex-shrink-0">
                      {String.fromCharCode(65 + index)}
                    </span>
                    <Input
                      value={option}
                      onChange={(e) => updatePollOption(index, e.target.value)}
                      placeholder={`Option ${String.fromCharCode(65 + index)}`}
                      data-testid={`input-poll-option-${index}`}
                    />
                    {pollOptions.length > 2 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removePollOption(index)}
                        className="text-destructive hover:text-destructive"
                        data-testid={`button-remove-option-${index}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              {pollOptions.length < 5 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={addPollOption}
                  className="w-full mt-2"
                  data-testid="button-add-option"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add Option
                </Button>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPollDialog(false)} data-testid="button-cancel-poll">
              Cancel
            </Button>
            <Button
              onClick={handleCreatePoll}
              disabled={pollMutation.isPending}
              className="bg-violet-600 hover:bg-violet-700"
              data-testid="button-create-poll"
            >
              <BarChart3 className="h-4 w-4 mr-2" />
              Create Poll
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Poll Results Dialog */}
      <Dialog open={showPollResultsDialog} onOpenChange={setShowPollResultsDialog}>
        <DialogContent className="max-w-lg" data-testid="dialog-poll-results">
          <DialogHeader>
            <DialogTitle>Poll Results</DialogTitle>
            <DialogDescription>
              {activePoll?.question}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="text-center text-2xl font-bold text-violet-600 dark:text-violet-400">
              {pollTotalResponses} response{pollTotalResponses !== 1 ? 's' : ''}
            </div>
            <div className="space-y-3">
              {activePoll?.options.map((option, index) => {
                const result = pollResults.find(r => r.option === index);
                const count = result?.count || 0;
                const percentage = pollTotalResponses > 0 ? Math.round((count / pollTotalResponses) * 100) : 0;
                return (
                  <div key={index} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <span className="w-6 h-6 rounded-full bg-violet-100 dark:bg-violet-900 text-violet-600 dark:text-violet-400 flex items-center justify-center text-xs font-medium">
                          {String.fromCharCode(65 + index)}
                        </span>
                        <span>{option}</span>
                      </div>
                      <span className="font-medium">{count} ({percentage}%)</span>
                    </div>
                    <div className="h-4 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-violet-500 to-purple-500 rounded-full transition-all duration-500"
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPollResultsDialog(false)} data-testid="button-close-results">
              Close
            </Button>
            <Button
              variant="destructive"
              onClick={handleClosePoll}
              disabled={closePollMutation.isPending}
              data-testid="button-end-poll"
            >
              <X className="h-4 w-4 mr-2" />
              End Poll
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Floating Action Button for quick access */}
      <TeacherFab
        attentionActive={attentionActive}
        onAttentionClick={() => attentionActive ? handleAttentionMode(false) : setShowAttentionDialog(true)}
        attentionPending={attentionModeMutation.isPending}
        timerActive={timerActive}
        onTimerClick={() => timerActive ? handleStopTimer() : setShowTimerDialog(true)}
        timerPending={timerMutation.isPending}
        activePoll={activePoll}
        pollTotalResponses={pollTotalResponses}
        onPollClick={() => activePoll ? setShowPollResultsDialog(true) : setShowPollDialog(true)}
        pollPending={pollMutation.isPending}
        raisedHands={raisedHands}
        onDismissHand={(studentId) => dismissHandMutation.mutate(studentId)}
        studentMessages={studentMessages}
        onMarkMessageRead={markMessageRead}
        onDismissMessage={dismissMessage}
        onReplyToMessage={(studentId, message) => replyToMessageMutation.mutate({ studentId, message })}
        replyPending={replyToMessageMutation.isPending}
      />
    </div>
  );
}
