import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { ExternalLink, Clock, Monitor, Camera, History as HistoryIcon, LayoutGrid, Calendar as CalendarIcon, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AggregatedStudentStatus, Heartbeat } from "@shared/schema";
import { formatDistanceToNow, format, startOfDay, endOfDay } from "date-fns";
import { calculateURLSessions, formatDuration, isSessionOffTask } from "@shared/utils";

interface StudentDetailDrawerProps {
  student: AggregatedStudentStatus | null;
  urlHistory: Heartbeat[];
  allowedDomains: string[];
  onClose: () => void;
}

export function StudentDetailDrawer({
  student,
  urlHistory,
  allowedDomains,
  onClose,
}: StudentDetailDrawerProps) {
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

  const [panelWidth, setPanelWidth] = useState(700);
  const isResizing = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const newWidth = window.innerWidth - e.clientX;
      const maxWidth = window.innerWidth * 0.9;
      setPanelWidth(Math.max(400, Math.min(maxWidth, newWidth)));
    };

    const handleMouseUp = () => {
      if (!isResizing.current) return;
      isResizing.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

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
      <SheetContent side="right" className="p-0 flex flex-col" style={{ width: `${panelWidth}px`, maxWidth: '90vw' }}>
        {/* Resize drag handle */}
        <div
          onMouseDown={handleMouseDown}
          className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize z-50 group"
        >
          <div className="absolute left-0.5 top-1/2 -translate-y-1/2 w-1 h-12 rounded-full bg-border opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
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
                {student.primaryDeviceId && (
                  <span className="text-xs text-muted-foreground font-mono">
                    device-{student.primaryDeviceId.slice(0, 8)}
                  </span>
                )}
              </div>
            </div>
          </div>
        </SheetHeader>

          {/* Tabs Content */}
          <div className="flex-1 overflow-hidden">
            <Tabs defaultValue="screens" className="flex flex-col h-full">
              <div className="px-6 border-b border-border overflow-x-auto">
                <TabsList className="w-full justify-start bg-transparent h-auto p-0 flex-nowrap" data-testid="student-tabs">
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
                                    <div className="flex items-start gap-2 mb-1">
                                      {session.favicon && (
                                        <img
                                          src={session.favicon}
                                          alt=""
                                          className="w-3 h-3 flex-shrink-0 mt-0.5"
                                          onError={(e) => {
                                            (e.target as HTMLImageElement).style.display = 'none';
                                          }}
                                        />
                                      )}
                                      <p className="text-sm font-medium break-words flex-1">
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
                  <div className="p-6 space-y-4">
                    {/* Date Selector */}
                    <div className="flex items-center gap-2 justify-between">
                      <h3 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
                        Activity Timeline
                      </h3>
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button variant="outline" size="sm" className="w-[180px] justify-start text-left font-normal" data-testid="button-timeline-date">
                            <CalendarIcon className="mr-2 h-4 w-4" />
                            {historyStartDate ? format(historyStartDate, "PPP") : "Select date"}
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
                    </div>

                    {(() => {
                      // Filter sessions by selected date
                      const selectedDate = historyStartDate || new Date();
                      const dayStart = startOfDay(selectedDate);
                      const dayEnd = endOfDay(selectedDate);
                      
                      // Calculate ALL sessions from full history first (preserves cross-midnight sessions)
                      const allSessions = calculateURLSessions(urlHistory);
                      
                      // Filter to sessions that OVERLAP with the selected day
                      // Includes: sessions starting on the day, sessions ending on the day,
                      // and sessions spanning across the day
                      const daySessions = allSessions.filter(session => {
                        return session.startTime < dayEnd && session.endTime > dayStart;
                      });

                      if (daySessions.length === 0) {
                        return (
                          <div className="p-8 text-center border rounded-lg">
                            <Clock className="h-12 w-12 mx-auto mb-3 text-muted-foreground opacity-50" />
                            <p className="text-sm text-muted-foreground font-medium">No activity found</p>
                            <p className="text-xs text-muted-foreground mt-1">
                              No browsing activity recorded for {format(selectedDate, 'MMM d, yyyy')}
                            </p>
                          </div>
                        );
                      }
                      
                      // Find earliest and latest activity using fractional hours from day start
                      // This handles cross-midnight sessions correctly
                      const MS_PER_HOUR = 3600000;
                      const fractionalHours: number[] = [];
                      daySessions.forEach(session => {
                        const startFractional = (session.startTime.getTime() - dayStart.getTime()) / MS_PER_HOUR;
                        const endFractional = (session.endTime.getTime() - dayStart.getTime()) / MS_PER_HOUR;
                        fractionalHours.push(startFractional, endFractional);
                      });
                      
                      // Calculate hour range with padding, allowing full day coverage including cross-midnight
                      const minFractionalHour = Math.min(...fractionalHours);
                      const maxFractionalHour = Math.max(...fractionalHours);
                      const earliestHour = Math.max(0, Math.floor(minFractionalHour) - 1); // Pad by 1 hour before, min 0
                      const latestHour = Math.min(48, Math.ceil(maxFractionalHour) + 1);  // Pad by 1 hour after, allow up to 48 for cross-midnight
                      const totalHours = Math.max(1, latestHour - earliestHour); // Ensure at least 1 hour to prevent division by zero
                      
                      // Check for off-task indicators and enhance session data
                      const sessionsWithData = daySessions.map(session => {
                        const sessionHeartbeats = urlHistory.filter(hb => 
                          hb.activeTabUrl === session.url &&
                          new Date(hb.timestamp) >= session.startTime &&
                          new Date(hb.timestamp) <= session.endTime
                        );
                        
                        const hasCamera = sessionHeartbeats.some(hb => hb.cameraActive);
                        
                        // Check if this is a "no active tab" session
                        const isNoTab = !session.url || session.url.trim() === '';
                        
                        // Use shared off-task detection logic (checks camera AND allowed domains)
                        // BUT skip off-task check for "no active tab" sessions - they're neutral, not off-task
                        const hasOffTask = isNoTab ? false : isSessionOffTask(session.url, hasCamera, allowedDomains);
                        
                        return { 
                          ...session, 
                          hasOffTask, 
                          hasCamera,
                          isNoTab,
                          // Override display values for no-tab sessions
                          displayTitle: isNoTab ? 'No Active Tab' : session.title,
                          displayUrl: isNoTab ? 'Browser open but no tab focused' : session.url
                        };
                      });

                      return (
                        <div className="space-y-4">
                          {/* Timeline Grid */}
                          <div className="border rounded-lg p-4 bg-muted/10">
                            {/* Hour Labels */}
                            <div className="flex items-center mb-2">
                              <div className="w-20 flex-shrink-0 text-xs text-muted-foreground font-medium">Time</div>
                              <div className="flex-1 relative" style={{ height: '24px' }}>
                                {Array.from({ length: totalHours + 1 }).map((_, i) => {
                                  const hour = earliestHour + i;
                                  const displayHour = hour % 24; // Handle hours >= 24 (cross-midnight)
                                  const nextDay = hour >= 24;
                                  return (
                                    <div
                                      key={hour}
                                      className="absolute text-xs text-muted-foreground"
                                      style={{
                                        left: `${(i / totalHours) * 100}%`,
                                        transform: 'translateX(-50%)'
                                      }}
                                    >
                                      {format(new Date().setHours(displayHour, 0), 'ha')}
                                      {nextDay && <span className="text-xxs">+1</span>}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>

                            {/* Activity Bars */}
                            <div className="space-y-2">
                              {sessionsWithData.map((session, index) => {
                                // Calculate fractional hours from day start (handles cross-midnight correctly)
                                const startHour = (session.startTime.getTime() - dayStart.getTime()) / MS_PER_HOUR;
                                const endHour = (session.endTime.getTime() - dayStart.getTime()) / MS_PER_HOUR;
                                
                                // Calculate bar position and width, clamping to visible range
                                const rawLeftPercent = ((startHour - earliestHour) / totalHours) * 100;
                                const rawRightPercent = ((endHour - earliestHour) / totalHours) * 100;
                                
                                // Clamp to 0-100% range
                                const leftPercent = Math.max(0, Math.min(100, rawLeftPercent));
                                const rightPercent = Math.max(0, Math.min(100, rawRightPercent));
                                const widthPercent = Math.max(0.5, rightPercent - leftPercent); // Minimum 0.5% width for visibility
                                
                                const barColor = session.hasOffTask 
                                  ? 'bg-red-500 dark:bg-red-600' 
                                  : session.isNoTab
                                  ? 'bg-muted-foreground/50' // Gray for no active tab
                                  : 'bg-primary';
                                
                                return (
                                  <Popover key={index}>
                                    <PopoverTrigger asChild>
                                      <div className="flex items-center group cursor-pointer">
                                        <div className="w-20 flex-shrink-0">
                                          <p className="text-xs font-medium truncate">
                                            {format(session.startTime, 'h:mm a')}
                                          </p>
                                        </div>
                                        <div className="flex-1 relative" style={{ height: '32px' }}>
                                          <div
                                            className={`absolute ${barColor} rounded hover-elevate transition-all h-6 flex items-center px-2 overflow-hidden`}
                                            style={{
                                              left: `${leftPercent}%`,
                                              width: `${Math.max(widthPercent, 2)}%`,
                                              minWidth: '4px'
                                            }}
                                          >
                                            <span className={`text-xs font-medium truncate ${session.isNoTab ? 'text-muted-foreground' : 'text-white'}`}>
                                              {session.displayTitle}
                                            </span>
                                          </div>
                                        </div>
                                      </div>
                                    </PopoverTrigger>
                                    <PopoverContent className="w-80" side="top">
                                      <div className="space-y-2">
                                        <div className="flex items-start gap-2">
                                          {session.favicon && !session.isNoTab && (
                                            <img
                                              src={session.favicon}
                                              alt=""
                                              className="w-4 h-4 flex-shrink-0 mt-0.5"
                                              onError={(e) => {
                                                (e.target as HTMLImageElement).style.display = 'none';
                                              }}
                                            />
                                          )}
                                          <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium break-words">{session.displayTitle}</p>
                                            <p className="text-xs text-muted-foreground font-mono break-all mt-1">
                                              {session.displayUrl}
                                            </p>
                                          </div>
                                        </div>
                                        <Separator />
                                        <div className="flex items-center gap-4 text-xs">
                                          <div className="flex items-center gap-1">
                                            <Clock className="h-3 w-3" />
                                            <span className="font-medium text-primary">{formatDuration(session.durationSeconds)}</span>
                                          </div>
                                          <span className="text-muted-foreground">
                                            {format(session.startTime, 'h:mm a')} - {format(session.endTime, 'h:mm a')}
                                          </span>
                                        </div>
                                        {session.hasOffTask && (
                                          <Badge variant="destructive" className="text-xs">
                                            <AlertTriangle className="h-3 w-3 mr-1" />
                                            Off-Task Activity
                                          </Badge>
                                        )}
                                        {session.hasCamera && (
                                          <Badge variant="outline" className="text-xs">
                                            <Camera className="h-3 w-3 mr-1" />
                                            Camera Active
                                          </Badge>
                                        )}
                                      </div>
                                    </PopoverContent>
                                  </Popover>
                                );
                              })}
                            </div>

                            {/* Legend */}
                            <div className="flex items-center gap-4 mt-4 pt-4 border-t text-xs flex-wrap">
                              <div className="flex items-center gap-2">
                                <div className="w-4 h-4 bg-primary rounded"></div>
                                <span className="text-muted-foreground">On-Task</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <div className="w-4 h-4 bg-red-500 rounded"></div>
                                <span className="text-muted-foreground">Off-Task</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <div className="w-4 h-4 bg-muted-foreground/50 rounded"></div>
                                <span className="text-muted-foreground">No Active Tab</span>
                              </div>
                            </div>
                          </div>

                          {/* Summary Stats */}
                          <Card>
                            <CardHeader className="pb-3">
                              <CardTitle className="text-sm font-medium">Daily Summary</CardTitle>
                            </CardHeader>
                            <Separator />
                            <CardContent className="pt-4">
                              <div className="grid grid-cols-2 gap-4">
                                <div>
                                  <p className="text-xs text-muted-foreground mb-1">Total Sessions</p>
                                  <p className="text-2xl font-bold">{sessionsWithData.length}</p>
                                </div>
                                <div>
                                  <p className="text-xs text-muted-foreground mb-1">Total Time</p>
                                  <p className="text-2xl font-bold">
                                    {formatDuration(sessionsWithData.reduce((sum, s) => sum + s.durationSeconds, 0))}
                                  </p>
                                </div>
                                <div>
                                  <p className="text-xs text-muted-foreground mb-1">Off-Task Alerts</p>
                                  <p className="text-2xl font-bold text-red-600 dark:text-red-500">
                                    {sessionsWithData.filter(s => s.hasOffTask).length}
                                  </p>
                                </div>
                                <div>
                                  <p className="text-xs text-muted-foreground mb-1">First Activity</p>
                                  <p className="text-lg font-semibold">
                                    {sessionsWithData.length > 0 ? format(sessionsWithData[0].startTime, 'h:mm a') : 'N/A'}
                                  </p>
                                </div>
                              </div>
                            </CardContent>
                          </Card>
                        </div>
                      );
                    })()}
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
                                    <div className="flex items-start gap-2 mb-1 flex-wrap">
                                      {session.favicon && (
                                        <img
                                          src={session.favicon}
                                          alt=""
                                          className="w-3 h-3 flex-shrink-0 mt-0.5"
                                          onError={(e) => {
                                            (e.target as HTMLImageElement).style.display = 'none';
                                          }}
                                        />
                                      )}
                                      <p className="text-sm font-medium break-words flex-1 min-w-0">
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
    </Sheet>
  );
}
