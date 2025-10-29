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
import { ArrowLeft, Download, Shield, Clock, AlertCircle, Layers, Plus, Pencil, Trash2, Star, Users } from "lucide-react";
import type { Settings as SettingsType, Scene, StudentGroup } from "@shared/schema";

const settingsSchema = z.object({
  schoolName: z.string().min(1, "School name is required"),
  wsSharedKey: z.string().min(8, "WebSocket key must be at least 8 characters"),
  retentionHours: z.string().min(1, "Retention period is required"),
  maxTabsPerStudent: z.string().optional(),
  blockedDomains: z.string(),
  allowedDomains: z.string(),
  ipAllowlist: z.string(),
  gradeLevels: z.string().min(1, "At least one grade level is required"),
});

type SettingsForm = z.infer<typeof settingsSchema>;

export default function Settings() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportStartDate, setExportStartDate] = useState("");
  const [exportEndDate, setExportEndDate] = useState("");
  
  // Scenes management state
  const [showSceneDialog, setShowSceneDialog] = useState(false);
  const [editingScene, setEditingScene] = useState<Scene | null>(null);
  const [sceneName, setSceneName] = useState("");
  const [sceneDescription, setSceneDescription] = useState("");
  const [sceneAllowedDomains, setSceneAllowedDomains] = useState("");
  const [sceneBlockedDomains, setSceneBlockedDomains] = useState("");
  const [deleteSceneId, setDeleteSceneId] = useState<string | null>(null);

  // Student Groups management state
  const [showGroupDialog, setShowGroupDialog] = useState(false);
  const [editingGroup, setEditingGroup] = useState<StudentGroup | null>(null);
  const [groupName, setGroupName] = useState("");
  const [groupDescription, setGroupDescription] = useState("");
  const [deleteGroupId, setDeleteGroupId] = useState<string | null>(null);

  const { data: settings, isLoading } = useQuery<SettingsType>({
    queryKey: ['/api/settings'],
  });

  const { data: scenes = [], isLoading: scenesLoading } = useQuery<Scene[]>({
    queryKey: ['/api/scenes'],
  });

  const { data: groups = [], isLoading: groupsLoading } = useQuery<StudentGroup[]>({
    queryKey: ['/api/groups'],
  });

  const form = useForm<SettingsForm>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      schoolName: settings?.schoolName || "",
      wsSharedKey: settings?.wsSharedKey || "",
      retentionHours: settings?.retentionHours || "24",
      maxTabsPerStudent: settings?.maxTabsPerStudent || "",
      blockedDomains: settings?.blockedDomains?.join(", ") || "",
      allowedDomains: settings?.allowedDomains?.join(", ") || "",
      ipAllowlist: settings?.ipAllowlist?.join(", ") || "",
      gradeLevels: settings?.gradeLevels?.join(", ") || "5th, 6th, 7th, 8th, 9th, 10th, 11th, 12th",
    },
  });

  // Update form when settings load
  useEffect(() => {
    if (settings) {
      form.reset({
        schoolName: settings.schoolName,
        wsSharedKey: settings.wsSharedKey,
        retentionHours: settings.retentionHours,
        maxTabsPerStudent: settings.maxTabsPerStudent || "",
        blockedDomains: settings.blockedDomains?.join(", ") || "",
        allowedDomains: settings.allowedDomains?.join(", ") || "",
        ipAllowlist: settings.ipAllowlist?.join(", ") || "",
        gradeLevels: settings.gradeLevels?.join(", ") || "5th, 6th, 7th, 8th, 9th, 10th, 11th, 12th",
      });
    }
  }, [settings, form]);

  const updateSettingsMutation = useMutation({
    mutationFn: async (data: SettingsForm) => {
      const gradeLevels = data.gradeLevels
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean);
      
      if (gradeLevels.length === 0) {
        throw new Error("At least one grade level is required");
      }
      
      // Use schoolId from loaded settings, or default for initial creation
      const schoolId = settings?.schoolId || "default-school";
      
      const payload = {
        schoolId,
        ...data,
        maxTabsPerStudent: data.maxTabsPerStudent || null,
        blockedDomains: data.blockedDomains
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean),
        allowedDomains: data.allowedDomains
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean),
        ipAllowlist: data.ipAllowlist
          .split(",")
          .map((ip) => ip.trim())
          .filter(Boolean),
        gradeLevels,
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

  // Scenes mutations
  const createSceneMutation = useMutation({
    mutationFn: async () => {
      const schoolId = settings?.schoolId || "default-school";
      return await apiRequest("POST", "/api/scenes", {
        schoolId,
        sceneName,
        description: sceneDescription || undefined,
        allowedDomains: sceneAllowedDomains.split(",").map(d => d.trim()).filter(Boolean),
        blockedDomains: sceneBlockedDomains.split(",").map(d => d.trim()).filter(Boolean),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/scenes'] });
      toast({ title: "Scene created", description: `"${sceneName}" has been created successfully` });
      setShowSceneDialog(false);
      resetSceneForm();
    },
    onError: (error: any) => {
      toast({ variant: "destructive", title: "Failed to create scene", description: error.message });
    },
  });

  const updateSceneMutation = useMutation({
    mutationFn: async () => {
      if (!editingScene) throw new Error("No scene to update");
      return await apiRequest("PATCH", `/api/scenes/${editingScene.id}`, {
        sceneName,
        description: sceneDescription || undefined,
        allowedDomains: sceneAllowedDomains.split(",").map(d => d.trim()).filter(Boolean),
        blockedDomains: sceneBlockedDomains.split(",").map(d => d.trim()).filter(Boolean),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/scenes'] });
      toast({ title: "Scene updated", description: `"${sceneName}" has been updated successfully` });
      setShowSceneDialog(false);
      resetSceneForm();
    },
    onError: (error: any) => {
      toast({ variant: "destructive", title: "Failed to update scene", description: error.message });
    },
  });

  const deleteSceneMutation = useMutation({
    mutationFn: async (sceneId: string) => {
      return await apiRequest("DELETE", `/api/scenes/${sceneId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/scenes'] });
      toast({ title: "Scene deleted", description: "The scene has been deleted successfully" });
      setDeleteSceneId(null);
    },
    onError: (error: any) => {
      toast({ variant: "destructive", title: "Failed to delete scene", description: error.message });
    },
  });

  const resetSceneForm = () => {
    setSceneName("");
    setSceneDescription("");
    setSceneAllowedDomains("");
    setSceneBlockedDomains("");
    setEditingScene(null);
  };

  const handleCreateScene = () => {
    resetSceneForm();
    setShowSceneDialog(true);
  };

  const handleEditScene = (scene: Scene) => {
    setEditingScene(scene);
    setSceneName(scene.sceneName);
    setSceneDescription(scene.description || "");
    setSceneAllowedDomains(scene.allowedDomains?.join(", ") || "");
    setSceneBlockedDomains(scene.blockedDomains?.join(", ") || "");
    setShowSceneDialog(true);
  };

  const handleSaveScene = () => {
    if (!sceneName.trim()) {
      toast({ variant: "destructive", title: "Scene name required", description: "Please enter a name for the scene" });
      return;
    }
    if (editingScene) {
      updateSceneMutation.mutate();
    } else {
      createSceneMutation.mutate();
    }
  };

  const handleDeleteScene = (sceneId: string) => {
    setDeleteSceneId(sceneId);
  };

  const confirmDeleteScene = () => {
    if (deleteSceneId) {
      deleteSceneMutation.mutate(deleteSceneId);
    }
  };

  // Student Groups mutations
  const createGroupMutation = useMutation({
    mutationFn: async () => {
      const schoolId = settings?.schoolId || "default-school";
      return await apiRequest("POST", "/api/groups", {
        schoolId,
        groupName,
        description: groupDescription || undefined,
        studentIds: [],
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/groups'] });
      toast({ title: "Group created", description: `"${groupName}" has been created successfully` });
      setShowGroupDialog(false);
      resetGroupForm();
    },
    onError: (error: any) => {
      toast({ variant: "destructive", title: "Failed to create group", description: error.message });
    },
  });

  const updateGroupMutation = useMutation({
    mutationFn: async () => {
      if (!editingGroup) throw new Error("No group to update");
      return await apiRequest("PATCH", `/api/groups/${editingGroup.id}`, {
        groupName,
        description: groupDescription || undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/groups'] });
      toast({ title: "Group updated", description: `"${groupName}" has been updated successfully` });
      setShowGroupDialog(false);
      resetGroupForm();
    },
    onError: (error: any) => {
      toast({ variant: "destructive", title: "Failed to update group", description: error.message });
    },
  });

  const deleteGroupMutation = useMutation({
    mutationFn: async (groupId: string) => {
      return await apiRequest("DELETE", `/api/groups/${groupId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/groups'] });
      toast({ title: "Group deleted", description: "The group has been deleted successfully" });
      setDeleteGroupId(null);
    },
    onError: (error: any) => {
      toast({ variant: "destructive", title: "Failed to delete group", description: error.message });
    },
  });

  const resetGroupForm = () => {
    setGroupName("");
    setGroupDescription("");
    setEditingGroup(null);
  };

  const handleCreateGroup = () => {
    resetGroupForm();
    setShowGroupDialog(true);
  };

  const handleEditGroup = (group: StudentGroup) => {
    setEditingGroup(group);
    setGroupName(group.groupName);
    setGroupDescription(group.description || "");
    setShowGroupDialog(true);
  };

  const handleSaveGroup = () => {
    if (!groupName.trim()) {
      toast({ variant: "destructive", title: "Group name required", description: "Please enter a name for the group" });
      return;
    }
    if (editingGroup) {
      updateGroupMutation.mutate();
    } else {
      createGroupMutation.mutate();
    }
  };

  const handleDeleteGroup = (groupId: string) => {
    setDeleteGroupId(groupId);
  };

  const confirmDeleteGroup = () => {
    if (deleteGroupId) {
      deleteGroupMutation.mutate(deleteGroupId);
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
                <Label htmlFor="maxTabsPerStudent">Maximum Tabs Per Student</Label>
                <Input
                  id="maxTabsPerStudent"
                  data-testid="input-max-tabs"
                  type="number"
                  {...form.register("maxTabsPerStudent")}
                  placeholder="Leave empty for unlimited"
                />
                {form.formState.errors.maxTabsPerStudent && (
                  <p className="text-sm text-destructive">
                    {form.formState.errors.maxTabsPerStudent.message}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Limit the number of tabs students can have open. Leave empty for unlimited tabs.
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
                <Label htmlFor="allowedDomains">Allowed Websites (comma-separated)</Label>
                <Input
                  id="allowedDomains"
                  data-testid="input-allowed-domains"
                  {...form.register("allowedDomains")}
                  placeholder="classroom.google.com, kahoot.com"
                />
                <p className="text-xs text-muted-foreground">
                  Students navigating away from these websites will be marked as off-task. Leave empty to disable this feature.
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

              <div className="space-y-2">
                <Label htmlFor="gradeLevels">Grade Levels (comma-separated)</Label>
                <Input
                  id="gradeLevels"
                  data-testid="input-grade-levels"
                  {...form.register("gradeLevels")}
                  placeholder="5th, 6th, 7th, 8th, 9th, 10th, 11th, 12th"
                />
                <p className="text-xs text-muted-foreground">
                  These grade levels will appear as filter tabs on the dashboard. Customize based on your school's grade structure.
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

        {/* Scenes Management */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers className="h-5 w-5" />
                Scenes Management
              </div>
              <Button
                size="sm"
                onClick={handleCreateScene}
                data-testid="button-create-scene"
              >
                <Plus className="h-4 w-4 mr-2" />
                Create Scene
              </Button>
            </CardTitle>
            <CardDescription>
              Create browsing environments with allowed/blocked websites for different activities
            </CardDescription>
          </CardHeader>
          <CardContent>
            {scenesLoading ? (
              <div className="text-center py-8">
                <div className="h-6 w-6 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
                <p className="text-sm text-muted-foreground">Loading scenes...</p>
              </div>
            ) : scenes.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Layers className="h-12 w-12 mx-auto mb-3 opacity-20" />
                <p className="text-sm">No scenes created yet</p>
                <p className="text-xs mt-1">Create a scene to get started</p>
              </div>
            ) : (
              <div className="space-y-3">
                {scenes.map((scene) => (
                  <div
                    key={scene.id}
                    className="border rounded-lg p-4 space-y-2 hover-elevate"
                    data-testid={`scene-card-${scene.id}`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <h4 className="font-medium">{scene.sceneName}</h4>
                          {scene.isDefault && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-primary/10 text-primary">
                              <Star className="h-3 w-3 mr-1" />
                              Default
                            </span>
                          )}
                        </div>
                        {scene.description && (
                          <p className="text-sm text-muted-foreground mt-1">{scene.description}</p>
                        )}
                        <div className="mt-2 space-y-1 text-xs">
                          {scene.allowedDomains && scene.allowedDomains.length > 0 && (
                            <div className="flex items-start gap-2">
                              <span className="text-green-600 dark:text-green-400 font-medium shrink-0">Allowed:</span>
                              <span className="text-muted-foreground">{scene.allowedDomains.join(", ")}</span>
                            </div>
                          )}
                          {scene.blockedDomains && scene.blockedDomains.length > 0 && (
                            <div className="flex items-start gap-2">
                              <span className="text-red-600 dark:text-red-400 font-medium shrink-0">Blocked:</span>
                              <span className="text-muted-foreground">{scene.blockedDomains.join(", ")}</span>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 ml-4">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleEditScene(scene)}
                          data-testid={`button-edit-scene-${scene.id}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleDeleteScene(scene.id)}
                          data-testid={`button-delete-scene-${scene.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Student Groups Management */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                Student Groups
              </div>
              <Button
                size="sm"
                onClick={handleCreateGroup}
                data-testid="button-create-group"
              >
                <Plus className="h-4 w-4 mr-2" />
                Create Group
              </Button>
            </CardTitle>
            <CardDescription>
              Organize students into groups for differentiated instruction and targeted interventions
            </CardDescription>
          </CardHeader>
          <CardContent>
            {groupsLoading ? (
              <div className="text-center py-8">
                <div className="h-6 w-6 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
                <p className="text-sm text-muted-foreground">Loading groups...</p>
              </div>
            ) : groups.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Users className="h-12 w-12 mx-auto mb-3 opacity-20" />
                <p className="text-sm">No groups created yet</p>
                <p className="text-xs mt-1">Create a group to organize students</p>
              </div>
            ) : (
              <div className="space-y-3">
                {groups.map((group) => (
                  <div
                    key={group.id}
                    className="border rounded-lg p-4 space-y-2 hover-elevate"
                    data-testid={`group-card-${group.id}`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <h4 className="font-medium">{group.groupName}</h4>
                        {group.description && (
                          <p className="text-sm text-muted-foreground mt-1">{group.description}</p>
                        )}
                        <div className="mt-2">
                          <span className="text-xs text-muted-foreground">
                            {group.studentIds?.length || 0} student{(group.studentIds?.length || 0) !== 1 ? 's' : ''}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 ml-4">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleEditGroup(group)}
                          data-testid={`button-edit-group-${group.id}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleDeleteGroup(group.id)}
                          data-testid={`button-delete-group-${group.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
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

      {/* Scene Create/Edit Dialog */}
      <Dialog open={showSceneDialog} onOpenChange={setShowSceneDialog}>
        <DialogContent data-testid="dialog-scene-form">
          <DialogHeader>
            <DialogTitle>{editingScene ? "Edit Scene" : "Create New Scene"}</DialogTitle>
            <DialogDescription>
              {editingScene ? "Update the scene configuration" : "Create a browsing environment with allowed or blocked websites"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="scene-name">Scene Name *</Label>
              <Input
                id="scene-name"
                value={sceneName}
                onChange={(e) => setSceneName(e.target.value)}
                placeholder="e.g., Research Time, Math Practice, Reading"
                data-testid="input-scene-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="scene-description">Description</Label>
              <Input
                id="scene-description"
                value={sceneDescription}
                onChange={(e) => setSceneDescription(e.target.value)}
                placeholder="Optional description of this scene"
                data-testid="input-scene-description"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="scene-allowed">Allowed Domains</Label>
              <Input
                id="scene-allowed"
                value={sceneAllowedDomains}
                onChange={(e) => setSceneAllowedDomains(e.target.value)}
                placeholder="example.com, google.com, wikipedia.org"
                data-testid="input-scene-allowed-domains"
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated list of allowed domains. Students can only visit these sites.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="scene-blocked">Blocked Domains</Label>
              <Input
                id="scene-blocked"
                value={sceneBlockedDomains}
                onChange={(e) => setSceneBlockedDomains(e.target.value)}
                placeholder="facebook.com, youtube.com, games.com"
                data-testid="input-scene-blocked-domains"
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated list of blocked domains. Students cannot visit these sites.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => setShowSceneDialog(false)}
              data-testid="button-cancel-scene"
            >
              Cancel
            </Button>
            <Button 
              onClick={handleSaveScene}
              disabled={createSceneMutation.isPending || updateSceneMutation.isPending}
              data-testid="button-save-scene"
            >
              {createSceneMutation.isPending || updateSceneMutation.isPending ? "Saving..." : (editingScene ? "Update Scene" : "Create Scene")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Scene Confirmation Dialog */}
      <Dialog open={deleteSceneId !== null} onOpenChange={(open) => !open && setDeleteSceneId(null)}>
        <DialogContent data-testid="dialog-delete-scene">
          <DialogHeader>
            <DialogTitle>Delete Scene</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this scene? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => setDeleteSceneId(null)}
              data-testid="button-cancel-delete-scene"
            >
              Cancel
            </Button>
            <Button 
              variant="destructive" 
              onClick={confirmDeleteScene}
              disabled={deleteSceneMutation.isPending}
              data-testid="button-confirm-delete-scene"
            >
              {deleteSceneMutation.isPending ? "Deleting..." : "Delete Scene"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Group Create/Edit Dialog */}
      <Dialog open={showGroupDialog} onOpenChange={setShowGroupDialog}>
        <DialogContent data-testid="dialog-group-form">
          <DialogHeader>
            <DialogTitle>{editingGroup ? "Edit Group" : "Create New Group"}</DialogTitle>
            <DialogDescription>
              {editingGroup ? "Update the group information" : "Create a new student group for organizing your class"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="group-name">Group Name *</Label>
              <Input
                id="group-name"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="e.g., Advanced Readers, Math Support, Project Team A"
                data-testid="input-group-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="group-description">Description</Label>
              <Input
                id="group-description"
                value={groupDescription}
                onChange={(e) => setGroupDescription(e.target.value)}
                placeholder="Optional description of this group"
                data-testid="input-group-description"
              />
            </div>
          </div>
          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => setShowGroupDialog(false)}
              data-testid="button-cancel-group"
            >
              Cancel
            </Button>
            <Button 
              onClick={handleSaveGroup}
              disabled={createGroupMutation.isPending || updateGroupMutation.isPending}
              data-testid="button-save-group"
            >
              {createGroupMutation.isPending || updateGroupMutation.isPending ? "Saving..." : (editingGroup ? "Update Group" : "Create Group")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Group Confirmation Dialog */}
      <Dialog open={deleteGroupId !== null} onOpenChange={(open) => !open && setDeleteGroupId(null)}>
        <DialogContent data-testid="dialog-delete-group">
          <DialogHeader>
            <DialogTitle>Delete Group</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this group? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => setDeleteGroupId(null)}
              data-testid="button-cancel-delete-group"
            >
              Cancel
            </Button>
            <Button 
              variant="destructive" 
              onClick={confirmDeleteGroup}
              disabled={deleteGroupMutation.isPending}
              data-testid="button-confirm-delete-group"
            >
              {deleteGroupMutation.isPending ? "Deleting..." : "Delete Group"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
