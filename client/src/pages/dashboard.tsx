import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Monitor, Users, Activity, Settings as SettingsIcon, LogOut, Download, Calendar, Shield, AlertTriangle, UserCog, Plus, X, GraduationCap } from "lucide-react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { StudentStatus, Heartbeat, Settings } from "@shared/schema";

interface CurrentUser {
  id: string;
  username: string;
  role: string;
  schoolName: string;
}

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const [selectedStudent, setSelectedStudent] = useState<StudentStatus | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedGrade, setSelectedGrade] = useState<string>("");
  const [wsConnected, setWsConnected] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportStartDate, setExportStartDate] = useState("");
  const [exportEndDate, setExportEndDate] = useState("");
  const [showGradeDialog, setShowGradeDialog] = useState(false);
  const [newGrade, setNewGrade] = useState("");
  const { toast } = useToast();
  const notifiedViolations = useRef<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const isMountedRef = useRef(true); // Track if component is mounted
  const maxReconnectDelay = 30000; // 30 seconds max delay

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
    };
  }, []); // Empty deps - WebSocket connection should only be created once

  // Set initial grade when settings load
  useEffect(() => {
    if (settings?.gradeLevels && settings.gradeLevels.length > 0 && !selectedGrade) {
      setSelectedGrade(settings.gradeLevels[0]);
    }
  }, [settings, selectedGrade]);

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
  const sharingCount = studentsInGrade.filter((s) => s.isSharing).length;
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

      {/* Remote Control Toolbar */}
      <RemoteControlToolbar />

      {/* Main Content */}
      <main className="max-w-screen-2xl mx-auto px-6 py-8">
        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
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
          <div className="p-5 rounded-xl bg-gradient-to-br from-blue-50 to-cyan-50 dark:from-blue-950/30 dark:to-cyan-950/30 border border-blue-200 dark:border-blue-800/50 shadow-lg hover-elevate transition-all duration-300">
            <div className="flex items-center gap-4">
              <div className="h-14 w-14 rounded-xl bg-blue-500 flex items-center justify-center shadow-md">
                <Monitor className="h-7 w-7 text-white" />
              </div>
              <div>
                <p className="text-3xl font-bold text-blue-700 dark:text-blue-400" data-testid="text-sharing-count">{sharingCount}</p>
                <p className="text-sm text-blue-600 dark:text-blue-500 font-medium">Sharing Screen</p>
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

        {/* Extension Setup Banner - Show when all students are offline */}
        {students.length > 0 && onlineCount === 0 && (
          <div className="mb-8 p-6 bg-amber-50 dark:bg-amber-950/30 border-l-4 border-amber-500 rounded-lg shadow-md">
            <div className="flex items-start gap-4">
              <div className="h-10 w-10 rounded-lg bg-amber-500 flex items-center justify-center flex-shrink-0">
                <AlertTriangle className="h-5 w-5 text-white" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-amber-900 dark:text-amber-100 mb-1">
                  No Students Connected
                </h3>
                <p className="text-sm text-amber-800 dark:text-amber-200 mb-3">
                  All student devices are showing as offline. This usually means the Chrome Extension needs to be configured with your development server URL.
                </p>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => setLocation('/extension-setup')}
                  data-testid="button-setup-extension"
                  className="bg-amber-600 hover:bg-amber-700 text-white"
                >
                  Configure Extension
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Search */}
        <div className="mb-8">
          <Input
            placeholder="🔍 Search by student name, device ID, or class..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            data-testid="input-search-students"
            className="max-w-md h-12 text-base shadow-sm"
          />
        </div>

        {/* Grade Level Tabs */}
        {settings?.gradeLevels && settings.gradeLevels.length > 0 && (
          <Tabs value={selectedGrade} onValueChange={setSelectedGrade} className="mb-8">
            <TabsList className="flex-wrap h-auto gap-2 p-1.5 bg-muted/50 rounded-xl">
              {settings.gradeLevels.map((grade) => (
                <TabsTrigger 
                  key={grade} 
                  value={grade} 
                  data-testid={`tab-grade-${grade}`}
                  className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-lg px-5 py-2.5 font-medium transition-all duration-200 data-[state=active]:shadow-md"
                >
                  {grade}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}

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
                        key={student.studentId}
                        student={student}
                        onClick={() => setSelectedStudent(student)}
                        blockedDomains={settings?.blockedDomains || []}
                        isOffTask={true}
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
                        key={student.studentId}
                        student={student}
                        onClick={() => setSelectedStudent(student)}
                        blockedDomains={settings?.blockedDomains || []}
                        isOffTask={false}
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
                        key={student.studentId}
                        student={student}
                        onClick={() => setSelectedStudent(student)}
                        blockedDomains={settings?.blockedDomains || []}
                        isOffTask={false}
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
                        key={student.studentId}
                        student={student}
                        onClick={() => setSelectedStudent(student)}
                        blockedDomains={settings?.blockedDomains || []}
                        isOffTask={false}
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
    </div>
  );
}
