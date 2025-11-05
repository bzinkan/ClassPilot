import { useState } from "react";
import { MonitorPlay, TabletSmartphone, Lock, Unlock, Layers, ListChecks, CheckSquare, XSquare, Users, BarChart3, Route } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useQuery } from "@tanstack/react-query";
import type { FlightPath, StudentStatus, Settings } from "@shared/schema";

interface RemoteControlToolbarProps {
  selectedDeviceIds: Set<string>;
  students: StudentStatus[];
  onToggleStudent: (deviceId: string) => void;
  onClearSelection: () => void;
  selectedGrade: string;
  onGradeChange: (grade: string) => void;
}

export function RemoteControlToolbar({ selectedDeviceIds, students, onToggleStudent, onClearSelection, selectedGrade, onGradeChange }: RemoteControlToolbarProps) {
  const [showOpenTab, setShowOpenTab] = useState(false);
  const [showLockScreen, setShowLockScreen] = useState(false);
  const [showFlightPathDialog, setShowFlightPathDialog] = useState(false);
  const [showStudentDataDialog, setShowStudentDataDialog] = useState(false);
  const [showTabLimit, setShowTabLimit] = useState(false);
  const [showApplyScene, setShowApplyScene] = useState(false);
  const [targetUrl, setTargetUrl] = useState("");
  const [lockUrl, setLockUrl] = useState("");
  const [tabLimit, setTabLimit] = useState("");
  const [selectedSceneId, setSelectedSceneId] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  // Fetch flight paths
  const { data: scenes = [] } = useQuery<FlightPath[]>({
    queryKey: ['/api/flight-paths'],
  });
  
  // Fetch settings for grade levels
  const { data: settings } = useQuery<Settings>({
    queryKey: ['/api/settings'],
  });

  const handleOpenTab = async () => {
    if (!targetUrl) {
      toast({
        title: "Error",
        description: "Please enter a URL",
        variant: "destructive",
      });
      return;
    }

    // Normalize URL - add https:// if no protocol specified
    let normalizedUrl = targetUrl.trim();
    if (!normalizedUrl.match(/^https?:\/\//i)) {
      normalizedUrl = 'https://' + normalizedUrl;
    }

    setIsLoading(true);
    try {
      await apiRequest("POST", "/api/remote/open-tab", { 
        url: normalizedUrl,
        targetDeviceIds: targetDeviceIdsArray
      });
      const target = selectedDeviceIds.size > 0 
        ? `${selectedDeviceIds.size} student(s)` 
        : "all students";
      toast({
        title: "Success",
        description: `Opened ${normalizedUrl} on ${target}`,
      });
      setTargetUrl("");
      setShowOpenTab(false);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to open tab",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleCloseTabs = async () => {
    setIsLoading(true);
    try {
      await apiRequest("POST", "/api/remote/close-tabs", { 
        closeAll: true,
        targetDeviceIds: targetDeviceIdsArray
      });
      const target = selectedDeviceIds.size > 0 
        ? `${selectedDeviceIds.size} student(s)` 
        : "all students";
      toast({
        title: "Success",
        description: `Closed tabs on ${target}`,
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to close tabs",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleLockScreen = async () => {
    if (!lockUrl) {
      toast({
        title: "Error",
        description: "Please enter a URL to lock to",
        variant: "destructive",
      });
      return;
    }

    // Normalize URL - add https:// if no protocol specified
    let normalizedLockUrl = lockUrl.trim();
    if (!normalizedLockUrl.match(/^https?:\/\//i)) {
      normalizedLockUrl = 'https://' + normalizedLockUrl;
    }

    setIsLoading(true);
    try {
      await apiRequest("POST", "/api/remote/lock-screen", { 
        url: normalizedLockUrl,
        targetDeviceIds: targetDeviceIdsArray
      });
      const target = selectedDeviceIds.size > 0 
        ? `${selectedDeviceIds.size} student(s)` 
        : "all students";
      
      // Extract domain for display
      const domain = normalizedLockUrl.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
      
      toast({
        title: "Screen Locked",
        description: `${target} locked to ${domain} - they can browse within this site`,
      });
      setLockUrl("");
      setShowLockScreen(false);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to lock screens",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleUnlockScreen = async () => {
    setIsLoading(true);
    try {
      await apiRequest("POST", "/api/remote/unlock-screen", { 
        targetDeviceIds: targetDeviceIdsArray 
      });
      const target = selectedDeviceIds.size > 0 
        ? `${selectedDeviceIds.size} student(s)` 
        : "all students";
      toast({
        title: "Success",
        description: `Unlocked ${target}`,
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to unlock screens",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };



  const handleApplyTabLimit = async () => {
    const maxTabs = tabLimit ? parseInt(tabLimit, 10) : null;
    
    if (maxTabs !== null && (isNaN(maxTabs) || maxTabs < 1)) {
      toast({
        title: "Error",
        description: "Please enter a valid number of tabs (minimum 1)",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    try {
      await apiRequest("POST", "/api/remote/limit-tabs", { maxTabs });
      toast({
        title: "Success",
        description: maxTabs 
          ? `Set tab limit to ${maxTabs} for all students`
          : "Removed tab limit for all students",
      });
      setTabLimit("");
      setShowTabLimit(false);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to apply tab limit",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleApplyScene = async () => {
    if (!selectedSceneId) {
      toast({
        title: "Error",
        description: "Please select a flight path",
        variant: "destructive",
      });
      return;
    }

    const scene = scenes.find(s => s.id === selectedSceneId);
    if (!scene) {
      toast({
        title: "Error",
        description: "Flight path not found",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    try {
      await apiRequest("POST", "/api/remote/apply-flight-path", { 
        flightPathId: selectedSceneId,
        allowedDomains: scene.allowedDomains,
        targetDeviceIds: targetDeviceIdsArray
      });
      const target = selectedDeviceIds.size > 0 
        ? `${selectedDeviceIds.size} student(s)` 
        : "all students";
      toast({
        title: "Success",
        description: `Applied "${scene.flightPathName}" to ${target}`,
      });
      setSelectedSceneId("");
      setShowApplyScene(false);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to apply flight path",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Convert Set to Array for API calls - Sets serialize to {} in JSON
  const targetDeviceIdsArray = selectedDeviceIds.size > 0 ? Array.from(selectedDeviceIds) : undefined;
  const selectionText = selectedDeviceIds.size > 0 
    ? `${selectedDeviceIds.size} selected`
    : "All students";

  // Sort students alphabetically by name
  const sortedStudents = [...students].sort((a, b) => {
    const nameA = a.studentName || '';
    const nameB = b.studentName || '';
    return nameA.localeCompare(nameB);
  });

  return (
    <>
      <div className="border-b border-border bg-muted/30 px-6 py-4 mb-8">
        <div className="max-w-screen-2xl mx-auto">
          {/* Top Row: New Tabs, Target Badge, Select Dropdown */}
          <div className="flex items-center gap-2 flex-wrap mb-3">
            {/* Left Side: Flight Path and Student Data Tabs */}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowFlightPathDialog(true)}
              data-testid="button-flight-path-tab"
            >
              <Route className="h-4 w-4 mr-2" />
              Flight Path
            </Button>

            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowStudentDataDialog(true)}
              data-testid="button-student-data-tab"
            >
              <BarChart3 className="h-4 w-4 mr-2" />
              Student Data
            </Button>

            <div className="h-6 w-px bg-border mx-1" />
            
            {/* Target Badge and Select */}
            <Badge variant="secondary" className="text-sm px-3 py-1" data-testid="badge-selection-count">
              Target: {selectionText}
            </Badge>
            
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="button-select-students"
                >
                  <Users className="h-4 w-4 mr-1" />
                  Select
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64 max-h-96 overflow-y-auto">
                <DropdownMenuLabel>Select Students</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {sortedStudents.length === 0 ? (
                  <div className="px-2 py-6 text-center text-sm text-muted-foreground">
                    No students available
                  </div>
                ) : (
                  sortedStudents.map((student) => (
                    <DropdownMenuCheckboxItem
                      key={student.deviceId}
                      checked={selectedDeviceIds.has(student.deviceId)}
                      onCheckedChange={() => onToggleStudent(student.deviceId)}
                      onSelect={(e) => e.preventDefault()}
                      data-testid={`dropdown-item-student-${student.deviceId}`}
                    >
                      {student.studentName || 'Unnamed Student'}
                    </DropdownMenuCheckboxItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              size="sm"
              variant="ghost"
              onClick={onClearSelection}
              disabled={selectedDeviceIds.size === 0}
              data-testid="button-clear-selection"
            >
              <XSquare className="h-4 w-4 mr-1" />
              Clear Selection
            </Button>
          </div>

          {/* Bottom Row: Grade Tabs (replacing control buttons) */}
          {settings?.gradeLevels && settings.gradeLevels.length > 0 && (
            <Tabs value={selectedGrade} onValueChange={onGradeChange}>
              <TabsList className="flex-wrap h-auto gap-2 p-1.5 bg-muted/50 rounded-xl">
                {settings.gradeLevels.map((grade) => (
                  <TabsTrigger 
                    key={grade} 
                    value={grade} 
                    data-testid={`tab-grade-${grade}`}
                    className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-lg px-5 py-2.5 font-medium transition-all duration-200 data-[state=active]:shadow-md"
                  >
                    {grade}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}
        </div>
      </div>

      {/* Open Tab Dialog */}
      <Dialog open={showOpenTab} onOpenChange={setShowOpenTab}>
        <DialogContent data-testid="dialog-open-tab">
          <DialogHeader>
            <DialogTitle>Open Tab on All Devices</DialogTitle>
            <DialogDescription>
              Enter a URL to open on all student devices. This will open a new tab with the specified URL.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="target-url">URL</Label>
              <Input
                id="target-url"
                placeholder="https://example.com"
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                data-testid="input-target-url"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowOpenTab(false)} data-testid="button-cancel-open-tab">
              Cancel
            </Button>
            <Button onClick={handleOpenTab} disabled={isLoading} data-testid="button-submit-open-tab">
              Open Tab
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Lock Screen Dialog */}
      <Dialog open={showLockScreen} onOpenChange={setShowLockScreen}>
        <DialogContent data-testid="dialog-lock-screen">
          <DialogHeader>
            <DialogTitle>Lock Screens to Website</DialogTitle>
            <DialogDescription>
              Lock student screens to a specific website domain. Students can navigate freely within that site (e.g., ixl.com/math, ixl.com/science) but cannot leave the domain until unlocked.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="lock-url">Website URL</Label>
              <Input
                id="lock-url"
                placeholder="https://ixl.com or khanacademy.org"
                value={lockUrl}
                onChange={(e) => setLockUrl(e.target.value)}
                data-testid="input-lock-url"
              />
              <p className="text-xs text-muted-foreground">
                Students will be locked to this domain and can browse within it freely.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowLockScreen(false)} data-testid="button-cancel-lock">
              Cancel
            </Button>
            <Button onClick={handleLockScreen} disabled={isLoading} data-testid="button-submit-lock">
              Lock Screens
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Limit Tabs Dialog */}
      <Dialog open={showTabLimit} onOpenChange={setShowTabLimit}>
        <DialogContent data-testid="dialog-limit-tabs">
          <DialogHeader>
            <DialogTitle>Limit Student Tabs</DialogTitle>
            <DialogDescription>
              Set the maximum number of tabs students can have open. Leave empty to remove the limit.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="tab-limit">Maximum Tabs (leave empty for unlimited)</Label>
              <Input
                id="tab-limit"
                type="number"
                min="1"
                placeholder="e.g., 5"
                value={tabLimit}
                onChange={(e) => setTabLimit(e.target.value)}
                data-testid="input-tab-limit"
              />
              <p className="text-xs text-muted-foreground">
                When a limit is set, the oldest tabs will be automatically closed if students exceed this number.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTabLimit(false)} data-testid="button-cancel-limit-tabs">
              Cancel
            </Button>
            <Button onClick={handleApplyTabLimit} disabled={isLoading} data-testid="button-submit-limit-tabs">
              Apply Tab Limit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Apply Flight Path Dialog */}
      <Dialog open={showApplyScene} onOpenChange={setShowApplyScene}>
        <DialogContent data-testid="dialog-apply-flight-path">
          <DialogHeader>
            <DialogTitle>Apply Flight Path</DialogTitle>
            <DialogDescription>
              Select a flight path to apply. Students will only be able to access the allowed domains defined in the flight path.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="scene-select">Flight Path</Label>
              <Select value={selectedSceneId} onValueChange={setSelectedSceneId}>
                <SelectTrigger id="scene-select" data-testid="select-scene">
                  <SelectValue placeholder="Select a flight path" />
                </SelectTrigger>
                <SelectContent>
                  {scenes.length === 0 ? (
                    <div className="p-2 text-sm text-muted-foreground">No flight paths available</div>
                  ) : (
                    scenes.map((scene) => (
                      <SelectItem key={scene.id} value={scene.id} data-testid={`select-scene-${scene.id}`}>
                        {scene.flightPathName}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {selectedSceneId && (() => {
                const selectedScene = scenes.find(s => s.id === selectedSceneId);
                return selectedScene && selectedScene.allowedDomains ? (
                  <div className="mt-2 p-3 bg-muted rounded-md">
                    <p className="text-sm font-medium mb-1">Allowed Domains:</p>
                    <ul className="text-sm text-muted-foreground list-disc list-inside">
                      {selectedScene.allowedDomains.map((domain: string, index: number) => (
                        <li key={index}>{domain}</li>
                      ))}
                    </ul>
                  </div>
                ) : null;
              })()}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowApplyScene(false)} data-testid="button-cancel-apply-flight-path">
              Cancel
            </Button>
            <Button onClick={handleApplyScene} disabled={isLoading || !selectedSceneId} data-testid="button-submit-apply-flight-path">
              Apply Flight Path
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
