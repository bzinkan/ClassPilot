import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Monitor, Users, Activity, Settings as SettingsIcon, LogOut, Download, Calendar, Shield, AlertTriangle, UserCog, Plus, X, GraduationCap, WifiOff, Video, MonitorPlay, TabletSmartphone, Lock, Unlock, Layers, Route, CheckSquare, XSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { StudentTile } from "@/components/student-tile";
import { StudentDetailDrawer } from "@/components/student-detail-drawer";
import { RemoteControlToolbar } from "@/components/remote-control-toolbar";
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
import type { StudentStatus, Heartbeat, Settings, FlightPath } from "@shared/schema";

interface CurrentUser {
  id: string;
  username: string;
  role: string;
  schoolName: string;
}

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const [selectedStudent, setSelectedStudent] = useState<StudentStatus | null>(null);
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<Set<string>>(new Set());
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
  const [closeTabsMode, setCloseTabsMode] = useState<"all" | "pattern">("all");
  const [closeTabsPattern, setCloseTabsPattern] = useState("");
  const [showLockScreenDialog, setShowLockScreenDialog] = useState(false);
  const [lockScreenUrl, setLockScreenUrl] = useState("");
  const [showApplyFlightPathDialog, setShowApplyFlightPathDialog] = useState(false);
  const [selectedFlightPathId, setSelectedFlightPathId] = useState("");
  const [showFlightPathViewerDialog, setShowFlightPathViewerDialog] = useState(false);
  const { toast } = useToast();
  const notifiedViolations = useRef<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const isMountedRef = useRef(true); // Track if component is mounted
  const maxReconnectDelay = 30000; // 30 seconds max delay
  
  // WebRTC hook for live video streaming
  const webrtc = useWebRTC(wsRef.current);

  const { data: students = [], refetch } = useQuery<StudentStatus[]>({
    queryKey: ['/api/students'],
    refetchInterval: 5000, // Poll every 5 seconds to update idle/offline status
  });

  const { data: urlHistory = [] } = useQuery<Heartbeat[]>({
    queryKey: ['/api/heartbeats', selectedStudent?.deviceId],
    enabled: !!selectedStudent,
  });

  const { data: settings } = useQuery<Settings>({
    queryKey: ['/api/settings'],
  });

  const { data: flightPaths = [] } = useQuery<FlightPath[]>({
    queryKey: ['/api/flight-paths'],
  });

  const { data: currentUserData } = useQuery<{ success: boolean; user: CurrentUser }>({
    queryKey: ['/api/me'],
  });

  const currentUser = currentUserData?.user;

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
          
          // Authenticate as teacher
          socket.send(JSON.stringify({ type: 'auth', role: 'teacher' }));
          console.log("[Dashboard] Sent auth message");
        };

        socket.onmessage = (event) => {
          if (!isMountedRef.current) return; // Don't process messages if unmounted
          
          try {
            const message = JSON.parse(event.data);
            console.log("[Dashboard] WebSocket message received:", message);
            if (message.type === 'student-update') {
              console.log("[Dashboard] Student update detected, invalidating queries...");
              // Invalidate queries to force refetch (needed because staleTime: Infinity)
              queryClient.invalidateQueries({ queryKey: ['/api/students'] });
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

  // Check if student is off-task (not on allowed domains)
  const isStudentOffTask = (student: StudentStatus): boolean => {
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
  const toggleStudentSelection = (deviceId: string) => {
    setSelectedDeviceIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(deviceId)) {
        newSet.delete(deviceId);
      } else {
        newSet.add(deviceId);
      }
      return newSet;
    });
  };

  const selectAll = () => {
    const allDeviceIds = filteredStudents.map((s) => s.deviceId);
    setSelectedDeviceIds(new Set(allDeviceIds));
  };

  const clearSelection = () => {
    setSelectedDeviceIds(new Set());
  };

  // Live view handlers
  const handleStartLiveView = async (deviceId: string) => {
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

  const filteredStudents = students
    .filter((student) => {
      const matchesSearch = 
        (student.studentName || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        student.deviceId.toLowerCase().includes(searchQuery.toLowerCase()) ||
        student.classId.toLowerCase().includes(searchQuery.toLowerCase());
      
      if (!matchesSearch) return false;
      
      // Filter by gradeLevel field (selectedGrade will always have a value from settings)
      return student.gradeLevel === selectedGrade;
    })
    .sort((a, b) => {
      // Sort off-task students to the top
      const aOffTask = isStudentOffTask(a);
      const bOffTask = isStudentOffTask(b);
      
      if (aOffTask && !bOffTask) return -1;
      if (!aOffTask && bOffTask) return 1;
      
      // Within same off-task status, sort alphabetically by last name
      const aLastName = getLastName(a.studentName);
      const bLastName = getLastName(b.studentName);
      
      return aLastName.localeCompare(bLastName);
    });

  // Count stats only for students in the currently selected grade
  const studentsInGrade = students.filter((s) => s.gradeLevel === selectedGrade);
  const onlineCount = studentsInGrade.filter((s) => s.status === 'online').length;
  const idleCount = studentsInGrade.filter((s) => s.status === 'idle').length;
  const offlineCount = studentsInGrade.filter((s) => s.status === 'offline').length;
  const cameraActiveCount = studentsInGrade.filter((s) => s.cameraActive).length;
  const offTaskCount = studentsInGrade.filter(isStudentOffTask).length;

  // Check for blocked domain violations and show notifications
  useEffect(() => {
    if (!settings?.blockedDomains || settings.blockedDomains.length === 0) return;

    students.forEach((student) => {
      const deviceId = student.deviceId;
      
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

  // Track camera usage notifications
  const notifiedCameraUsage = useRef<Set<string>>(new Set());
  
  // Check for camera usage and show notifications
  useEffect(() => {
    students.forEach((student) => {
      const cameraKey = `${student.deviceId}-camera`;
      
      if (student.cameraActive) {
        // Only notify if this is new camera usage (not previously notified)
        if (!notifiedCameraUsage.current.has(cameraKey)) {
          toast({
            title: "Camera Active",
            description: `${student.studentName} has activated their camera`,
            duration: 5000,
          });
          notifiedCameraUsage.current.add(cameraKey);
        }
      } else {
        // Clear notification if student turned off camera
        notifiedCameraUsage.current.delete(cameraKey);
      }
    });
  }, [students, toast]);

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

  // Remote control mutations
  const openTabMutation = useMutation({
    mutationFn: async ({ url, targetDeviceIds }: { url: string; targetDeviceIds?: string[] }) => {
      const res = await apiRequest('POST', '/api/remote/open-tab', { url, targetDeviceIds });
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Success",
        description: data.message,
      });
      setShowOpenTabDialog(false);
      setOpenTabUrl("");
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
    mutationFn: async ({ closeAll, pattern, targetDeviceIds }: { closeAll?: boolean; pattern?: string; targetDeviceIds?: string[] }) => {
      const res = await apiRequest('POST', '/api/remote/close-tabs', { closeAll, pattern, targetDeviceIds });
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Success",
        description: data.message,
      });
      setShowCloseTabsDialog(false);
      setCloseTabsPattern("");
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
    mutationFn: async ({ url, targetDeviceIds }: { url: string; targetDeviceIds?: string[] }) => {
      const res = await apiRequest('POST', '/api/remote/lock-screen', { url, targetDeviceIds });
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Success",
        description: data.message,
      });
      setShowLockScreenDialog(false);
      setLockScreenUrl("");
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    },
  });

  const unlockScreenMutation = useMutation({
    mutationFn: async (targetDeviceIds?: string[]) => {
      const res = await apiRequest('POST', '/api/remote/unlock-screen', { targetDeviceIds });
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Success",
        description: data.message,
      });
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
    },
    onError: (error: Error) => {
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
    
    const targetDeviceIds = selectedDeviceIds.size > 0 ? Array.from(selectedDeviceIds) : undefined;
    openTabMutation.mutate({ url: openTabUrl, targetDeviceIds });
  };

  const handleCloseTabs = () => {
    const targetDeviceIds = selectedDeviceIds.size > 0 ? Array.from(selectedDeviceIds) : undefined;
    
    if (closeTabsMode === "all") {
      closeTabsMutation.mutate({ closeAll: true, targetDeviceIds });
    } else {
      if (!closeTabsPattern.trim()) {
        toast({
          variant: "destructive",
          title: "Invalid Pattern",
          description: "Please enter a URL pattern",
        });
        return;
      }
      closeTabsMutation.mutate({ pattern: closeTabsPattern, targetDeviceIds });
    }
  };

  const handleLockScreen = () => {
    if (!lockScreenUrl.trim()) {
      toast({
        variant: "destructive",
        title: "Invalid URL",
        description: "Please enter a valid URL",
      });
      return;
    }
    
    const targetDeviceIds = selectedDeviceIds.size > 0 ? Array.from(selectedDeviceIds) : undefined;
    lockScreenMutation.mutate({ url: lockScreenUrl, targetDeviceIds });
  };

  const handleUnlockScreen = () => {
    const targetDeviceIds = selectedDeviceIds.size > 0 ? Array.from(selectedDeviceIds) : undefined;
    unlockScreenMutation.mutate(targetDeviceIds);
  };

  // Apply Flight Path mutation
  const applyFlightPathMutation = useMutation({
    mutationFn: async ({ flightPathId, allowedDomains, targetDeviceIds }: { flightPathId: string; allowedDomains: string[]; targetDeviceIds?: string[] }) => {
      const res = await apiRequest('POST', '/api/remote/apply-flight-path', { flightPathId, allowedDomains, targetDeviceIds });
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Success",
        description: data.message,
      });
      setShowApplyFlightPathDialog(false);
      setSelectedFlightPathId("");
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    },
  });

  // Remove Flight Path mutation
  const removeFlightPathMutation = useMutation({
    mutationFn: async (targetDeviceIds: string[]) => {
      const res = await apiRequest('POST', '/api/remote/remove-flight-path', { targetDeviceIds });
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Success",
        description: data.message,
      });
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
    },
    onError: (error: Error) => {
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
    
    const targetDeviceIds = selectedDeviceIds.size > 0 ? Array.from(selectedDeviceIds) : undefined;
    applyFlightPathMutation.mutate({ 
      flightPathId: flightPath.id, 
      allowedDomains: flightPath.allowedDomains || [],
      targetDeviceIds 
    });
  };

  const handleRemoveFlightPath = (deviceId: string) => {
    removeFlightPathMutation.mutate([deviceId]);
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/80 shadow-sm">
        <div className="max-w-screen-2xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-lg">
                <Monitor className="h-7 w-7 text-primary-foreground" />
              </div>
              <div>
                <h1 className="text-2xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">ClassPilot</h1>
                <p className="text-xs text-muted-foreground font-medium">Teacher Dashboard</p>
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
              <Button
                variant="outline"
                size="sm"
                onClick={handleOpenExportDialog}
                data-testid="button-export-excel"
              >
                <Download className="h-4 w-4 mr-2" />
                Export Excel
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLocation("/roster")}
                data-testid="button-roster"
              >
                <UserCog className="h-4 w-4 mr-2" />
                Roster
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowGradeDialog(true)}
                data-testid="button-manage-grades"
              >
                <GraduationCap className="h-4 w-4 mr-2" />
                Manage Grades
              </Button>
              {currentUser?.role === 'admin' && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setLocation("/admin")}
                  data-testid="button-admin"
                >
                  <Shield className="h-5 w-5" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setLocation("/settings")}
                data-testid="button-settings"
              >
                <SettingsIcon className="h-5 w-5" />
              </Button>
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
        {/* Remote Control Toolbar - now inside main */}
        <RemoteControlToolbar 
          selectedDeviceIds={selectedDeviceIds}
          students={filteredStudents}
          onToggleStudent={toggleStudentSelection}
          onClearSelection={clearSelection}
          selectedGrade={selectedGrade}
          onGradeChange={setSelectedGrade}
        />
        
        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6 mb-8">
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
          <div className="p-5 rounded-xl bg-gradient-to-br from-purple-50 to-violet-50 dark:from-purple-950/30 dark:to-violet-950/30 border border-purple-200 dark:border-purple-800/50 shadow-lg hover-elevate transition-all duration-300">
            <div className="flex items-center gap-4">
              <div className="h-14 w-14 rounded-xl bg-purple-500 flex items-center justify-center shadow-md">
                <Video className="h-7 w-7 text-white" />
              </div>
              <div>
                <p className="text-3xl font-bold text-purple-700 dark:text-purple-400" data-testid="text-camera-count">{cameraActiveCount}</p>
                <p className="text-sm text-purple-600 dark:text-purple-500 font-medium">Camera Active</p>
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

        {/* Search Bar + Selection Controls */}
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
              Target: {selectedDeviceIds.size > 0 ? `${selectedDeviceIds.size} selected` : "All students"}
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
                        key={student.deviceId}
                        checked={selectedDeviceIds.has(student.deviceId)}
                        onCheckedChange={() => toggleStudentSelection(student.deviceId)}
                        onSelect={(e) => e.preventDefault()}
                        data-testid={`dropdown-item-student-${student.deviceId}`}
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
              disabled={selectedDeviceIds.size === 0}
              data-testid="button-clear-selection"
            >
              <XSquare className="h-4 w-4 mr-1" />
              Clear Selection
            </Button>
          </div>
        </div>

        {/* Control Buttons */}
        <div className="flex items-center gap-2 flex-wrap mb-8">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowOpenTabDialog(true)}
            data-testid="button-open-tab"
            className="bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/40"
          >
            <MonitorPlay className="h-4 w-4 mr-2" />
            Open Tab
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowCloseTabsDialog(true)}
            data-testid="button-close-tabs"
            className="bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/40"
          >
            <TabletSmartphone className="h-4 w-4 mr-2" />
            Close Tabs
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowLockScreenDialog(true)}
            data-testid="button-lock-screen"
            className="bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/40"
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
            className="bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/40"
          >
            <Unlock className="h-4 w-4 mr-2" />
            Unlock Screen
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowApplyFlightPathDialog(true)}
            data-testid="button-apply-flight-path"
            className="bg-purple-50 dark:bg-purple-950/30 border-purple-200 dark:border-purple-800 text-purple-700 dark:text-purple-400 hover:bg-purple-100 dark:hover:bg-purple-900/40"
          >
            <Layers className="h-4 w-4 mr-2" />
            Apply Flight Path
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowFlightPathViewerDialog(true)}
            data-testid="button-flight-path"
            className="bg-purple-50 dark:bg-purple-950/30 border-purple-200 dark:border-purple-800 text-purple-700 dark:text-purple-400 hover:bg-purple-100 dark:hover:bg-purple-900/40"
          >
            <Route className="h-4 w-4 mr-2" />
            Flight Path
          </Button>
        </div>

        {/* Student Tiles */}
        {filteredStudents.length === 0 ? (
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
        ) : (() => {
          // Partition students into off-task/on-task/idle/offline groups with single pass
          const { offTaskStudents, onTaskStudents, idleStudents, offlineStudents } = filteredStudents.reduce<{
            offTaskStudents: StudentStatus[];
            onTaskStudents: StudentStatus[];
            idleStudents: StudentStatus[];
            offlineStudents: StudentStatus[];
          }>(
            (acc, student) => {
              if (isStudentOffTask(student)) {
                acc.offTaskStudents.push(student);
              } else if (student.status === 'online') {
                acc.onTaskStudents.push(student);
              } else if (student.status === 'idle') {
                acc.idleStudents.push(student);
              } else {
                acc.offlineStudents.push(student);
              }
              return acc;
            },
            { offTaskStudents: [], onTaskStudents: [], idleStudents: [], offlineStudents: [] }
          );
          
          return (
            <div className="space-y-8">
              {/* Off-Task Students Section */}
              {offTaskStudents.length > 0 && (
                <div>
                  <div className="flex items-center gap-3 mb-4">
                    <AlertTriangle className="h-5 w-5 text-red-500" />
                    <h2 
                      className="text-lg font-semibold text-red-600 dark:text-red-400"
                      data-testid="heading-offtask-students"
                    >
                      Off-Task Students ({offTaskStudents.length})
                    </h2>
                    <div className="flex-1 h-px bg-red-200 dark:bg-red-800/30"></div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {offTaskStudents.map((student) => (
                      <StudentTile
                        key={`${student.studentId}-${tileRevisions[student.deviceId] ?? 0}`}
                        student={student}
                        onClick={() => setSelectedStudent(student)}
                        blockedDomains={settings?.blockedDomains || []}
                        isOffTask={true}
                        isSelected={selectedDeviceIds.has(student.deviceId)}
                        onToggleSelect={() => toggleStudentSelection(student.deviceId)}
                        liveStream={liveStreams.get(student.deviceId) || null}
                        onStartLiveView={() => handleStartLiveView(student.deviceId)}
                        onStopLiveView={() => handleStopLiveView(student.deviceId)}
                        onEndLiveRefresh={() => refreshTile(student.deviceId)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* On-Task Students Section */}
              {onTaskStudents.length > 0 && (
                <div>
                  <div className="flex items-center gap-3 mb-4">
                    <Monitor className="h-5 w-5 text-green-500" />
                    <h2 
                      className="text-lg font-semibold text-green-600 dark:text-green-400"
                      data-testid="heading-ontask-students"
                    >
                      On-Task Students ({onTaskStudents.length})
                    </h2>
                    <div className="flex-1 h-px bg-green-200 dark:bg-green-800/30"></div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {onTaskStudents.map((student) => (
                      <StudentTile
                        key={`${student.studentId}-${tileRevisions[student.deviceId] ?? 0}`}
                        student={student}
                        onClick={() => setSelectedStudent(student)}
                        blockedDomains={settings?.blockedDomains || []}
                        isOffTask={false}
                        isSelected={selectedDeviceIds.has(student.deviceId)}
                        onToggleSelect={() => toggleStudentSelection(student.deviceId)}
                        liveStream={liveStreams.get(student.deviceId) || null}
                        onStartLiveView={() => handleStartLiveView(student.deviceId)}
                        onStopLiveView={() => handleStopLiveView(student.deviceId)}
                        onEndLiveRefresh={() => refreshTile(student.deviceId)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Idle Students Section */}
              {idleStudents.length > 0 && (
                <div>
                  <div className="flex items-center gap-3 mb-4">
                    <Activity className="h-5 w-5 text-amber-500" />
                    <h2 
                      className="text-lg font-semibold text-amber-600 dark:text-amber-400"
                      data-testid="heading-idle-students"
                    >
                      Idle Students ({idleStudents.length})
                    </h2>
                    <div className="flex-1 h-px bg-amber-200 dark:bg-amber-800/30"></div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {idleStudents.map((student) => (
                      <StudentTile
                        key={`${student.studentId}-${tileRevisions[student.deviceId] ?? 0}`}
                        student={student}
                        onClick={() => setSelectedStudent(student)}
                        blockedDomains={settings?.blockedDomains || []}
                        isOffTask={false}
                        isSelected={selectedDeviceIds.has(student.deviceId)}
                        onToggleSelect={() => toggleStudentSelection(student.deviceId)}
                        liveStream={liveStreams.get(student.deviceId) || null}
                        onStartLiveView={() => handleStartLiveView(student.deviceId)}
                        onStopLiveView={() => handleStopLiveView(student.deviceId)}
                        onEndLiveRefresh={() => refreshTile(student.deviceId)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Offline Students Section */}
              {offlineStudents.length > 0 && (
                <div>
                  <div className="flex items-center gap-3 mb-4">
                    <Monitor className="h-5 w-5 text-muted-foreground" />
                    <h2 
                      className="text-lg font-semibold text-muted-foreground"
                      data-testid="heading-offline-students"
                    >
                      Offline Students ({offlineStudents.length})
                    </h2>
                    <div className="flex-1 h-px bg-border"></div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {offlineStudents.map((student) => (
                      <StudentTile
                        key={`${student.studentId}-${tileRevisions[student.deviceId] ?? 0}`}
                        student={student}
                        onClick={() => setSelectedStudent(student)}
                        blockedDomains={settings?.blockedDomains || []}
                        isOffTask={false}
                        isSelected={selectedDeviceIds.has(student.deviceId)}
                        onToggleSelect={() => toggleStudentSelection(student.deviceId)}
                        liveStream={liveStreams.get(student.deviceId) || null}
                        onStartLiveView={() => handleStartLiveView(student.deviceId)}
                        onStopLiveView={() => handleStopLiveView(student.deviceId)}
                        onEndLiveRefresh={() => refreshTile(student.deviceId)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })()}
      </main>

      {/* Student Detail Drawer */}
      {selectedStudent && (
        <StudentDetailDrawer
          student={selectedStudent}
          urlHistory={urlHistory}
          onClose={() => setSelectedStudent(null)}
        />
      )}

      {/* Export Dialog */}
      <Dialog open={showExportDialog} onOpenChange={setShowExportDialog}>
        <DialogContent data-testid="dialog-export-excel">
          <DialogHeader>
            <DialogTitle>Export Activity Report</DialogTitle>
            <DialogDescription>
              Select a date range to export student activity data as Excel (.xlsx)
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
              {selectedDeviceIds.size > 0
                ? `Open a URL on ${selectedDeviceIds.size} selected student(s)`
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

      {/* Close Tabs Dialog */}
      <Dialog open={showCloseTabsDialog} onOpenChange={setShowCloseTabsDialog}>
        <DialogContent data-testid="dialog-close-tabs">
          <DialogHeader>
            <DialogTitle>Close Tabs on Student Devices</DialogTitle>
            <DialogDescription>
              {selectedDeviceIds.size > 0
                ? `Close tabs on ${selectedDeviceIds.size} selected student(s)`
                : "Close tabs on all student devices"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <Tabs value={closeTabsMode} onValueChange={(v) => setCloseTabsMode(v as "all" | "pattern")}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="all" data-testid="tab-close-all">Close All Tabs</TabsTrigger>
                <TabsTrigger value="pattern" data-testid="tab-close-pattern">Close by Pattern</TabsTrigger>
              </TabsList>
              <TabsContent value="all" className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  This will close all tabs on the selected student devices.
                </p>
              </TabsContent>
              <TabsContent value="pattern" className="space-y-2">
                <Label htmlFor="close-tabs-pattern">URL Pattern</Label>
                <Input
                  id="close-tabs-pattern"
                  type="text"
                  placeholder="youtube.com"
                  value={closeTabsPattern}
                  onChange={(e) => setCloseTabsPattern(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !closeTabsMutation.isPending) {
                      handleCloseTabs();
                    }
                  }}
                  data-testid="input-close-tabs-pattern"
                />
                <p className="text-xs text-muted-foreground">
                  Enter a domain or URL pattern to match (e.g., "youtube.com" or "social")
                </p>
              </TabsContent>
            </Tabs>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCloseTabsDialog(false)} data-testid="button-cancel-close-tabs">
              Cancel
            </Button>
            <Button onClick={handleCloseTabs} disabled={closeTabsMutation.isPending} data-testid="button-confirm-close-tabs">
              <TabletSmartphone className="h-4 w-4 mr-2" />
              Close Tabs
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Lock Screen Dialog */}
      <Dialog open={showLockScreenDialog} onOpenChange={setShowLockScreenDialog}>
        <DialogContent data-testid="dialog-lock-screen">
          <DialogHeader>
            <DialogTitle>Lock Student Screens</DialogTitle>
            <DialogDescription>
              {selectedDeviceIds.size > 0
                ? `Lock ${selectedDeviceIds.size} selected student(s) to a specific URL`
                : "Lock all students to a specific URL"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="lock-screen-url">URL to Lock To</Label>
              <Input
                id="lock-screen-url"
                type="url"
                placeholder="https://example.com"
                value={lockScreenUrl}
                onChange={(e) => setLockScreenUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !lockScreenMutation.isPending) {
                    handleLockScreen();
                  }
                }}
                data-testid="input-lock-screen-url"
              />
              <p className="text-xs text-muted-foreground">
                Students will be restricted to this URL and cannot navigate away
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowLockScreenDialog(false)} data-testid="button-cancel-lock-screen">
              Cancel
            </Button>
            <Button onClick={handleLockScreen} disabled={lockScreenMutation.isPending} data-testid="button-confirm-lock-screen">
              <Lock className="h-4 w-4 mr-2" />
              Lock Screen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Apply Flight Path Dialog */}
      <Dialog open={showApplyFlightPathDialog} onOpenChange={setShowApplyFlightPathDialog}>
        <DialogContent data-testid="dialog-apply-flight-path">
          <DialogHeader>
            <DialogTitle>Apply Flight Path to Students</DialogTitle>
            <DialogDescription>
              {selectedDeviceIds.size > 0
                ? `Apply a flight path to ${selectedDeviceIds.size} selected student(s)`
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
                {students.map((student) => (
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
                      {student.flightPathActive && student.deviceId ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleRemoveFlightPath(student.deviceId)}
                          disabled={removeFlightPathMutation.isPending}
                          data-testid={`button-remove-flight-path-${student.studentId}`}
                          className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                        >
                          <X className="h-3 w-3 mr-1" />
                          Remove
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
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
    </div>
  );
}
