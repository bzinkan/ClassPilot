import { useState } from "react";
import { MonitorPlay, TabletSmartphone, Lock, Unlock, Layers, MessageSquare, Megaphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

export function RemoteControlToolbar() {
  const [showOpenTab, setShowOpenTab] = useState(false);
  const [showLockScreen, setShowLockScreen] = useState(false);
  const [showAnnouncement, setShowAnnouncement] = useState(false);
  const [targetUrl, setTargetUrl] = useState("");
  const [lockUrl, setLockUrl] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  const handleOpenTab = async () => {
    if (!targetUrl) {
      toast({
        title: "Error",
        description: "Please enter a URL",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    try {
      await apiRequest("/api/remote/open-tab", "POST", { url: targetUrl });
      toast({
        title: "Success",
        description: `Opened ${targetUrl} on all student devices`,
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
      await apiRequest("/api/remote/close-tabs", "POST", { closeAll: true });
      toast({
        title: "Success",
        description: "Closed all non-essential tabs",
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

    setIsLoading(true);
    try {
      await apiRequest("/api/remote/lock-screen", "POST", { url: lockUrl });
      toast({
        title: "Success",
        description: `Locked all screens to ${lockUrl}`,
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
      await apiRequest("/api/remote/unlock-screen", "POST", {});
      toast({
        title: "Success",
        description: "Unlocked all screens",
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

  const handleSendAnnouncement = async () => {
    if (!announcement) {
      toast({
        title: "Error",
        description: "Please enter an announcement",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    try {
      await apiRequest("/api/chat/announcement", "POST", { message: announcement });
      toast({
        title: "Success",
        description: "Sent announcement to all students",
      });
      setAnnouncement("");
      setShowAnnouncement(false);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to send announcement",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <div className="border-b border-border bg-muted/30 px-6 py-4">
        <div className="max-w-screen-2xl mx-auto">
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
              onClick={() => setShowAnnouncement(true)}
              data-testid="button-announcement"
            >
              <Megaphone className="h-4 w-4 mr-2" />
              Announcement
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
            <DialogTitle>Lock Screens to URL</DialogTitle>
            <DialogDescription>
              Lock all student screens to a specific URL. Students won't be able to navigate away until unlocked.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="lock-url">URL</Label>
              <Input
                id="lock-url"
                placeholder="https://example.com"
                value={lockUrl}
                onChange={(e) => setLockUrl(e.target.value)}
                data-testid="input-lock-url"
              />
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

      {/* Announcement Dialog */}
      <Dialog open={showAnnouncement} onOpenChange={setShowAnnouncement}>
        <DialogContent data-testid="dialog-announcement">
          <DialogHeader>
            <DialogTitle>Send Announcement</DialogTitle>
            <DialogDescription>
              Broadcast an important message to all students. They'll receive a notification.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="announcement">Message</Label>
              <Input
                id="announcement"
                placeholder="Class will end in 5 minutes..."
                value={announcement}
                onChange={(e) => setAnnouncement(e.target.value)}
                data-testid="input-announcement"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAnnouncement(false)} data-testid="button-cancel-announcement">
              Cancel
            </Button>
            <Button onClick={handleSendAnnouncement} disabled={isLoading} data-testid="button-submit-announcement">
              Send Announcement
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
