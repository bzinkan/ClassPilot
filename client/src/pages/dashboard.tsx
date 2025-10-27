import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Monitor, Users, Activity, Settings as SettingsIcon, LogOut, Download, Calendar, Shield, AlertTriangle, UserCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { StudentTile } from "@/components/student-tile";
import { StudentDetailDrawer } from "@/components/student-detail-drawer";
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
  const [selectedGrade, setSelectedGrade] = useState<string>("all");
  const [wsConnected, setWsConnected] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportStartDate, setExportStartDate] = useState("");
  const [exportEndDate, setExportEndDate] = useState("");
  const { toast } = useToast();
  const notifiedViolations = useRef<Set<string>>(new Set());

  const { data: students = [], refetch } = useQuery<StudentStatus[]>({
    queryKey: ['/api/students'],
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

  useEffect(() => {
    // WebSocket connection for real-time updates
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log("WebSocket connected");
      setWsConnected(true);
      // Authenticate as teacher
      socket.send(JSON.stringify({ type: 'auth', role: 'teacher' }));
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'student-update') {
          // Refetch students to get latest data
          refetch();
        }
      } catch (error) {
        console.error("WebSocket message error:", error);
      }
    };

    socket.onclose = () => {
      console.log("WebSocket disconnected");
      setWsConnected(false);
    };

    socket.onerror = (error) => {
      console.error("WebSocket error:", error);
      setWsConnected(false);
    };

    return () => {
      socket.close();
    };
  }, [refetch]);

  // Check if student is off-task (not on allowed domains)
  const isStudentOffTask = (student: StudentStatus): boolean => {
    // Only check if allowedDomains is configured and has entries
    if (!settings?.allowedDomains || settings.allowedDomains.length === 0) return false;
    if (!student.activeTabUrl) return false;
    if (student.status !== 'online') return false; // Only check online students
    
    try {
      const hostname = new URL(student.activeTabUrl).hostname.toLowerCase();
      
      // Check if student is on any allowed domain
      const isOnAllowedDomain = settings.allowedDomains.some(allowed => {
        const allowedLower = allowed.toLowerCase().trim();
        return hostname === allowedLower || hostname.endsWith('.' + allowedLower);
      });
      
      return !isOnAllowedDomain; // Off-task if NOT on allowed domain
    } catch {
      return false;
    }
  };

  const filteredStudents = students
    .filter((student) => {
      const matchesSearch = 
        (student.studentName || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        student.deviceId.toLowerCase().includes(searchQuery.toLowerCase()) ||
        student.classId.toLowerCase().includes(searchQuery.toLowerCase());
      
      if (!matchesSearch) return false;
      
      if (selectedGrade === "all") return true;
      
      // Filter by gradeLevel field
      return student.gradeLevel === selectedGrade;
    })
    .sort((a, b) => {
      // Sort off-task students to the top
      const aOffTask = isStudentOffTask(a);
      const bOffTask = isStudentOffTask(b);
      
      if (aOffTask && !bOffTask) return -1;
      if (!aOffTask && bOffTask) return 1;
      return 0; // Keep original order for students with same off-task status
    });

  const onlineCount = students.filter((s) => s.status === 'online').length;
  const idleCount = students.filter((s) => s.status === 'idle').length;
  const sharingCount = students.filter((s) => s.isSharing).length;
  const offTaskCount = students.filter(isStudentOffTask).length;

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

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="max-w-screen-2xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-primary flex items-center justify-center">
                <Monitor className="h-6 w-6 text-primary-foreground" />
              </div>
              <div>
                <h1 className="text-xl font-semibold">ClassPilot</h1>
                <p className="text-xs text-muted-foreground">Teacher Dashboard</p>
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
        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <div className="p-4 rounded-lg bg-card border border-card-border">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-md bg-status-online/10 flex items-center justify-center">
                <Users className="h-5 w-5 text-status-online" />
              </div>
              <div>
                <p className="text-2xl font-semibold" data-testid="text-online-count">{onlineCount}</p>
                <p className="text-sm text-muted-foreground">Online Now</p>
              </div>
            </div>
          </div>
          <div className="p-4 rounded-lg bg-card border border-card-border">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-md bg-status-away/10 flex items-center justify-center">
                <Activity className="h-5 w-5 text-status-away" />
              </div>
              <div>
                <p className="text-2xl font-semibold" data-testid="text-idle-count">{idleCount}</p>
                <p className="text-sm text-muted-foreground">Idle</p>
              </div>
            </div>
          </div>
          <div className="p-4 rounded-lg bg-card border border-card-border">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-md bg-blue-500/10 flex items-center justify-center">
                <Monitor className="h-5 w-5 text-blue-500" />
              </div>
              <div>
                <p className="text-2xl font-semibold" data-testid="text-sharing-count">{sharingCount}</p>
                <p className="text-sm text-muted-foreground">Sharing Screen</p>
              </div>
            </div>
          </div>
          <div className="p-4 rounded-lg bg-card border border-red-500/20">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-md bg-red-500/10 flex items-center justify-center">
                <AlertTriangle className="h-5 w-5 text-red-500" />
              </div>
              <div>
                <p className="text-2xl font-semibold text-red-500" data-testid="text-offtask-count">{offTaskCount}</p>
                <p className="text-sm text-muted-foreground">Off-Task Alert</p>
              </div>
            </div>
          </div>
        </div>

        {/* Search */}
        <div className="mb-6">
          <Input
            placeholder="Search by student name, device ID, or class..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            data-testid="input-search-students"
            className="max-w-md"
          />
        </div>

        {/* Grade Level Tabs */}
        {settings?.gradeLevels && settings.gradeLevels.length > 0 && (
          <Tabs value={selectedGrade} onValueChange={setSelectedGrade} className="mb-6">
            <TabsList className="flex-wrap h-auto">
              <TabsTrigger value="all" data-testid="tab-grade-all">All Grades</TabsTrigger>
              {settings.gradeLevels.map((grade) => (
                <TabsTrigger 
                  key={grade} 
                  value={grade} 
                  data-testid={`tab-grade-${grade}`}
                >
                  {grade}th
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}

        {/* Student Tiles */}
        {filteredStudents.length === 0 ? (
          <div className="py-16 text-center">
            <Monitor className="h-16 w-16 mx-auto mb-4 text-muted-foreground/30" />
            <h3 className="text-lg font-medium mb-2">No students found</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              {searchQuery
                ? "Try adjusting your search query"
                : "No student devices are currently registered. Students will appear here when they connect with the Chrome extension."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filteredStudents.map((student) => (
              <StudentTile
                key={student.deviceId}
                student={student}
                onClick={() => setSelectedStudent(student)}
                blockedDomains={settings?.blockedDomains || []}
                isOffTask={isStudentOffTask(student)}
              />
            ))}
          </div>
        )}
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
    </div>
  );
}
