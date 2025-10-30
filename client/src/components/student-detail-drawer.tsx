import { useState, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { X, ExternalLink, Clock, Monitor, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
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
import { formatDistanceToNow, format } from "date-fns";
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

  // Calculate URL sessions with duration from heartbeats
  const urlSessions = useMemo(() => {
    return calculateURLSessions(urlHistory);
  }, [urlHistory]);

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

              {/* URL History with Duration */}
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
