import { useState, useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { X, ExternalLink, Clock, Monitor, Trash2, Camera, History as HistoryIcon, LayoutGrid, Calendar as CalendarIcon, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
                </div>
                <div className="mt-3">
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => setShowDeleteDialog(true)}
                    disabled={deleteStudentMutation.isPending}
                    data-testid="button-delete-student"
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete Student
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
                      </div>
                    </div>

                    {/* Recent Activity */}
                    <div>
                      <h3 className="text-sm font-medium uppercase tracking-wide text-muted-foreground mb-3">
                        Recent Activity
                      </h3>
                      <div className="space-y-2">
                        {urlSessions.length === 0 ? (
                          <div className="p-8 text-center">
                            <Clock className="h-8 w-8 mx-auto mb-2 text-muted-foreground/50" />
                            <p className="text-sm text-muted-foreground">No activity history yet</p>
                          </div>
                        ) : (
                          urlSessions.slice(0, 20).map((session, index) => (
                            <div
                              key={`${session.url}-${session.startTime.getTime()}-${index}`}
                              className="p-3 rounded-md bg-muted/30 border-l-4 border-primary/20"
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
                    </div>
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
                        }).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

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

                        return (
                          <div className="space-y-1">
                            {filteredHistory.map((event, index) => {
                              const isBlocked = event.flightPathActive && event.activeFlightPathName;
                              
                              return (
                                <div
                                  key={`${event.id}-${index}`}
                                  className="p-3 rounded-md bg-muted/30 border-l-4 hover-elevate cursor-pointer"
                                  style={{
                                    borderLeftColor: isBlocked ? '#ef4444' : '#3b82f6'
                                  }}
                                  onClick={() => setSelectedEvent(event)}
                                  data-testid={`history-event-${index}`}
                                >
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-2 mb-1">
                                        {event.favicon && (
                                          <img
                                            src={event.favicon}
                                            alt=""
                                            className="w-3 h-3 flex-shrink-0"
                                            onError={(e) => {
                                              (e.target as HTMLImageElement).style.display = 'none';
                                            }}
                                          />
                                        )}
                                        <p className="text-sm font-medium truncate">
                                          {event.activeTabTitle}
                                        </p>
                                        {isBlocked && (
                                          <Badge variant="destructive" className="text-xs">
                                            <AlertTriangle className="h-3 w-3 mr-1" />
                                            Off-Task
                                          </Badge>
                                        )}
                                        {event.screenLocked && (
                                          <Badge variant="outline" className="text-xs">
                                            Locked
                                          </Badge>
                                        )}
                                        {event.cameraActive && (
                                          <Badge variant="outline" className="text-xs">
                                            <Camera className="h-3 w-3 mr-1" />
                                            Camera
                                          </Badge>
                                        )}
                                      </div>
                                      <p className="text-xs font-mono text-muted-foreground truncate">
                                        {event.activeTabUrl}
                                      </p>
                                      <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                                        <Clock className="h-3 w-3" />
                                        <span>{format(new Date(event.timestamp), "PPpp")}</span>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                            
                            <div className="pt-2 text-xs text-center text-muted-foreground">
                              Showing {filteredHistory.length} event{filteredHistory.length !== 1 ? 's' : ''}
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
        </div>
      </div>

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
    </div>
  );
}
