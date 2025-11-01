import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Clock, Monitor, ExternalLink, AlertTriangle, Edit2, Trash2, Lock, Unlock, Video, Layers } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import type { StudentStatus, Settings } from "@shared/schema";
import { formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface StudentTileProps {
  student: StudentStatus;
  onClick: () => void;
  blockedDomains?: string[];
  isOffTask?: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
}

function isBlockedDomain(url: string | null, blockedDomains: string[]): boolean {
  if (!url || blockedDomains.length === 0) return false;
  
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    
    return blockedDomains.some(blocked => {
      const blockedLower = blocked.toLowerCase().trim();
      
      // Flexible domain matching: check if the blocked domain appears in the hostname
      // This allows ixl.com to match: ixl.com, www.ixl.com, signin.ixl.com, etc.
      return (
        hostname === blockedLower ||                        // Exact match
        hostname.endsWith('.' + blockedLower) ||            // Subdomain
        hostname.includes('.' + blockedLower + '.') ||      // Middle segment
        hostname.startsWith(blockedLower + '.') ||          // Starts with
        hostname.includes(blockedLower)                     // Contains anywhere (most flexible)
      );
    });
  } catch {
    return false;
  }
}

export function StudentTile({ student, onClick, blockedDomains = [], isOffTask = false, isSelected = false, onToggleSelect }: StudentTileProps) {
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [newStudentName, setNewStudentName] = useState(student.studentName || '');
  const [newDeviceName, setNewDeviceName] = useState(student.deviceName || '');
  const [newGradeLevel, setNewGradeLevel] = useState(student.gradeLevel || '');
  const { toast } = useToast();
  
  const { data: settings } = useQuery<Settings>({
    queryKey: ['/api/settings'],
  });
  
  const updateStudentMutation = useMutation({
    mutationFn: async (data: { studentId: string; studentName: string; gradeLevel: string }) => {
      return await apiRequest("PATCH", `/api/students/${data.studentId}`, { 
        studentName: data.studentName,
        gradeLevel: data.gradeLevel || null
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      toast({
        title: "Student information updated",
        description: `Successfully updated student information`,
      });
      setEditDialogOpen(false);
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to update student",
        description: error.message || "An error occurred",
      });
    },
  });

  const updateDeviceMutation = useMutation({
    mutationFn: async (data: { deviceId: string; deviceName: string }) => {
      return await apiRequest("PATCH", `/api/devices/${data.deviceId}`, { 
        deviceName: data.deviceName || null
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      toast({
        title: "Device information updated",
        description: `Successfully updated device information`,
      });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to update device",
        description: error.message || "An error occurred",
      });
    },
  });

  const deleteStudentMutation = useMutation({
    mutationFn: async (studentId: string) => {
      return await apiRequest("DELETE", `/api/students/${studentId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/roster/students'] });
      toast({
        title: "Student assignment deleted",
        description: `Successfully removed ${student.studentName} from the dashboard`,
      });
      setDeleteDialogOpen(false);
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to delete student",
        description: error.message || "An error occurred",
      });
    },
  });

  const handleEditClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setNewStudentName(student.studentName || '');
    setNewDeviceName(student.deviceName || '');
    setNewGradeLevel(student.gradeLevel || '');
    setEditDialogOpen(true);
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteDialogOpen(true);
  };

  const handleConfirmDelete = () => {
    deleteStudentMutation.mutate(student.studentId);
  };

  const handleSaveStudent = () => {
    // Update student name and grade
    if (newStudentName.trim() !== (student.studentName || '') || 
        (newGradeLevel === 'none' ? '' : newGradeLevel) !== (student.gradeLevel || '')) {
      updateStudentMutation.mutate({ 
        studentId: student.studentId, 
        studentName: newStudentName.trim() || '',
        gradeLevel: newGradeLevel === 'none' ? '' : newGradeLevel
      });
    }
    
    // Update device name if changed
    if (newDeviceName !== (student.deviceName || '')) {
      updateDeviceMutation.mutate({
        deviceId: student.deviceId,
        deviceName: newDeviceName
      });
    }
  };
  
  const isBlocked = isBlockedDomain(student.activeTabUrl, blockedDomains);
  
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

  const getBorderStyle = (status: string) => {
    if (isOffTask) {
      return 'border-2 border-red-500';
    }
    
    if (isBlocked) {
      return 'border-2 border-destructive';
    }
    
    switch (status) {
      case 'online':
        return 'border-2 border-green-500/30';
      case 'idle':
        return 'border-2 border-amber-500/30';
      case 'offline':
        return 'border border-border/40';
      default:
        return 'border border-border';
    }
  };

  const getShadowStyle = (status: string) => {
    if (isOffTask) {
      return 'shadow-lg shadow-red-100 dark:shadow-red-950/30';
    }
    
    if (isBlocked) {
      return 'shadow-lg shadow-destructive/10';
    }
    
    switch (status) {
      case 'online':
        return 'shadow-lg shadow-green-100 dark:shadow-green-950/30';
      case 'idle':
        return 'shadow-lg shadow-amber-100 dark:shadow-amber-950/30';
      case 'offline':
        return 'shadow-md';
      default:
        return 'shadow-md';
    }
  };

  const getOpacity = (status: string) => {
    switch (status) {
      case 'online':
        return 'opacity-100';
      case 'idle':
        return 'opacity-95';
      case 'offline':
        return 'opacity-75';
      default:
        return 'opacity-75';
    }
  };

  const getGradientBackground = (status: string) => {
    if (isOffTask) {
      return 'bg-gradient-to-br from-red-50/50 via-red-50/20 to-transparent dark:from-red-950/20 dark:via-red-950/10 dark:to-transparent';
    }
    
    if (isBlocked) {
      return 'bg-gradient-to-br from-destructive/10 via-destructive/5 to-transparent dark:from-destructive/5 dark:via-destructive/3 dark:to-transparent';
    }
    
    switch (status) {
      case 'online':
        return 'bg-gradient-to-br from-green-50/50 via-green-50/20 to-transparent dark:from-green-950/20 dark:via-green-950/10 dark:to-transparent';
      case 'idle':
        return 'bg-gradient-to-br from-amber-50/50 via-amber-50/20 to-transparent dark:from-amber-950/20 dark:via-amber-950/10 dark:to-transparent';
      case 'offline':
        return 'bg-card';
      default:
        return 'bg-card';
    }
  };

  return (
    <Card
      data-testid={`card-student-${student.deviceId}`}
      className={`${getBorderStyle(student.status)} ${getShadowStyle(student.status)} ${getOpacity(student.status)} ${getGradientBackground(student.status)} hover-elevate cursor-pointer transition-all duration-300 overflow-visible hover:shadow-xl`}
      onClick={onClick}
    >
      <div className="p-3.5">
        {/* Header */}
        <div className="flex items-start justify-between gap-2 mb-2.5">
          <div className="flex items-center gap-1 flex-1 min-w-0">
            {onToggleSelect && (
              <Checkbox
                checked={isSelected}
                onCheckedChange={onToggleSelect}
                onClick={(e) => e.stopPropagation()}
                className="mr-1"
                data-testid={`checkbox-select-student-${student.deviceId}`}
              />
            )}
            <h3 className="font-semibold text-sm truncate" data-testid={`text-student-name-${student.deviceId}`}>
              {student.studentName || (
                <span className="text-muted-foreground italic">
                  {student.deviceName || student.deviceId}
                </span>
              )}
            </h3>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 flex-shrink-0"
              onClick={handleEditClick}
              data-testid={`button-edit-student-${student.deviceId}`}
            >
              <Edit2 className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 flex-shrink-0 text-destructive hover:text-destructive"
              onClick={handleDeleteClick}
              data-testid={`button-delete-student-${student.deviceId}`}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {isOffTask && (
              <Badge className="text-xs px-1.5 py-0.5 bg-red-500 text-white" data-testid={`badge-offtask-${student.deviceId}`}>
                <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />
                Off-Task
              </Badge>
            )}
            {isBlocked && !isOffTask && (
              <Badge variant="destructive" className="text-xs px-1.5 py-0.5" data-testid={`badge-blocked-${student.deviceId}`}>
                <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />
                Blocked
              </Badge>
            )}
            {student.status === 'offline' && (
              <Badge variant="outline" className="text-xs px-1.5 py-0.5 bg-muted text-muted-foreground">
                Offline
              </Badge>
            )}
            {student.cameraActive && (
              <div title="Camera active">
                <Video 
                  className="h-3.5 w-3.5 flex-shrink-0 text-purple-600 dark:text-purple-400" 
                  data-testid={`icon-camera-${student.deviceId}`}
                />
              </div>
            )}
            {student.sceneActive ? (
              <div title="Scene active">
                <Layers 
                  className="h-3.5 w-3.5 flex-shrink-0 text-blue-600 dark:text-blue-400" 
                  data-testid={`icon-scene-active-${student.deviceId}`}
                />
              </div>
            ) : student.screenLocked ? (
              <div title="Screen locked">
                <Lock 
                  className="h-3.5 w-3.5 flex-shrink-0 text-amber-600 dark:text-amber-400" 
                  data-testid={`icon-locked-${student.deviceId}`}
                />
              </div>
            ) : (
              <div title="Screen unlocked">
                <Unlock 
                  className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/40" 
                  data-testid={`icon-unlocked-${student.deviceId}`}
                />
              </div>
            )}
            <div
              className={`h-2.5 w-2.5 rounded-full flex-shrink-0 ${getStatusColor(student.status)} ${
                student.status === 'online' ? 'animate-pulse' : ''
              }`}
              title={getStatusLabel(student.status)}
            />
          </div>
        </div>

        {/* Active Tab Info */}
        <div className="space-y-2 mb-2.5">
          <div className="flex items-start gap-2">
            {student.favicon && (
              <img
                src={student.favicon}
                alt=""
                className="w-4 h-4 flex-shrink-0 mt-0.5 rounded"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            )}
            <p className="text-sm font-medium flex-1 line-clamp-2 leading-snug" data-testid={`text-tab-title-${student.deviceId}`}>
              {student.activeTabTitle || <span className="text-muted-foreground italic">No active tab</span>}
            </p>
          </div>
          {student.activeTabUrl && (
            <div className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground bg-muted/20 rounded px-2 py-1">
              <ExternalLink className="h-2.5 w-2.5 flex-shrink-0" />
              <span className="truncate" data-testid={`text-tab-url-${student.deviceId}`}>
                {student.activeTabUrl}
              </span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground pt-2 border-t border-border/20">
          <Clock className="h-3 w-3" />
          <span data-testid={`text-last-seen-${student.deviceId}`}>
            {formatDistanceToNow(student.lastSeenAt, { addSuffix: true })}
          </span>
        </div>
      </div>

      {/* Edit Student Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent onClick={(e) => e.stopPropagation()} data-testid={`dialog-edit-student-${student.deviceId}`}>
          <DialogHeader>
            <DialogTitle>Edit Student Information</DialogTitle>
            <DialogDescription>
              Update student name and device name for this Chromebook
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="device-id">Device ID (Read-only)</Label>
              <Input
                id="device-id"
                value={student.deviceId}
                disabled
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="device-name">Device Name (Optional)</Label>
              <Input
                id="device-name"
                data-testid={`input-edit-device-name-${student.deviceId}`}
                value={newDeviceName}
                onChange={(e) => setNewDeviceName(e.target.value)}
                placeholder="e.g., 6th chromebook 1"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleSaveStudent();
                  }
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="student-name">Student Name</Label>
              <Input
                id="student-name"
                data-testid={`input-edit-student-name-${student.deviceId}`}
                value={newStudentName}
                onChange={(e) => setNewStudentName(e.target.value)}
                placeholder="e.g., Lucy Garcia"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleSaveStudent();
                  }
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="grade-level">Grade Level (Optional)</Label>
              <Select
                value={newGradeLevel || undefined}
                onValueChange={(value) => setNewGradeLevel(value || '')}
              >
                <SelectTrigger id="grade-level" data-testid={`select-edit-grade-level-${student.deviceId}`}>
                  <SelectValue placeholder="Select grade level" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {settings?.gradeLevels && settings.gradeLevels.length > 0 ? (
                    settings.gradeLevels.map((grade) => (
                      <SelectItem key={grade} value={grade}>
                        Grade {grade}
                      </SelectItem>
                    ))
                  ) : (
                    <SelectItem value="loading" disabled>
                      Loading grades...
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditDialogOpen(false)}
              data-testid="button-cancel-edit-student"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSaveStudent}
              disabled={updateStudentMutation.isPending}
              data-testid="button-save-student-name"
            >
              {updateStudentMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent onClick={(e) => e.stopPropagation()} data-testid={`dialog-delete-student-${student.deviceId}`}>
          <DialogHeader>
            <DialogTitle>Delete Student Device</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove {student.studentName || student.deviceName || student.deviceId} from the dashboard? This will delete the device from your roster.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
              data-testid="button-cancel-delete-student"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmDelete}
              disabled={deleteStudentMutation.isPending}
              data-testid="button-confirm-delete-student"
            >
              {deleteStudentMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
