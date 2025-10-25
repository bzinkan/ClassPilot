import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ArrowLeft, Upload, Download, Shield, Clock, AlertCircle } from "lucide-react";
import type { Settings as SettingsType } from "@shared/schema";

const settingsSchema = z.object({
  schoolName: z.string().min(1, "School name is required"),
  wsSharedKey: z.string().min(8, "WebSocket key must be at least 8 characters"),
  retentionHours: z.string().min(1, "Retention period is required"),
  blockedDomains: z.string(),
  ipAllowlist: z.string(),
});

type SettingsForm = z.infer<typeof settingsSchema>;

export default function Settings() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportStartDate, setExportStartDate] = useState("");
  const [exportEndDate, setExportEndDate] = useState("");

  const { data: settings, isLoading } = useQuery<SettingsType>({
    queryKey: ['/api/settings'],
  });

  const form = useForm<SettingsForm>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      schoolName: settings?.schoolName || "",
      wsSharedKey: settings?.wsSharedKey || "",
      retentionHours: settings?.retentionHours || "24",
      blockedDomains: settings?.blockedDomains?.join(", ") || "",
      ipAllowlist: settings?.ipAllowlist?.join(", ") || "",
    },
  });

  // Update form when settings load
  useEffect(() => {
    if (settings) {
      form.reset({
        schoolName: settings.schoolName,
        wsSharedKey: settings.wsSharedKey,
        retentionHours: settings.retentionHours,
        blockedDomains: settings.blockedDomains?.join(", ") || "",
        ipAllowlist: settings.ipAllowlist?.join(", ") || "",
      });
    }
  }, [settings, form]);

  const updateSettingsMutation = useMutation({
    mutationFn: async (data: SettingsForm) => {
      const payload = {
        ...data,
        blockedDomains: data.blockedDomains
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean),
        ipAllowlist: data.ipAllowlist
          .split(",")
          .map((ip) => ip.trim())
          .filter(Boolean),
      };
      return await apiRequest("POST", "/api/settings", payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/settings'] });
      toast({
        title: "Settings saved",
        description: "Your settings have been updated successfully",
      });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to save settings",
        description: error.message,
      });
    },
  });

  const uploadRosterMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("roster", file);
      const response = await fetch("/api/roster/upload", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!response.ok) throw new Error("Upload failed");
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Roster uploaded",
        description: "Class roster has been uploaded successfully",
      });
      setCsvFile(null);
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Upload failed",
        description: error.message,
      });
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type === "text/csv") {
      setCsvFile(file);
    } else {
      toast({
        variant: "destructive",
        title: "Invalid file",
        description: "Please select a CSV file",
      });
    }
  };

  const handleUploadRoster = () => {
    if (csvFile) {
      uploadRosterMutation.mutate(csvFile);
    }
  };

  const handleOpenExportDialog = () => {
    // Set default dates: last 7 days
    const end = new Date();
    const start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    
    setExportEndDate(end.toISOString().split('T')[0]);
    setExportStartDate(start.toISOString().split('T')[0]);
    setShowExportDialog(true);
  };

  const handleExportData = () => {
    if (!exportStartDate || !exportEndDate) {
      toast({
        variant: "destructive",
        title: "Invalid Dates",
        description: "Please select both start and end dates",
      });
      return;
    }

    const startDate = new Date(exportStartDate).toISOString();
    const endDate = new Date(exportEndDate + 'T23:59:59').toISOString();
    
    window.location.href = `/api/export/activity?startDate=${startDate}&endDate=${endDate}`;
    toast({
      title: "Exporting Data",
      description: `Downloading activity report from ${exportStartDate} to ${exportEndDate}...`,
    });
    setShowExportDialog(false);
  };

  const onSubmit = (data: SettingsForm) => {
    updateSettingsMutation.mutate(data);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="h-8 w-8 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-sm text-muted-foreground">Loading settings...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-background">
        <div className="max-w-4xl mx-auto px-6 py-4">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setLocation("/dashboard")}
              data-testid="button-back"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-xl font-semibold">Settings</h1>
              <p className="text-xs text-muted-foreground">Manage your classroom monitoring settings</p>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto px-6 py-8 space-y-8">
        {/* General Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              General Settings
            </CardTitle>
            <CardDescription>
              Configure your school information and security settings
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="schoolName">School Name</Label>
                <Input
                  id="schoolName"
                  data-testid="input-school-name"
                  {...form.register("schoolName")}
                  placeholder="Enter your school name"
                />
                {form.formState.errors.schoolName && (
                  <p className="text-sm text-destructive">
                    {form.formState.errors.schoolName.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="wsSharedKey">WebSocket Shared Key</Label>
                <Input
                  id="wsSharedKey"
                  data-testid="input-ws-key"
                  type="password"
                  {...form.register("wsSharedKey")}
                  placeholder="Enter WebSocket authentication key"
                />
                {form.formState.errors.wsSharedKey && (
                  <p className="text-sm text-destructive">
                    {form.formState.errors.wsSharedKey.message}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  This key is used to authenticate WebSocket connections from the extension
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="retentionHours">Data Retention (hours)</Label>
                <Input
                  id="retentionHours"
                  data-testid="input-retention-hours"
                  type="number"
                  {...form.register("retentionHours")}
                  placeholder="24"
                />
                {form.formState.errors.retentionHours && (
                  <p className="text-sm text-destructive">
                    {form.formState.errors.retentionHours.message}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Student activity data will be automatically deleted after this period
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="blockedDomains">Blocked Domains (comma-separated)</Label>
                <Input
                  id="blockedDomains"
                  data-testid="input-blocked-domains"
                  {...form.register("blockedDomains")}
                  placeholder="example.com, badsite.net"
                />
                <p className="text-xs text-muted-foreground">
                  Student tiles will be highlighted if they visit these domains
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="ipAllowlist">IP Allowlist (comma-separated)</Label>
                <Input
                  id="ipAllowlist"
                  data-testid="input-ip-allowlist"
                  {...form.register("ipAllowlist")}
                  placeholder="192.168.1.100, 10.0.0.50"
                />
                <p className="text-xs text-muted-foreground">
                  Only these IPs can access the teacher dashboard (enforced in production only). Leave empty to allow all IPs.
                </p>
              </div>

              <Button
                type="submit"
                data-testid="button-save-settings"
                disabled={updateSettingsMutation.isPending}
              >
                {updateSettingsMutation.isPending ? "Saving..." : "Save Settings"}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Roster Management */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5" />
              Class Roster Upload
            </CardTitle>
            <CardDescription>
              Upload a CSV file with student names, device IDs, and class IDs
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="border-2 border-dashed border-border rounded-lg p-8 text-center">
              <Upload className="h-12 w-12 mx-auto mb-3 text-muted-foreground/50" />
              <div className="space-y-2">
                <Label htmlFor="roster-file" className="cursor-pointer">
                  <span className="text-sm font-semibold text-primary hover:underline">
                    Choose CSV file
                  </span>
                  <Input
                    id="roster-file"
                    data-testid="input-roster-file"
                    type="file"
                    accept=".csv"
                    onChange={handleFileChange}
                    className="hidden"
                  />
                </Label>
                <p className="text-xs text-muted-foreground">
                  CSV format: studentName, deviceId, classId
                </p>
              </div>
              {csvFile && (
                <div className="mt-4 p-3 bg-muted/50 rounded-md border border-border flex items-center justify-between">
                  <span className="text-sm font-mono">{csvFile.name}</span>
                  <Button
                    size="sm"
                    onClick={handleUploadRoster}
                    data-testid="button-upload-roster"
                    disabled={uploadRosterMutation.isPending}
                  >
                    {uploadRosterMutation.isPending ? "Uploading..." : "Upload"}
                  </Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Data Export */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Download className="h-5 w-5" />
              Export Data
            </CardTitle>
            <CardDescription>
              Download activity data for compliance and reporting
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              onClick={handleOpenExportDialog}
              data-testid="button-export-data"
            >
              <Download className="h-4 w-4 mr-2" />
              Export Activity CSV
            </Button>
          </CardContent>
        </Card>

        {/* Privacy Notice */}
        <Card className="border-primary/20 bg-primary/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertCircle className="h-5 w-5 text-primary" />
              Privacy & Compliance
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              This system is designed to be FERPA and COPPA compliant. All monitoring is visible to students through the Chrome extension.
            </p>
            <p>
              Data collected: Tab titles, URLs, and timestamps only. No keystrokes, microphone, or camera access.
            </p>
            <p>
              Screen sharing requires explicit student consent via button click and shows a visible indicator.
            </p>
          </CardContent>
        </Card>
      </main>

      {/* Export Dialog */}
      <Dialog open={showExportDialog} onOpenChange={setShowExportDialog}>
        <DialogContent data-testid="dialog-export-csv">
          <DialogHeader>
            <DialogTitle>Export Activity Report</DialogTitle>
            <DialogDescription>
              Select a date range to export student activity data as CSV
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="start-date-settings">Start Date</Label>
              <Input
                id="start-date-settings"
                type="date"
                value={exportStartDate}
                onChange={(e) => setExportStartDate(e.target.value)}
                data-testid="input-export-start-date"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="end-date-settings">End Date</Label>
              <Input
                id="end-date-settings"
                type="date"
                value={exportEndDate}
                onChange={(e) => setExportEndDate(e.target.value)}
                data-testid="input-export-end-date"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowExportDialog(false)} data-testid="button-cancel-export">
              Cancel
            </Button>
            <Button onClick={handleExportData} data-testid="button-confirm-export">
              <Download className="h-4 w-4 mr-2" />
              Export
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
