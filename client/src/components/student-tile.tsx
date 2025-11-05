import { useState, useEffect, useRef } from "react";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Clock, Monitor, ExternalLink, AlertTriangle, Edit2, Trash2, Lock, Unlock, Video, Layers, Maximize2, MoreVertical } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import type { StudentStatus, Settings } from "@shared/schema";
import { formatDistanceToNow } from "date-fns";
import { formatDuration } from "@shared/utils";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { VideoPortal } from "@/components/video-portal";

interface StudentTileProps {
  student: StudentStatus;
  onClick: () => void;
  blockedDomains?: string[];
  isOffTask?: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
  liveStream?: MediaStream | null;
  onStartLiveView?: () => void;
  onStopLiveView?: () => void;
  onEndLiveRefresh?: () => void;
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

export function StudentTile({ student, onClick, blockedDomains = [], isOffTask = false, isSelected = false, onToggleSelect, liveStream, onStartLiveView, onStopLiveView, onEndLiveRefresh }: StudentTileProps) {
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [newStudentName, setNewStudentName] = useState(student.studentName || '');
  const [newDeviceName, setNewDeviceName] = useState(student.deviceName || '');
  const [newGradeLevel, setNewGradeLevel] = useState(student.gradeLevel || '');
  const [expanded, setExpanded] = useState(false);
  const { toast } = useToast();
  const tileVideoSlotRef = useRef<HTMLDivElement>(null);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  
  // Create video element once and attach stream
  useEffect(() => {
    if (!videoElementRef.current) {
      const video = document.createElement('video');
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.style.width = '100%';
      video.style.height = 'auto';
      video.className = 'rounded-md';
      videoElementRef.current = video;
    }
    
    // Attach stream to video element
    if (videoElementRef.current) {
      videoElementRef.current.srcObject = liveStream || null;
    }
    
    // Mount video into tile slot when stream exists, remove when it doesn't
    if (liveStream && tileVideoSlotRef.current && videoElementRef.current) {
      if (!tileVideoSlotRef.current.contains(videoElementRef.current)) {
        tileVideoSlotRef.current.appendChild(videoElementRef.current);
      }
    } else if (!liveStream && videoElementRef.current) {
      // Close portal if expanded
      if (expanded) {
        setExpanded(false);
      }
      
      // Remove video element from DOM when stream stops (check both locations)
      const portalSlot = document.querySelector('#portal-video-slot');
      if (portalSlot && portalSlot.contains(videoElementRef.current)) {
        portalSlot.removeChild(videoElementRef.current);
      }
      if (tileVideoSlotRef.current && tileVideoSlotRef.current.contains(videoElementRef.current)) {
        tileVideoSlotRef.current.removeChild(videoElementRef.current);
      }
    }
  }, [liveStream, expanded]);
  
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
  
  // Expand video to portal
  const handleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded(true);
    // Move video to portal after next render
    queueMicrotask(() => {
      const portalSlot = document.querySelector('#portal-video-slot');
      if (portalSlot && videoElementRef.current && !portalSlot.contains(videoElementRef.current)) {
        portalSlot.appendChild(videoElementRef.current);
      }
    });
  };
  
  // Collapse video back to tile
  const handleCollapse = () => {
    const tileSlot = tileVideoSlotRef.current;
    if (tileSlot && videoElementRef.current && !tileSlot.contains(videoElementRef.current)) {
      tileSlot.appendChild(videoElementRef.current);
    }
    setExpanded(false);
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
      className={`${isOffTask || isBlocked ? 'border-2 border-red-500 shadow-lg shadow-red-100 dark:shadow-red-950/30' : 'border shadow-md'} ${getOpacity(student.status)} hover-elevate cursor-pointer transition-all duration-200 overflow-hidden`}
      onClick={onClick}
    >
      <div className="p-4 space-y-3">
        {/* Header Zone - Student Name + Status */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {onToggleSelect && (
              <Checkbox
                checked={isSelected}
                onCheckedChange={onToggleSelect}
                onClick={(e) => e.stopPropagation()}
                data-testid={`checkbox-select-student-${student.deviceId}`}
              />
            )}
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-base truncate" data-testid={`text-student-name-${student.deviceId}`}>
                {student.studentName || (
                  <span className="text-muted-foreground italic text-sm">
                    {student.deviceName || student.deviceId}
                  </span>
                )}
              </h3>
              <div className="flex items-center gap-1.5 mt-0.5">
                <div
                  className={`h-2 w-2 rounded-full ${getStatusColor(student.status)} ${
                    student.status === 'online' ? 'animate-pulse' : ''
                  }`}
                  title={getStatusLabel(student.status)}
                />
                <span className="text-xs text-muted-foreground">
                  {getStatusLabel(student.status)}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {student.cameraActive && (
              <div title="Camera active" className="flex-shrink-0">
                <Video 
                  className="h-4 w-4 text-purple-600 dark:text-purple-400" 
                  data-testid={`icon-camera-${student.deviceId}`}
                />
              </div>
            )}
            {student.screenLocked && (
              <div title="Screen locked" className="flex-shrink-0">
                <Lock 
                  className="h-4 w-4 text-amber-600 dark:text-amber-400" 
                  data-testid={`icon-locked-${student.deviceId}`}
                />
              </div>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={(e) => e.stopPropagation()}
                  data-testid={`button-menu-${student.deviceId}`}
                >
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                <DropdownMenuItem onClick={handleEditClick} data-testid={`button-edit-student-${student.deviceId}`}>
                  <Edit2 className="h-4 w-4 mr-2" />
                  Edit Info
                </DropdownMenuItem>
                <DropdownMenuItem 
                  onClick={handleDeleteClick} 
                  className="text-destructive focus:text-destructive"
                  data-testid={`button-delete-student-${student.deviceId}`}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Alert Badges */}
        {(isOffTask || isBlocked || student.flightPathActive) && (
          <div className="flex flex-wrap gap-1.5">
            {student.flightPathActive && student.activeFlightPathName && (
              <Badge variant="outline" className="text-xs px-2 py-0.5 bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-400 dark:border-blue-800" data-testid={`badge-scene-${student.deviceId}`}>
                <Layers className="h-3 w-3 mr-1" />
                {student.activeFlightPathName}
              </Badge>
            )}
            {isOffTask && (
              <Badge variant="outline" className="text-xs px-2 py-0.5 bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400 dark:border-red-800" data-testid={`badge-offtask-${student.deviceId}`}>
                <AlertTriangle className="h-3 w-3 mr-1" />
                Off-Task
              </Badge>
            )}
            {isBlocked && !isOffTask && (
              <Badge variant="outline" className="text-xs px-2 py-0.5 bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400 dark:border-red-800" data-testid={`badge-blocked-${student.deviceId}`}>
                <AlertTriangle className="h-3 w-3 mr-1" />
                Blocked Domain
              </Badge>
            )}
          </div>
        )}

        {/* Preview Zone - Large Live View or Tab Info */}
        {liveStream ? (
          <div className="aspect-video rounded-md overflow-hidden bg-black relative group">
            <div 
              ref={tileVideoSlotRef}
              id={`tile-video-slot-${student.deviceId}`}
              className="w-full h-full"
              data-testid={`video-live-${student.deviceId}`}
            />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors pointer-events-none" />
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-2 right-2 h-8 w-8 bg-black/60 hover:bg-black/80 text-white opacity-90 hover:opacity-100 transition-all shadow-lg pointer-events-auto z-10"
              onClick={handleExpand}
              data-testid={`button-enlarge-${student.deviceId}`}
              title="Expand video - Access zoom, screenshot, and recording controls"
            >
              <Maximize2 className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <div className="aspect-video rounded-md bg-muted/30 border border-border/40 p-4 flex flex-col justify-center gap-2">
            <div className="flex items-start gap-2">
              {student.favicon && (
                <img
                  src={student.favicon}
                  alt=""
                  className="w-4 h-4 flex-shrink-0 mt-1 rounded"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              )}
              <p className="font-medium text-sm leading-tight line-clamp-3" data-testid={`text-tab-title-${student.deviceId}`}>
                {student.activeTabTitle || <span className="text-muted-foreground italic">No active tab</span>}
              </p>
            </div>
            {student.activeTabUrl && (
              <p className="text-xs font-mono text-muted-foreground truncate" data-testid={`text-tab-url-${student.deviceId}`}>
                {student.activeTabUrl}
              </p>
            )}
          </div>
        )}

        {/* Footer Zone - Time Info + Actions */}
        <div className="flex items-center justify-between gap-2 text-xs pt-2 border-t border-border/20">
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <span className="uppercase tracking-wide text-[10px] font-medium">
              {student.currentUrlDuration !== undefined ? 'DURATION' : 'LAST SEEN'}
            </span>
            <span className="text-foreground font-medium" data-testid={student.currentUrlDuration !== undefined ? `current-url-duration-${student.deviceId}` : `text-last-seen-${student.deviceId}`}>
              {student.currentUrlDuration !== undefined ? (
                formatDuration(student.currentUrlDuration)
              ) : (
                formatDistanceToNow(student.lastSeenAt, { addSuffix: true })
              )}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {onStartLiveView && onStopLiveView && (
              <Button
                variant={liveStream ? "default" : "outline"}
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  if (liveStream) {
                    onStopLiveView();
                  } else {
                    onStartLiveView();
                  }
                }}
                title={liveStream ? "Stop live view" : "Start live view"}
                data-testid={`button-live-view-${student.deviceId}`}
              >
                <Monitor className="h-3.5 w-3.5 mr-1" />
                {liveStream ? "Stop" : "View"}
              </Button>
            )}
          </div>
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
      
      {/* Video Portal for enlarged view */}
      {expanded && liveStream && (
        <VideoPortal
          studentName={student.studentName || student.deviceName || student.deviceId}
          onClose={handleCollapse}
        />
      )}
    </Card>
  );
}
