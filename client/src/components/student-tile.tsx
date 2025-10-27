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
import { Clock, Monitor, ExternalLink, AlertTriangle, Edit2, Trash2 } from "lucide-react";
import type { StudentStatus, Settings } from "@shared/schema";
import { formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface StudentTileProps {
  student: StudentStatus;
  onClick: () => void;
  blockedDomains?: string[];
  isOffTask?: boolean;
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

export function StudentTile({ student, onClick, blockedDomains = [], isOffTask = false }: StudentTileProps) {
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
        return 'border-2 border-status-online/30';
      case 'idle':
        return 'border-2 border-dashed border-status-away/40';
      case 'offline':
        return 'border border-border/60';
      default:
        return 'border border-border';
    }
  };

  const getOpacity = (status: string) => {
    switch (status) {
      case 'online':
        return 'opacity-100';
      case 'idle':
        return 'opacity-80';
      case 'offline':
        return 'opacity-60';
      default:
        return 'opacity-60';
    }
  };

  return (
    <Card
      data-testid={`card-student-${student.deviceId}`}
      className={`${getBorderStyle(student.status)} ${getOpacity(student.status)} hover-elevate cursor-pointer transition-all duration-200 overflow-visible`}
      onClick={onClick}
    >
      <div className="p-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1">
              <h3 className="font-medium text-base truncate" data-testid={`text-student-name-${student.deviceId}`}>
                {student.studentName || (
                  <span className="text-muted-foreground italic">
                    {student.deviceName || student.deviceId}
                  </span>
                )}
              </h3>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 flex-shrink-0"
                onClick={handleEditClick}
                data-testid={`button-edit-student-${student.deviceId}`}
              >
                <Edit2 className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 flex-shrink-0 text-destructive hover:text-destructive"
                onClick={handleDeleteClick}
                data-testid={`button-delete-student-${student.deviceId}`}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
            {student.deviceName && student.studentName && (
              <p className="text-sm text-foreground/90 truncate flex items-center gap-1.5" data-testid={`text-device-name-${student.deviceId}`}>
                <Monitor className="h-3 w-3 flex-shrink-0" />
                {student.deviceName}
              </p>
            )}
            <p className="text-xs font-mono text-muted-foreground truncate">
              {student.deviceId}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {isOffTask && (
              <Badge className="text-xs px-2 py-0.5 bg-red-500 text-white" data-testid={`badge-offtask-${student.deviceId}`}>
                <AlertTriangle className="h-3 w-3 mr-1" />
                Off-Task
              </Badge>
            )}
            {isBlocked && !isOffTask && (
              <Badge variant="destructive" className="text-xs px-2 py-0.5" data-testid={`badge-blocked-${student.deviceId}`}>
                <AlertTriangle className="h-3 w-3 mr-1" />
                Blocked
              </Badge>
            )}
            {student.isSharing && (
              <Badge className="text-xs px-2 py-0.5 bg-blue-500 text-white animate-pulse">
                Sharing
              </Badge>
            )}
            <div
              className={`h-3 w-3 rounded-full flex-shrink-0 ${getStatusColor(student.status)} ${
                student.status === 'online' ? 'animate-pulse' : ''
              }`}
              title={getStatusLabel(student.status)}
            />
          </div>
        </div>

        {/* Active Tab Info */}
        <div className="space-y-2 mb-3">
          <div className="flex items-start gap-2">
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
            <p className="text-sm flex-1 line-clamp-2" data-testid={`text-tab-title-${student.deviceId}`}>
              {student.activeTabTitle || "No active tab"}
            </p>
          </div>
          {student.activeTabUrl && (
            <div className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground">
              <ExternalLink className="h-3 w-3 flex-shrink-0" />
              <span className="truncate" data-testid={`text-tab-url-${student.deviceId}`}>
                {student.activeTabUrl}
              </span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground pt-3 border-t border-border/50">
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
