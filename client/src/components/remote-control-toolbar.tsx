import { useState } from "react";
import { MonitorPlay, TabletSmartphone, Lock, Unlock, Layers, ListChecks, CheckSquare, XSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useQuery } from "@tanstack/react-query";
import type { Scene } from "@shared/schema";

interface RemoteControlToolbarProps {
  selectedDeviceIds: Set<string>;
  onSelectAll: () => void;
  onClearSelection: () => void;
}

export function RemoteControlToolbar({ selectedDeviceIds, onSelectAll, onClearSelection }: RemoteControlToolbarProps) {
  const [showOpenTab, setShowOpenTab] = useState(false);
  const [showLockScreen, setShowLockScreen] = useState(false);
  const [showApplyScene, setShowApplyScene] = useState(false);
  const [showTabLimit, setShowTabLimit] = useState(false);
  const [targetUrl, setTargetUrl] = useState("");
  const [lockUrl, setLockUrl] = useState("");
  const [selectedSceneId, setSelectedSceneId] = useState<string>("");
  const [tabLimit, setTabLimit] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  // Fetch scenes
  const { data: scenes = [] } = useQuery<Scene[]>({
    queryKey: ['/api/scenes'],
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


  const handleApplyScene = async () => {
    if (!selectedSceneId) {
      toast({
        title: "Error",
        description: "Please select a scene",
        variant: "destructive",
      });
      return;
    }

    const scene = scenes.find(s => s.id === selectedSceneId);
    if (!scene) return;

    setIsLoading(true);
    try {
      await apiRequest("POST", "/api/remote/apply-scene", { 
        sceneId: selectedSceneId,
        targetDeviceIds: targetDeviceIdsArray
      });
      const target = selectedDeviceIds.size > 0 
        ? `${selectedDeviceIds.size} student(s)` 
        : "all students";
      toast({
        title: "Success",
        description: `Applied scene "${scene.sceneName}" to ${target}`,
      });
      setSelectedSceneId("");
      setShowApplyScene(false);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to apply scene",
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

  // Convert Set to Array for API calls - Sets serialize to {} in JSON
  const targetDeviceIdsArray = selectedDeviceIds.size > 0 ? Array.from(selectedDeviceIds) : undefined;
  const selectionText = selectedDeviceIds.size > 0 
    ? `${selectedDeviceIds.size} selected`
    : "All students";

  return (
    <>
      <div className="border-b border-border bg-muted/30 px-6 py-4">
        <div className="max-w-screen-2xl mx-auto">
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <Badge variant="secondary" className="text-sm px-3 py-1" data-testid="badge-selection-count">
              Target: {selectionText}
            </Badge>
            <Button
              size="sm"
              variant="ghost"
              onClick={onSelectAll}
              data-testid="button-select-all"
            >
              <CheckSquare className="h-4 w-4 mr-1" />
              Select All
            </Button>
            {selectedDeviceIds.size > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onClearSelection}
                data-testid="button-clear-selection"
              >
                <XSquare className="h-4 w-4 mr-1" />
                Clear
              </Button>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowOpenTab(true)}
              data-testid="button-open-tab"
            >
              <MonitorPlay className="h-4 w-4 mr-2" />
              Open Tab
            </Button>

            <Button
              size="sm"
              variant="outline"
              onClick={handleCloseTabs}
              disabled={isLoading}
              data-testid="button-close-tabs"
            >
              <TabletSmartphone className="h-4 w-4 mr-2" />
              Close Tabs
            </Button>

            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowLockScreen(true)}
              data-testid="button-lock-screen"
            >
              <Lock className="h-4 w-4 mr-2" />
              Lock Screen
            </Button>

            <Button
              size="sm"
              variant="outline"
              onClick={handleUnlockScreen}
              disabled={isLoading}
              data-testid="button-unlock-screen"
            >
              <Unlock className="h-4 w-4 mr-2" />
              Unlock Screen
            </Button>

            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowApplyScene(true)}
              data-testid="button-apply-scene"
            >
              <Layers className="h-4 w-4 mr-2" />
              Apply Scene
            </Button>

          </div>
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

      {/* Apply Scene Dialog */}
      <Dialog open={showApplyScene} onOpenChange={setShowApplyScene}>
        <DialogContent data-testid="dialog-apply-scene">
          <DialogHeader>
            <DialogTitle>Apply Scene to Students</DialogTitle>
            <DialogDescription>
              Select a browsing environment to apply. Students can navigate freely within allowed domains (e.g., all pages on ixl.com). Scenes use domain-based matching.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="scene-select">Scene</Label>
              <Select value={selectedSceneId} onValueChange={setSelectedSceneId}>
                <SelectTrigger id="scene-select" data-testid="select-scene">
                  <SelectValue placeholder="Select a scene..." />
                </SelectTrigger>
                <SelectContent>
                  {scenes.length === 0 ? (
                    <div className="p-2 text-sm text-muted-foreground">
                      No scenes available. Create scenes in Settings.
                    </div>
                  ) : (
                    scenes.map((scene) => (
                      <SelectItem key={scene.id} value={scene.id} data-testid={`option-scene-${scene.id}`}>
                        {scene.sceneName}
                        {scene.description && (
                          <span className="text-xs text-muted-foreground ml-2">- {scene.description}</span>
                        )}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {selectedSceneId && scenes.find(s => s.id === selectedSceneId) && (
                <div className="mt-2 p-3 rounded-md bg-muted/50 text-sm">
                  <p className="font-medium mb-1">Scene Details:</p>
                  {scenes.find(s => s.id === selectedSceneId)?.allowedDomains && scenes.find(s => s.id === selectedSceneId)!.allowedDomains!.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      <span className="font-medium">Allowed:</span> {scenes.find(s => s.id === selectedSceneId)!.allowedDomains!.join(", ")}
                    </p>
                  )}
                  {scenes.find(s => s.id === selectedSceneId)?.blockedDomains && scenes.find(s => s.id === selectedSceneId)!.blockedDomains!.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      <span className="font-medium">Blocked:</span> {scenes.find(s => s.id === selectedSceneId)!.blockedDomains!.join(", ")}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowApplyScene(false)} data-testid="button-cancel-apply-scene">
              Cancel
            </Button>
            <Button onClick={handleApplyScene} disabled={isLoading || !selectedSceneId} data-testid="button-submit-apply-scene">
              Apply Scene
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
    </>
  );
}
