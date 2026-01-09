import { useState, useEffect, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Clock, Monitor, ExternalLink, AlertTriangle, Lock, Unlock, Video, Layers, Maximize2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import type { StudentStatus, AggregatedStudentStatus, Settings } from "@shared/schema";
import { formatDistanceToNow } from "date-fns";
import { formatDuration } from "@shared/utils";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { VideoPortal } from "@/components/video-portal";

interface StudentTileProps {
  student: AggregatedStudentStatus;
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
  
  // Fetch recent browsing history for mini history icons
  const { data: recentHeartbeats = [] } = useQuery<any[]>({
    queryKey: ['/api/heartbeats', student.primaryDeviceId],
    refetchInterval: 30000, // Refresh every 30 seconds
  });
  
  // Fetch flight paths to check if current URL is blocked
  const { data: flightPaths = [] } = useQuery<any[]>({
    queryKey: ['/api/flight-paths'],
  });

  // Fetch screenshot thumbnail for this device (refreshes every 10 seconds)
  const { data: screenshotData } = useQuery<{ screenshot: string; timestamp: number }>({
    queryKey: ['/api/device/screenshot', student.primaryDeviceId],
    enabled: !!student.primaryDeviceId && student.status !== 'offline' && !liveStream,
    refetchInterval: 10000, // Refresh every 10 seconds
    retry: false, // Don't retry on 404 (no screenshot available)
    staleTime: 8000, // Consider data stale after 8 seconds
  });
  
  // Get unique recent domains (last 5)
  const recentDomains = recentHeartbeats
    .slice(0, 10)
    .reduce((acc: Array<{url: string, favicon?: string, title: string}>, hb) => {
      try {
        const urlObj = new URL(hb.activeTabUrl);
        const domain = urlObj.hostname;
        
        // Only add if we don't already have this domain
        if (!acc.some(item => new URL(item.url).hostname === domain)) {
          acc.push({
            url: hb.activeTabUrl,
            favicon: hb.favicon,
            title: hb.activeTabTitle
          });
        }
      } catch {}
      return acc;
    }, [])
    .slice(0, 5);
  
  // Check if current URL is blocked by active flight path
  const activeFlightPath = flightPaths.find((fp: any) => fp.flightPathName === student.activeFlightPathName);
  const isBlockedByFlightPath = student.flightPathActive && activeFlightPath && student.activeTabUrl && 
    isBlockedDomain(student.activeTabUrl, activeFlightPath.blockedDomains || []);
  
  // Expand video to portal
  const handleExpand = (e?: React.MouseEvent) => {
    e?.stopPropagation();
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
  
  // Unblock mutation for flight path
  const unblockForClassMutation = useMutation({
    mutationFn: async () => {
      if (!student.primaryDeviceId) {
        throw new Error("Student does not have a primary device assigned.");
      }
      return await apiRequest("POST", "/api/remote/unlock-screen", {
        targetDeviceIds: [student.primaryDeviceId]
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      toast({
        title: "Unblocked for class",
        description: `${student.studentName} can now access this website`,
      });
    },
  });
  
  // Lock to current screen mutation
  const lockToCurrentScreenMutation = useMutation({
    mutationFn: async () => {
      if (!student.activeTabUrl) {
        throw new Error("No active tab to lock to");
      }
      if (!student.primaryDeviceId) {
        throw new Error("Student does not have a primary device assigned.");
      }
      return await apiRequest("POST", "/api/remote/lock-screen", {
        url: student.activeTabUrl,
        targetDeviceIds: [student.primaryDeviceId]
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      toast({
        title: "Screen locked",
        description: `${student.studentName} is now locked to their current screen`,
      });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to lock screen",
        description: error.message || "An error occurred",
      });
    },
  });
  
  // Unlock screen mutation
  const unlockScreenMutation = useMutation({
    mutationFn: async () => {
      if (!student.primaryDeviceId) {
        throw new Error("Student does not have a primary device assigned.");
      }
      return await apiRequest("POST", "/api/remote/unlock-screen", {
        targetDeviceIds: [student.primaryDeviceId]
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      toast({
        title: "Screen unlocked",
        description: `${student.studentName} can now browse freely`,
      });
    },
  });
  
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
      data-testid={`card-student-${student.primaryDeviceId}`}
      className={`${getBorderStyle(student.status)} ${getShadowStyle(student.status)} ${getOpacity(student.status)} hover-elevate cursor-pointer transition-all duration-200 overflow-hidden`}
      onClick={onClick}
    >
      <div className="p-4 space-y-3">
        {/* Header Zone - Avatar + Student Name + Status */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            {onToggleSelect && (
              <Checkbox
                checked={isSelected}
                onCheckedChange={onToggleSelect}
                onClick={(e) => e.stopPropagation()}
                data-testid={`checkbox-select-student-${student.primaryDeviceId}`}
              />
            )}
            {/* Avatar with status indicator */}
            <div className="relative flex-shrink-0">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold ${
                student.status === 'online'
                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                  : student.status === 'idle'
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                  : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
              }`}>
                {student.studentName
                  ? student.studentName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
                  : '?'}
              </div>
              <div
                className={`absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-white dark:border-gray-900 ${getStatusColor(student.status)} ${
                  student.status === 'online' ? 'animate-pulse' : ''
                }`}
                title={getStatusLabel(student.status)}
              />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-sm" data-testid={`text-student-name-${student.primaryDeviceId}`}>
                {student.studentName || (
                  <span className="text-muted-foreground italic">
                    {student.deviceName || 'Unknown'}
                  </span>
                )}
              </h3>
              <span className={`text-xs font-medium ${
                student.status === 'online'
                  ? 'text-green-600 dark:text-green-400'
                  : student.status === 'idle'
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-muted-foreground'
              }`}>
                {getStatusLabel(student.status)}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={(e) => {
                e.stopPropagation();
                if (student.screenLocked) {
                  unlockScreenMutation.mutate();
                } else {
                  lockToCurrentScreenMutation.mutate();
                }
              }}
              title={student.screenLocked ? "Unlock screen" : "Lock to current screen"}
              data-testid={`button-lock-toggle-${student.primaryDeviceId}`}
            >
              {student.screenLocked ? (
                <Lock className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              ) : (
                <Unlock className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        {/* Alert Badges */}
        {(isOffTask || isBlocked || isBlockedByFlightPath || student.flightPathActive) && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1.5">
              {student.flightPathActive && student.activeFlightPathName && !isBlockedByFlightPath && (
                <Badge variant="outline" className="text-xs px-2 py-0.5 bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-400 dark:border-blue-800" data-testid={`badge-scene-${student.primaryDeviceId}`}>
                  <Layers className="h-3 w-3 mr-1" />
                  {student.activeFlightPathName}
                </Badge>
              )}
              {isBlockedByFlightPath && (
                <Badge variant="outline" className="text-xs px-2 py-0.5 bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400 dark:border-red-800" data-testid={`badge-blocked-by-scene-${student.primaryDeviceId}`}>
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  Blocked by {student.activeFlightPathName}
                </Badge>
              )}
              {isOffTask && !isBlockedByFlightPath && (
                <Badge variant="outline" className="text-xs px-2 py-0.5 bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400 dark:border-red-800" data-testid={`badge-offtask-${student.primaryDeviceId}`}>
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  Off-Task
                </Badge>
              )}
              {isBlocked && !isOffTask && !isBlockedByFlightPath && (
                <Badge variant="outline" className="text-xs px-2 py-0.5 bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400 dark:border-red-800" data-testid={`badge-blocked-${student.primaryDeviceId}`}>
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  Blocked Domain
                </Badge>
              )}
            </div>
            {isBlockedByFlightPath && (
              <div className="flex gap-2">
                <p className="text-xs text-muted-foreground truncate flex-1">
                  {student.activeTabUrl}
                </p>
                <Button
                  size="sm"
                  variant="default"
                  className="h-7 px-3 text-xs bg-blue-600 hover:bg-blue-700 text-white"
                  onClick={(e) => {
                    e.stopPropagation();
                    unblockForClassMutation.mutate();
                  }}
                  data-testid={`button-unblock-${student.primaryDeviceId}`}
                >
                  Unblock for class
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Preview Zone - Live View, Screenshot Thumbnail, or Website Preview Card */}
        {liveStream ? (
          <div className="aspect-video rounded-lg bg-black relative overflow-hidden">
            <div
              ref={tileVideoSlotRef}
              id={`tile-video-slot-${student.primaryDeviceId}`}
              className="w-full h-full rounded-lg overflow-hidden"
              data-testid={`video-live-${student.primaryDeviceId}`}
            />
          </div>
        ) : screenshotData?.screenshot ? (
          // Screenshot thumbnail when available
          <div className="aspect-video rounded-lg bg-muted/40 relative overflow-hidden">
            <img
              src={screenshotData.screenshot}
              alt={`${student.studentName || 'Student'}'s screen`}
              className="w-full h-full object-cover"
              data-testid={`screenshot-${student.primaryDeviceId}`}
            />
            {/* Overlay with tab info */}
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2">
              <div className="flex items-center gap-1.5">
                {student.favicon && (
                  <img
                    src={student.favicon}
                    alt=""
                    className="w-3 h-3 flex-shrink-0 rounded"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                )}
                <span className="text-xs text-white/90 truncate font-medium">
                  {student.activeTabTitle || 'No active tab'}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-lg bg-muted/40 overflow-hidden">
            {/* Website preview header bar */}
            <div className="flex items-center gap-2 px-3 py-2 bg-muted/60 border-b border-border/30">
              {student.favicon ? (
                <img
                  src={student.favicon}
                  alt=""
                  className="w-4 h-4 flex-shrink-0 rounded"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              ) : (
                <div className="w-4 h-4 rounded bg-muted-foreground/20 flex items-center justify-center">
                  <ExternalLink className="w-2.5 h-2.5 text-muted-foreground/50" />
                </div>
              )}
              <span className="text-xs text-muted-foreground truncate flex-1 font-mono" data-testid={`text-tab-url-${student.primaryDeviceId}`}>
                {student.activeTabUrl ? (() => { try { return new URL(student.activeTabUrl).hostname; } catch { return student.activeTabUrl; } })() : 'No tab'}
              </span>
            </div>
            {/* Website content preview */}
            <div className="p-3 min-h-[60px]">
              <p className="font-medium text-sm leading-snug line-clamp-2" data-testid={`text-tab-title-${student.primaryDeviceId}`}>
                {student.activeTabTitle || <span className="text-muted-foreground italic">No active tab</span>}
              </p>
            </div>
          </div>
        )}

        {/* Mini History Icons */}
        {recentDomains.length > 0 && (
          <div className="flex items-center gap-1.5 px-1 py-1.5 border-t border-border/20">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">Recent</span>
            <div className="flex items-center gap-1 flex-1 overflow-x-auto">
              {recentDomains.map((domain, idx) => (
                <div
                  key={idx}
                  className="flex-shrink-0 w-5 h-5 rounded bg-muted/50 flex items-center justify-center border border-border/20"
                  title={domain.title}
                >
                  {domain.favicon ? (
                    <img
                      src={domain.favicon}
                      alt=""
                      className="w-3.5 h-3.5 rounded"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  ) : (
                    <div className="w-2 h-2 rounded-full bg-muted-foreground/30" />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer Zone - Actions Only */}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/20">
          {onStartLiveView && onStopLiveView && (
            <Button
              variant={liveStream ? "default" : "outline"}
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                if (liveStream) {
                  onStopLiveView();
                } else {
                  onStartLiveView();
                }
              }}
              title={liveStream ? "Stop live view" : "Start live view"}
              data-testid={`button-live-view-${student.primaryDeviceId ?? "unknown-device"}`}
            >
              <Monitor className="h-3.5 w-3.5 mr-1" />
              {liveStream ? "Stop" : "View"}
            </Button>
          )}
          {liveStream && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                handleExpand();
              }}
              title="Expand to full screen with zoom, screenshot, and recording controls"
              data-testid={`button-expand-${student.primaryDeviceId ?? "unknown-device"}`}
            >
              <Maximize2 className="h-3.5 w-3.5 mr-1" />
              Expand
            </Button>
          )}
        </div>
      </div>

      {/* Video Portal for enlarged view */}
      {expanded && liveStream && (
        <VideoPortal
          studentName={student.studentName || student.deviceName || student.primaryDeviceId || "Unknown student"}
          onClose={handleCollapse}
        />
      )}
    </Card>
  );
}
