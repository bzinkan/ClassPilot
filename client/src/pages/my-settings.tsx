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
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ArrowLeft, User, Settings as SettingsIcon, Save, Plus, Edit, Trash2, Plane, AlertCircle } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import type { TeacherSettings, FlightPath } from "@shared/schema";

const teacherSettingsSchema = z.object({
  maxTabsPerStudent: z.string().optional(),
  allowedDomains: z.string(),
  blockedDomains: z.string(),
  defaultFlightPathId: z.string().optional(),
});

type TeacherSettingsForm = z.infer<typeof teacherSettingsSchema>;

export default function MySettings() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  
  const [showFlightPathDialog, setShowFlightPathDialog] = useState(false);
  const [editingFlightPath, setEditingFlightPath] = useState<FlightPath | null>(null);
  const [flightPathName, setFlightPathName] = useState("");
  const [flightPathDescription, setFlightPathDescription] = useState("");
  const [flightPathAllowedDomains, setFlightPathAllowedDomains] = useState("");
  const [deleteFlightPathId, setDeleteFlightPathId] = useState<string | null>(null);

  const { data: teacherSettings, isLoading } = useQuery<TeacherSettings | null>({
    queryKey: ['/api/teacher/settings'],
  });

  const { data: flightPaths = [] } = useQuery<FlightPath[]>({
    queryKey: ['/api/flight-paths'],
  });

  const form = useForm<TeacherSettingsForm>({
    resolver: zodResolver(teacherSettingsSchema),
    defaultValues: {
      maxTabsPerStudent: "",
      allowedDomains: "",
      blockedDomains: "",
      defaultFlightPathId: "",
    },
  });

  useEffect(() => {
    if (teacherSettings) {
      form.reset({
        maxTabsPerStudent: teacherSettings.maxTabsPerStudent || "",
        allowedDomains: teacherSettings.allowedDomains?.join(", ") || "",
        blockedDomains: teacherSettings.blockedDomains?.join(", ") || "",
        defaultFlightPathId: teacherSettings.defaultFlightPathId || "",
      });
    }
  }, [teacherSettings, form]);

  const normalizeDomain = (domain: string): string => {
    return domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  };

  const resetFlightPathForm = () => {
    setFlightPathName("");
    setFlightPathDescription("");
    setFlightPathAllowedDomains("");
    setEditingFlightPath(null);
  };

  const createFlightPathMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest("POST", "/api/flight-paths", {
        flightPathName,
        description: flightPathDescription || undefined,
        allowedDomains: flightPathAllowedDomains.split(",").map(d => normalizeDomain(d)).filter(Boolean),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/flight-paths'] });
      toast({ title: "Flight Path created", description: `"${flightPathName}" has been created successfully` });
      setShowFlightPathDialog(false);
      resetFlightPathForm();
    },
    onError: (error: any) => {
      toast({ variant: "destructive", title: "Failed to create Flight Path", description: error.message });
    },
  });

  const updateFlightPathMutation = useMutation({
    mutationFn: async () => {
      if (!editingFlightPath) throw new Error("No Flight Path to update");
      return await apiRequest("PATCH", `/api/flight-paths/${editingFlightPath.id}`, {
        flightPathName,
        description: flightPathDescription || undefined,
        allowedDomains: flightPathAllowedDomains.split(",").map(d => normalizeDomain(d)).filter(Boolean),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/flight-paths'] });
      toast({ title: "Flight Path updated", description: `"${flightPathName}" has been updated successfully` });
      setShowFlightPathDialog(false);
      resetFlightPathForm();
    },
    onError: (error: any) => {
      toast({ variant: "destructive", title: "Failed to update Flight Path", description: error.message });
    },
  });

  const deleteFlightPathMutation = useMutation({
    mutationFn: async (id: string) => {
      return await apiRequest("DELETE", `/api/flight-paths/${id}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/flight-paths'] });
      toast({ title: "Flight Path deleted", description: "Flight Path has been deleted successfully" });
      setDeleteFlightPathId(null);
    },
    onError: (error: any) => {
      toast({ variant: "destructive", title: "Failed to delete Flight Path", description: error.message });
    },
  });

  const updateSettingsMutation = useMutation({
    mutationFn: async (data: TeacherSettingsForm) => {
      const payload = {
        maxTabsPerStudent: data.maxTabsPerStudent || null,
        allowedDomains: data.allowedDomains
          ? data.allowedDomains.split(",").map(d => d.trim()).filter(Boolean)
          : [],
        blockedDomains: data.blockedDomains
          ? data.blockedDomains.split(",").map(d => d.trim()).filter(Boolean)
          : [],
        defaultFlightPathId: data.defaultFlightPathId || null,
      };

      const response = await fetch('/api/teacher/settings', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        throw new Error('Failed to save settings');
      }

      return await response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/teacher/settings'] });
      toast({
        title: "Settings saved",
        description: "Your personal settings have been updated successfully.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to save settings",
        variant: "destructive",
      });
    },
  });

  const handleEditFlightPath = (flightPath: FlightPath) => {
    setEditingFlightPath(flightPath);
    setFlightPathName(flightPath.flightPathName);
    setFlightPathDescription(flightPath.description || "");
    setFlightPathAllowedDomains(flightPath.allowedDomains?.join(", ") || "");
    setShowFlightPathDialog(true);
  };

  const handleSaveFlightPath = () => {
    if (editingFlightPath) {
      updateFlightPathMutation.mutate();
    } else {
      createFlightPathMutation.mutate();
    }
  };

  const onSubmit = (data: TeacherSettingsForm) => {
    updateSettingsMutation.mutate(data);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto"></div>
          <p className="mt-4 text-muted-foreground">Loading settings...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b bg-card">
        <div className="max-w-5xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button
                data-testid="button-back"
                variant="ghost"
                size="icon"
                onClick={() => setLocation("/dashboard")}
              >
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <div className="flex items-center gap-3">
                <div className="p-2 bg-primary/10 rounded-lg">
                  <User className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold">My Settings</h1>
                  <p className="text-sm text-muted-foreground">Customize your personal teaching preferences</p>
                </div>
              </div>
            </div>
            <ThemeToggle />
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* Flight Paths Section */}
            <Card data-testid="card-flight-paths">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Plane className="h-5 w-5 text-primary" />
                    <CardTitle>My Flight Paths</CardTitle>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      resetFlightPathForm();
                      setShowFlightPathDialog(true);
                    }}
                    data-testid="button-create-flight-path"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Create Flight Path
                  </Button>
                </div>
                <CardDescription>
                  Create and manage domain restriction sets for focused learning. Flight Paths limit student browsing to specific educational websites.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {flightPaths.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Plane className="h-12 w-12 mx-auto mb-3 opacity-20" />
                    <p>No Flight Paths created yet</p>
                    <p className="text-sm mt-1">Create your first Flight Path to get started</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {flightPaths.map((fp) => (
                      <div
                        key={fp.id}
                        className="flex items-center justify-between p-4 rounded-lg border bg-card hover-elevate"
                        data-testid={`flight-path-${fp.id}`}
                      >
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="font-semibold">{fp.flightPathName}</h3>
                            {fp.teacherId && (
                              <Badge variant="secondary" className="text-xs">Personal</Badge>
                            )}
                          </div>
                          {fp.description && (
                            <p className="text-sm text-muted-foreground mb-2">{fp.description}</p>
                          )}
                          <div className="flex flex-wrap gap-1">
                            {fp.allowedDomains && fp.allowedDomains.length > 0 ? (
                              fp.allowedDomains.map((domain, idx) => (
                                <Badge key={idx} variant="outline" className="text-xs">
                                  {domain}
                                </Badge>
                              ))
                            ) : (
                              <span className="text-xs text-muted-foreground">No domains configured</span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 ml-4">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => handleEditFlightPath(fp)}
                            data-testid={`button-edit-flight-path-${fp.id}`}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => setDeleteFlightPathId(fp.id)}
                            data-testid={`button-delete-flight-path-${fp.id}`}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card data-testid="card-classroom-controls">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <SettingsIcon className="h-5 w-5 text-primary" />
                  <CardTitle>Classroom Controls</CardTitle>
                </div>
                <CardDescription>
                  Configure default settings for your classroom. These settings apply to all your students.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <FormField
                  control={form.control}
                  name="maxTabsPerStudent"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Maximum Tabs Per Student</FormLabel>
                      <FormControl>
                        <Input
                          data-testid="input-max-tabs"
                          type="number"
                          placeholder="Leave empty for no limit"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        Limit the number of browser tabs students can have open. Leave empty to allow unlimited tabs.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="defaultFlightPathId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Default Flight Path</FormLabel>
                      <Select
                        value={field.value || "none"}
                        onValueChange={(value) => field.onChange(value === "none" ? "" : value)}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-default-flight-path">
                            <SelectValue placeholder="No default Flight Path" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="none">No default Flight Path</SelectItem>
                          {flightPaths.map((fp) => (
                            <SelectItem key={fp.id} value={fp.id}>
                              {fp.flightPathName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        Automatically apply this Flight Path to students when they join your class.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="allowedDomains"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Allowed Domains</FormLabel>
                      <FormControl>
                        <Textarea
                          data-testid="textarea-allowed-domains"
                          placeholder="example.com, google.com, education.org"
                          className="min-h-[100px] font-mono text-sm"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        Comma-separated list of domains students are allowed to visit. These domains are in addition to school-wide allowed domains.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="blockedDomains"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Blocked Domains</FormLabel>
                      <FormControl>
                        <Textarea
                          data-testid="textarea-blocked-domains"
                          placeholder="facebook.com, twitter.com, instagram.com"
                          className="min-h-[100px] font-mono text-sm"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        Comma-separated list of domains to block for your students. These domains are in addition to school-wide blocked domains.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            <div className="flex justify-end gap-3">
              <Button
                data-testid="button-cancel"
                type="button"
                variant="outline"
                onClick={() => setLocation("/dashboard")}
              >
                Cancel
              </Button>
              <Button
                data-testid="button-save"
                type="submit"
                disabled={updateSettingsMutation.isPending}
              >
                <Save className="h-4 w-4 mr-2" />
                {updateSettingsMutation.isPending ? "Saving..." : "Save Settings"}
              </Button>
            </div>
          </form>
        </Form>
      </div>

      {/* Flight Path Create/Edit Dialog */}
      <Dialog open={showFlightPathDialog} onOpenChange={setShowFlightPathDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingFlightPath ? "Edit Flight Path" : "Create Flight Path"}
            </DialogTitle>
            <DialogDescription>
              {editingFlightPath 
                ? "Update the Flight Path configuration below."
                : "Define a set of allowed domains for focused student browsing."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="flight-path-name">Flight Path Name *</Label>
              <Input
                id="flight-path-name"
                data-testid="input-flight-path-name"
                value={flightPathName}
                onChange={(e) => setFlightPathName(e.target.value)}
                placeholder="e.g., Math Research, Reading Time"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="flight-path-description">Description (optional)</Label>
              <Textarea
                id="flight-path-description"
                data-testid="textarea-flight-path-description"
                value={flightPathDescription}
                onChange={(e) => setFlightPathDescription(e.target.value)}
                placeholder="Describe the purpose of this Flight Path"
                className="min-h-[80px]"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="flight-path-domains">Allowed Domains</Label>
              <Input
                id="flight-path-domains"
                data-testid="input-flight-path-domains"
                value={flightPathAllowedDomains}
                onChange={(e) => setFlightPathAllowedDomains(e.target.value)}
                placeholder="classroom.google.com, docs.google.com, khanacademy.org"
              />
              <div className="text-xs text-muted-foreground space-y-1">
                <p>Comma-separated domains. Use specific subdomains for best control.</p>
                <p className="font-medium text-primary">Google Services Examples:</p>
                <ul className="ml-3 space-y-0.5">
                  <li>• <code className="text-xs bg-muted px-1 rounded">classroom.google.com</code> - Google Classroom only</li>
                  <li>• <code className="text-xs bg-muted px-1 rounded">docs.google.com</code> - Forms, Docs, Sheets, Slides</li>
                  <li>• <code className="text-xs bg-muted px-1 rounded">drive.google.com</code> - Google Drive only</li>
                </ul>
                <p className="text-amber-600 dark:text-amber-500 pt-1 flex items-start gap-1">
                  <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                  <span>Using just <code className="text-xs bg-muted px-1 rounded">google.com</code> allows ALL Google services (YouTube, Gmail, etc.)</span>
                </p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowFlightPathDialog(false)}
              data-testid="button-cancel-flight-path"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSaveFlightPath}
              disabled={!flightPathName.trim() || 
                       createFlightPathMutation.isPending || updateFlightPathMutation.isPending}
              data-testid="button-save-flight-path"
            >
              <Save className="h-4 w-4 mr-2" />
              {editingFlightPath ? "Update Flight Path" : "Create Flight Path"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Flight Path Confirmation Dialog */}
      <Dialog open={!!deleteFlightPathId} onOpenChange={() => setDeleteFlightPathId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Flight Path?</DialogTitle>
            <DialogDescription>
              This action cannot be undone. Students currently assigned to this Flight Path will no longer have domain restrictions from it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteFlightPathId(null)}
              data-testid="button-cancel-delete-flight-path"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => deleteFlightPathId && deleteFlightPathMutation.mutate(deleteFlightPathId)}
              disabled={deleteFlightPathMutation.isPending}
              data-testid="button-confirm-delete-flight-path"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete Flight Path
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
