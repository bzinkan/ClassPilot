import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Monitor, Users, Activity, Settings as SettingsIcon, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { StudentTile } from "@/components/student-tile";
import { StudentDetailDrawer } from "@/components/student-detail-drawer";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import type { StudentStatus, Heartbeat, Settings } from "@shared/schema";

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const [selectedStudent, setSelectedStudent] = useState<StudentStatus | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [wsConnected, setWsConnected] = useState(false);
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

  const filteredStudents = students.filter((student) =>
    student.studentName.toLowerCase().includes(searchQuery.toLowerCase()) ||
    student.deviceId.toLowerCase().includes(searchQuery.toLowerCase()) ||
    student.classId.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const onlineCount = students.filter((s) => s.status === 'online').length;
  const idleCount = students.filter((s) => s.status === 'idle').length;
  const sharingCount = students.filter((s) => s.isSharing).length;

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
      const isBlocked = settings.blockedDomains.some(blocked => {
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
                <h1 className="text-xl font-semibold">Classroom Screen Awareness</h1>
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
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
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
              <div className="h-10 w-10 rounded-md bg-destructive/10 flex items-center justify-center">
                <Monitor className="h-5 w-5 text-destructive" />
              </div>
              <div>
                <p className="text-2xl font-semibold" data-testid="text-sharing-count">{sharingCount}</p>
                <p className="text-sm text-muted-foreground">Sharing Screen</p>
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
    </div>
  );
}
