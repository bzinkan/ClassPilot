import { useState, useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLink, Clock, Monitor, Trash2, Camera, History as HistoryIcon, LayoutGrid, Calendar as CalendarIcon, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { StudentStatus, Heartbeat } from "@shared/schema";
import { formatDistanceToNow, format, startOfDay, endOfDay } from "date-fns";
import { calculateURLSessions, formatDuration } from "@shared/utils";

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
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [historyStartDate, setHistoryStartDate] = useState<Date | undefined>(new Date());
  const [historyEndDate, setHistoryEndDate] = useState<Date | undefined>(new Date());
  const [selectedEvent, setSelectedEvent] = useState<Heartbeat | null>(null);

  // Calculate URL sessions with duration from heartbeats
  const urlSessions = useMemo(() => {
    return calculateURLSessions(urlHistory);
  }, [urlHistory]);

  // Calculate current URL duration by finding the most recent session for the current URL
  const currentUrlDuration = useMemo(() => {
    if (!student || !student.activeTabUrl || urlSessions.length === 0) {
      return null;
    }

    // Find the most recent session (last in array since they're sorted by time)
    const mostRecentSession = urlSessions[urlSessions.length - 1];
    
    // If the most recent session matches the current URL, use its duration
    if (mostRecentSession && mostRecentSession.url === student.activeTabUrl) {
      return mostRecentSession.durationSeconds;
    }

    return null;
  }, [student, urlSessions]);

  const deleteStudentMutation = useMutation({
    mutationFn: async (deviceId: string) => {
      return await apiRequest("DELETE", `/api/students/${deviceId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      toast({
        title: "Student deleted",
        description: "Student has been removed from your roster",
      });
      setShowDeleteDialog(false);
      onClose();
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to delete student",
        description: error.message || "An error occurred",
      });
      setShowDeleteDialog(false);
    },
  });

  const handleDeleteConfirm = () => {
    if (!student) return;
    deleteStudentMutation.mutate(student.deviceId);
  };

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
    <Sheet open={!!student} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-[420px] sm:w-[520px] p-0 flex flex-col">
        <SheetHeader className="px-6 py-4 border-b">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <SheetTitle className="text-xl">
                {student.studentName}
              </SheetTitle>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="uppercase text-xs">
                  {student.classId || "No Class"}
                </Badge>
                <Badge className={`text-xs ${
                  student.status === "offline" ? "bg-status-offline text-white" :
                  student.status === "idle" ? "bg-status-away text-white" :
                  "bg-status-online text-white"
                }`}>
                  {getStatusLabel(student.status)}
                </Badge>
                <span className="text-xs text-muted-foreground font-mono">
                  device-{student.deviceId.slice(0, 8)}
                </span>
              </div>
            </div>
            <Button 
              variant="destructive" 
              size="sm" 
              className="gap-1.5"
              onClick={() => setShowDeleteDialog(true)}
              disabled={deleteStudentMutation.isPending}
              data-testid="button-delete-student"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          </div>
        </SheetHeader>

          {/* Tabs Content */}
          <div className="flex-1 overflow-hidden">
            <Tabs defaultValue="screens" className="flex flex-col h-full">
              <div className="px-6 border-b border-border">
                <TabsList className="w-full justify-start bg-transparent h-auto p-0" data-testid="student-tabs">
                  <TabsTrigger value="screens" className="data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none" data-testid="tab-screens">
                    <Monitor className="h-4 w-4 mr-2" />
                    Screens
                  </TabsTrigger>
                  <TabsTrigger value="timeline" className="data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none" data-testid="tab-timeline">
                    <Clock className="h-4 w-4 mr-2" />
                    Timeline
                  </TabsTrigger>
                  <TabsTrigger value="history" className="data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none" data-testid="tab-history">
                    <HistoryIcon className="h-4 w-4 mr-2" />
                    History
                  </TabsTrigger>
                  <TabsTrigger value="snapshots" className="data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none" data-testid="tab-snapshots">
                    <Camera className="h-4 w-4 mr-2" />
                    Snapshots
                  </TabsTrigger>
                </TabsList>
              </div>
              
              {/* Screens Tab - Current Activity */}
              <TabsContent value="screens" className="flex-1 overflow-hidden m-0">
                <ScrollArea className="h-full">
                  <div className="p-6 space-y-4">
                    {/* Current Activity */}
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-sm font-medium">Current Activity</CardTitle>
                      </CardHeader>
                      <Separator />
                      <CardContent className="pt-4">
                        <div className="p-3 rounded-lg border">
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
                            <a 
                              href={student.activeTabUrl} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-foreground truncate"
                            >
                              <ExternalLink className="h-3 w-3 flex-shrink-0" />
                              <span className="truncate">{student.activeTabUrl}</span>
                            </a>
                          )}
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-2 pt-2 border-t">
                            <Clock className="h-3 w-3" />
                            {currentUrlDuration !== null ? (
                              <span className="font-medium text-primary" data-testid="current-url-duration">
                                {formatDuration(currentUrlDuration)}
                              </span>
                            ) : (
                              <span>
                                {formatDistanceToNow(student.lastSeenAt, { addSuffix: true })}
                              </span>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>

                    {/* Recent Activity */}
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-sm font-medium">Recent Activity</CardTitle>
                      </CardHeader>
                      <Separator />
                      <CardContent className="pt-4">
                        <div className="space-y-2">
                        {urlSessions.length === 0 ? (
                          <div className="p-8 text-center">
                            <Clock className="h-8 w-8 mx-auto mb-2 text-muted-foreground/50" />
                            <p className="text-sm text-muted-foreground">No activity history yet</p>
                          </div>
                        ) : (
                          // Show most recent 20 sessions in chronological order
                          urlSessions.slice(0, 20).map((session, index) => (
                              <div
                                key={`${session.url}-${session.startTime.getTime()}-${index}`}
                                className="p-3 rounded-md bg-muted/30 border-l-4 border-primary/20 hover-elevate"
                                data-testid={`activity-session-${index}`}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1">
                                      {session.favicon && (
                                        <img
                                          src={session.favicon}
                                          alt=""
                                          className="w-3 h-3 flex-shrink-0"
                                          onError={(e) => {
                                            (e.target as HTMLImageElement).style.display = 'none';
                                          }}
                                        />
                                      )}
                                      <p className="text-sm font-medium truncate">
                                        {session.title}
                                      </p>
                                    </div>
                                    <p className="text-xs font-mono text-muted-foreground truncate mb-1">
                                      {session.url}
                                    </p>
                                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                      <Clock className="h-3 w-3" />
                                      <span className="font-medium text-primary" data-testid={`duration-${index}`}>
                                        {formatDuration(session.durationSeconds)}
                                      </span>
                                      <span className="opacity-60">•</span>
                                      <span>
                                        {format(session.startTime, 'HH:mm')} - {format(session.endTime, 'HH:mm')}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            ))
                        )}
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                </ScrollArea>
              </TabsContent>

              {/* Timeline Tab */}
              <TabsContent value="timeline" className="flex-1 overflow-hidden m-0">
                <ScrollArea className="h-full">
                  <div className="p-6">
                    <div className="p-8 text-center text-muted-foreground">
                      <Clock className="h-12 w-12 mx-auto mb-3 opacity-50" />
                      <p className="font-medium">Timeline View</p>
                      <p className="text-sm mt-1">Visual timeline coming soon</p>
                    </div>
                  </div>
                </ScrollArea>
              </TabsContent>

              {/* History Tab */}
              <TabsContent value="history" className="flex-1 overflow-hidden m-0">
                <ScrollArea className="h-full">
                  <div className="p-6 space-y-4">
                    {/* Date Range Filter */}
                    <div className="space-y-2">
                      <h3 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
                        Filter by Date
                      </h3>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button variant="outline" size="sm" className="w-[180px] justify-start text-left font-normal" data-testid="button-history-start-date">
                              <CalendarIcon className="mr-2 h-4 w-4" />
                              {historyStartDate ? format(historyStartDate, "PPP") : "Start date"}
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-auto p-0">
                            <Calendar
                              mode="single"
                              selected={historyStartDate}
                              onSelect={setHistoryStartDate}
                              initialFocus
                            />
                          </PopoverContent>
                        </Popover>
                        <span className="text-sm text-muted-foreground">to</span>
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button variant="outline" size="sm" className="w-[180px] justify-start text-left font-normal" data-testid="button-history-end-date">
                              <CalendarIcon className="mr-2 h-4 w-4" />
                              {historyEndDate ? format(historyEndDate, "PPP") : "End date"}
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-auto p-0">
                            <Calendar
                              mode="single"
                              selected={historyEndDate}
                              onSelect={setHistoryEndDate}
                              initialFocus
                            />
                          </PopoverContent>
                        </Popover>
                        <Button 
                          size="sm" 
                          variant="secondary"
                          onClick={() => {
                            const today = new Date();
                            setHistoryStartDate(today);
                            setHistoryEndDate(today);
                          }}
                          data-testid="button-today"
                        >
                          Today
                        </Button>
                      </div>
                    </div>

                    {/* Activity Timeline */}
                    <div className="space-y-2">
                      <h3 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
                        Activity Timeline
                      </h3>
                      
                      {(() => {
                        // Filter URL history by selected date range
                        const filteredHistory = urlHistory.filter(hb => {
                          const timestamp = new Date(hb.timestamp);
                          const start = historyStartDate ? startOfDay(historyStartDate) : null;
                          const end = historyEndDate ? endOfDay(historyEndDate) : null;
                          
                          if (start && timestamp < start) return false;
                          if (end && timestamp > end) return false;
                          return true;
                        });

                        if (filteredHistory.length === 0) {
                          return (
                            <div className="p-8 text-center border rounded-lg">
                              <HistoryIcon className="h-12 w-12 mx-auto mb-3 text-muted-foreground opacity-50" />
                              <p className="text-sm text-muted-foreground font-medium">No activity found</p>
                              <p className="text-xs text-muted-foreground mt-1">
                                Try selecting a different date range
                              </p>
                            </div>
                          );
                        }

                        // Group filtered history into sessions
                        const historySessions = calculateURLSessions(filteredHistory);
                        
                        // Sort sessions by start time (most recent first)
                        const sortedSessions = [...historySessions].sort((a, b) => 
                          b.startTime.getTime() - a.startTime.getTime()
                        );

                        // For each session, find if any heartbeat had off-task/locked/camera indicators
                        const sessionsWithIndicators = sortedSessions.map(session => {
                          const sessionHeartbeats = filteredHistory.filter(hb => 
                            hb.activeTabUrl === session.url &&
                            new Date(hb.timestamp) >= session.startTime &&
                            new Date(hb.timestamp) <= session.endTime
                          );
                          
                          const hasOffTask = sessionHeartbeats.some(hb => hb.flightPathActive && hb.activeFlightPathName);
                          const hasLocked = sessionHeartbeats.some(hb => hb.screenLocked);
                          const hasCamera = sessionHeartbeats.some(hb => hb.cameraActive);
                          
                          return {
                            ...session,
                            hasOffTask,
                            hasLocked,
                            hasCamera,
                          };
                        });

                        return (
                          <div className="space-y-1">
                            {sessionsWithIndicators.map((session, index) => (
                              <div
                                key={`${session.url}-${session.startTime.getTime()}-${index}`}
                                className="p-3 rounded-md bg-muted/30 border-l-4 hover-elevate"
                                style={{
                                  borderLeftColor: session.hasOffTask ? '#ef4444' : '#3b82f6'
                                }}
                                data-testid={`history-session-${index}`}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1">
                                      {session.favicon && (
                                        <img
                                          src={session.favicon}
                                          alt=""
                                          className="w-3 h-3 flex-shrink-0"
                                          onError={(e) => {
                                            (e.target as HTMLImageElement).style.display = 'none';
                                          }}
                                        />
                                      )}
                                      <p className="text-sm font-medium truncate">
                                        {session.title}
                                      </p>
                                      {session.hasOffTask && (
                                        <Badge variant="destructive" className="text-xs">
                                          <AlertTriangle className="h-3 w-3 mr-1" />
                                          Off-Task
                                        </Badge>
                                      )}
                                      {session.hasLocked && (
                                        <Badge variant="outline" className="text-xs">
                                          Locked
                                        </Badge>
                                      )}
                                      {session.hasCamera && (
                                        <Badge variant="outline" className="text-xs">
                                          <Camera className="h-3 w-3 mr-1" />
                                          Camera
                                        </Badge>
                                      )}
                                    </div>
                                    <p className="text-xs font-mono text-muted-foreground truncate mb-1">
                                      {session.url}
                                    </p>
                                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                      <Clock className="h-3 w-3" />
                                      <span className="font-medium text-primary">
                                        {formatDuration(session.durationSeconds)}
                                      </span>
                                      <span className="opacity-60">•</span>
                                      <span>
                                        {format(session.startTime, 'MMM d, h:mm a')} - {format(session.endTime, 'h:mm a')}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            ))}
                            
                            <div className="pt-2 text-xs text-center text-muted-foreground">
                              Showing {sessionsWithIndicators.length} session{sessionsWithIndicators.length !== 1 ? 's' : ''}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </ScrollArea>
              </TabsContent>

              {/* Snapshots Tab */}
              <TabsContent value="snapshots" className="flex-1 overflow-hidden m-0">
                <ScrollArea className="h-full">
                  <div className="p-6">
                    <div className="p-8 text-center text-muted-foreground">
                      <Camera className="h-12 w-12 mx-auto mb-3 opacity-50" />
                      <p className="font-medium">Screenshot Snapshots</p>
                      <p className="text-sm mt-1">Captured screenshots coming soon</p>
                    </div>
                  </div>
                </ScrollArea>
              </TabsContent>
            </Tabs>
          </div>
        </SheetContent>

        {/* Delete Confirmation Dialog */}
        <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Student</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete "{student?.studentName}" ({student?.deviceId})? This will permanently remove the student and all associated activity data from your roster. This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleteStudentMutation.isPending}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDeleteConfirm}
                disabled={deleteStudentMutation.isPending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                data-testid="button-confirm-delete"
              >
                {deleteStudentMutation.isPending ? "Deleting..." : "Delete Student"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
    </Sheet>
  );
}
