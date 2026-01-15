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
import { ArrowLeft, User, Settings as SettingsIcon, Save, Plus, Edit, Trash2, Plane, AlertCircle, ShieldBan, UsersRound, UserPlus, UserMinus } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import type { TeacherSettings, FlightPath, BlockList, Group, Subgroup, Student } from "@shared/schema";

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

  // Block Lists state
  const [showBlockListDialog, setShowBlockListDialog] = useState(false);
  const [editingBlockList, setEditingBlockList] = useState<BlockList | null>(null);
  const [blockListName, setBlockListName] = useState("");
  const [blockListDescription, setBlockListDescription] = useState("");
  const [blockListDomains, setBlockListDomains] = useState("");
  const [deleteBlockListId, setDeleteBlockListId] = useState<string | null>(null);

  // Subgroups state
  const [selectedGroupId, setSelectedGroupId] = useState<string>("");
  const [showSubgroupDialog, setShowSubgroupDialog] = useState(false);
  const [editingSubgroup, setEditingSubgroup] = useState<Subgroup | null>(null);
  const [subgroupName, setSubgroupName] = useState("");
  const [subgroupColor, setSubgroupColor] = useState("#9333ea");
  const [deleteSubgroupId, setDeleteSubgroupId] = useState<string | null>(null);
  const [showManageMembersDialog, setShowManageMembersDialog] = useState(false);
  const [managingSubgroup, setManagingSubgroup] = useState<Subgroup | null>(null);
  const [subgroupMembers, setSubgroupMembers] = useState<string[]>([]);

  const { data: teacherSettings, isLoading } = useQuery<TeacherSettings | null>({
    queryKey: ['/api/teacher/settings'],
  });

  const { data: flightPaths = [] } = useQuery<FlightPath[]>({
    queryKey: ['/api/flight-paths'],
  });

  const { data: blockLists = [] } = useQuery<BlockList[]>({
    queryKey: ['/api/block-lists'],
  });

  const { data: groups = [] } = useQuery<Group[]>({
    queryKey: ['/api/teacher/groups'],
  });

  const { data: subgroups = [], refetch: refetchSubgroups } = useQuery<Subgroup[]>({
    queryKey: ['/api/groups', selectedGroupId, 'subgroups'],
    queryFn: async () => {
      if (!selectedGroupId) return [];
      const res = await apiRequest('GET', `/api/groups/${selectedGroupId}/subgroups`);
      const data = await res.json();
      return data.subgroups || [];
    },
    enabled: !!selectedGroupId,
  });

  const { data: groupStudents = [] } = useQuery<Student[]>({
    queryKey: ['/api/groups', selectedGroupId, 'students'],
    queryFn: async () => {
      if (!selectedGroupId) return [];
      const res = await apiRequest('GET', `/api/groups/${selectedGroupId}/students`);
      return res.json();
    },
    enabled: !!selectedGroupId,
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

  // Block List mutations
  const resetBlockListForm = () => {
    setBlockListName("");
    setBlockListDescription("");
    setBlockListDomains("");
    setEditingBlockList(null);
  };

  const createBlockListMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest("POST", "/api/block-lists", {
        name: blockListName,
        description: blockListDescription || undefined,
        blockedDomains: blockListDomains.split(",").map(d => normalizeDomain(d)).filter(Boolean),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/block-lists'] });
      toast({ title: "Block List created", description: `"${blockListName}" has been created successfully` });
      setShowBlockListDialog(false);
      resetBlockListForm();
    },
    onError: (error: any) => {
      toast({ variant: "destructive", title: "Failed to create Block List", description: error.message });
    },
  });

  const updateBlockListMutation = useMutation({
    mutationFn: async () => {
      if (!editingBlockList) throw new Error("No Block List to update");
      return await apiRequest("PATCH", `/api/block-lists/${editingBlockList.id}`, {
        name: blockListName,
        description: blockListDescription || undefined,
        blockedDomains: blockListDomains.split(",").map(d => normalizeDomain(d)).filter(Boolean),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/block-lists'] });
      toast({ title: "Block List updated", description: `"${blockListName}" has been updated successfully` });
      setShowBlockListDialog(false);
      resetBlockListForm();
    },
    onError: (error: any) => {
      toast({ variant: "destructive", title: "Failed to update Block List", description: error.message });
    },
  });

  const deleteBlockListMutation = useMutation({
    mutationFn: async (id: string) => {
      return await apiRequest("DELETE", `/api/block-lists/${id}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/block-lists'] });
      toast({ title: "Block List deleted", description: "Block List has been deleted successfully" });
      setDeleteBlockListId(null);
    },
    onError: (error: any) => {
      toast({ variant: "destructive", title: "Failed to delete Block List", description: error.message });
    },
  });

  const handleEditBlockList = (blockList: BlockList) => {
    setEditingBlockList(blockList);
    setBlockListName(blockList.name);
    setBlockListDescription(blockList.description || "");
    setBlockListDomains(blockList.blockedDomains?.join(", ") || "");
    setShowBlockListDialog(true);
  };

  const handleSaveBlockList = () => {
    if (editingBlockList) {
      updateBlockListMutation.mutate();
    } else {
      createBlockListMutation.mutate();
    }
  };

  // Subgroup mutations
  const createSubgroupMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest("POST", `/api/groups/${selectedGroupId}/subgroups`, {
        name: subgroupName,
        color: subgroupColor,
      });
    },
    onSuccess: () => {
      refetchSubgroups();
      toast({ title: "Subgroup created", description: `${subgroupName} has been created successfully` });
      resetSubgroupForm();
      setShowSubgroupDialog(false);
    },
    onError: (error: any) => {
      toast({ variant: "destructive", title: "Failed to create subgroup", description: error.message });
    },
  });

  const updateSubgroupMutation = useMutation({
    mutationFn: async () => {
      if (!editingSubgroup) return;
      return await apiRequest("PUT", `/api/subgroups/${editingSubgroup.id}`, {
        name: subgroupName,
        color: subgroupColor,
      });
    },
    onSuccess: () => {
      refetchSubgroups();
      toast({ title: "Subgroup updated", description: `${subgroupName} has been updated successfully` });
      resetSubgroupForm();
      setShowSubgroupDialog(false);
    },
    onError: (error: any) => {
      toast({ variant: "destructive", title: "Failed to update subgroup", description: error.message });
    },
  });

  const deleteSubgroupMutation = useMutation({
    mutationFn: async (id: string) => {
      return await apiRequest("DELETE", `/api/subgroups/${id}`, {});
    },
    onSuccess: () => {
      refetchSubgroups();
      toast({ title: "Subgroup deleted", description: "Subgroup has been deleted successfully" });
      setDeleteSubgroupId(null);
    },
    onError: (error: any) => {
      toast({ variant: "destructive", title: "Failed to delete subgroup", description: error.message });
    },
  });

  const addSubgroupMemberMutation = useMutation({
    mutationFn: async ({ subgroupId, studentId }: { subgroupId: string; studentId: string }) => {
      return await apiRequest("POST", `/api/subgroups/${subgroupId}/members`, { studentIds: [studentId] });
    },
    onSuccess: () => {
      if (managingSubgroup) {
        fetchSubgroupMembers(managingSubgroup.id);
      }
      toast({ title: "Student added", description: "Student has been added to the subgroup" });
    },
    onError: (error: any) => {
      toast({ variant: "destructive", title: "Failed to add student", description: error.message });
    },
  });

  const removeSubgroupMemberMutation = useMutation({
    mutationFn: async ({ subgroupId, studentId }: { subgroupId: string; studentId: string }) => {
      return await apiRequest("DELETE", `/api/subgroups/${subgroupId}/members/${studentId}`, {});
    },
    onSuccess: () => {
      if (managingSubgroup) {
        fetchSubgroupMembers(managingSubgroup.id);
      }
      toast({ title: "Student removed", description: "Student has been removed from the subgroup" });
    },
    onError: (error: any) => {
      toast({ variant: "destructive", title: "Failed to remove student", description: error.message });
    },
  });

  const resetSubgroupForm = () => {
    setSubgroupName("");
    setSubgroupColor("#9333ea");
    setEditingSubgroup(null);
  };

  const handleEditSubgroup = (subgroup: Subgroup) => {
    setEditingSubgroup(subgroup);
    setSubgroupName(subgroup.name);
    setSubgroupColor(subgroup.color || "#9333ea");
    setShowSubgroupDialog(true);
  };

  const handleSaveSubgroup = () => {
    if (editingSubgroup) {
      updateSubgroupMutation.mutate();
    } else {
      createSubgroupMutation.mutate();
    }
  };

  const handleManageMembers = async (subgroup: Subgroup) => {
    setManagingSubgroup(subgroup);
    await fetchSubgroupMembers(subgroup.id);
    setShowManageMembersDialog(true);
  };

  const fetchSubgroupMembers = async (subgroupId: string) => {
    try {
      const res = await apiRequest("GET", `/api/subgroups/${subgroupId}/members`);
      const data = await res.json();
      setSubgroupMembers(data.members || []);
    } catch (err) {
      console.error("Error fetching subgroup members:", err);
      setSubgroupMembers([]);
    }
  };

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

      return await apiRequest("POST", "/api/teacher/settings", payload);
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

            {/* Block Lists Section */}
            <Card data-testid="card-block-lists">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ShieldBan className="h-5 w-5 text-destructive" />
                    <CardTitle>My Block Lists</CardTitle>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      resetBlockListForm();
                      setShowBlockListDialog(true);
                    }}
                    data-testid="button-create-block-list"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Create Block List
                  </Button>
                </div>
                <CardDescription>
                  Create lists of blocked websites to prevent students from accessing distracting or inappropriate sites during class. Apply block lists from the dashboard during active sessions.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {blockLists.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <ShieldBan className="h-12 w-12 mx-auto mb-3 opacity-20" />
                    <p>No Block Lists created yet</p>
                    <p className="text-sm mt-1">Create a Block List to restrict student access to specific sites</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {blockLists.map((bl) => (
                      <div
                        key={bl.id}
                        className="flex items-center justify-between p-4 rounded-lg border bg-card hover-elevate"
                        data-testid={`block-list-${bl.id}`}
                      >
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="font-semibold">{bl.name}</h3>
                            {bl.isDefault && (
                              <Badge variant="secondary" className="text-xs">Default</Badge>
                            )}
                          </div>
                          {bl.description && (
                            <p className="text-sm text-muted-foreground mb-2">{bl.description}</p>
                          )}
                          <div className="flex flex-wrap gap-1">
                            {bl.blockedDomains && bl.blockedDomains.length > 0 ? (
                              bl.blockedDomains.map((domain, idx) => (
                                <Badge key={idx} variant="destructive" className="text-xs">
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
                            onClick={() => handleEditBlockList(bl)}
                            data-testid={`button-edit-block-list-${bl.id}`}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => setDeleteBlockListId(bl.id)}
                            data-testid={`button-delete-block-list-${bl.id}`}
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

            {/* Subgroups Section */}
            <Card data-testid="card-subgroups">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <UsersRound className="h-5 w-5 text-pink-500" />
                  <CardTitle>Class Subgroups</CardTitle>
                </div>
                <CardDescription>
                  Create subgroups within your classes for differentiated instruction. Filter and apply actions to specific subgroups from the dashboard.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Group Selector */}
                <div className="space-y-2">
                  <Label>Select Class</Label>
                  <Select value={selectedGroupId} onValueChange={setSelectedGroupId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a class to manage subgroups" />
                    </SelectTrigger>
                    <SelectContent>
                      {groups.map((group) => (
                        <SelectItem key={group.id} value={group.id}>
                          {group.name}
                        </SelectItem>
                      ))}
                      {groups.length === 0 && (
                        <div className="p-2 text-sm text-muted-foreground">
                          No classes available. Create a class first.
                        </div>
                      )}
                    </SelectContent>
                  </Select>
                </div>

                {selectedGroupId && (
                  <>
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">Subgroups</p>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          resetSubgroupForm();
                          setShowSubgroupDialog(true);
                        }}
                        data-testid="button-create-subgroup"
                      >
                        <Plus className="h-4 w-4 mr-2" />
                        Create Subgroup
                      </Button>
                    </div>

                    {subgroups.length === 0 ? (
                      <div className="text-center py-6 text-muted-foreground">
                        <UsersRound className="h-10 w-10 mx-auto mb-2 opacity-20" />
                        <p>No subgroups yet</p>
                        <p className="text-sm">Create subgroups to organize students</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {subgroups.map((sg) => (
                          <div
                            key={sg.id}
                            className="flex items-center justify-between p-3 rounded-lg border bg-card"
                            data-testid={`subgroup-${sg.id}`}
                          >
                            <div className="flex items-center gap-3">
                              <div
                                className="w-4 h-4 rounded-full"
                                style={{ backgroundColor: sg.color || '#9333ea' }}
                              />
                              <span className="font-medium">{sg.name}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => handleManageMembers(sg)}
                                data-testid={`button-manage-members-${sg.id}`}
                              >
                                <UserPlus className="h-4 w-4 mr-1" />
                                Members
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => handleEditSubgroup(sg)}
                                data-testid={`button-edit-subgroup-${sg.id}`}
                              >
                                <Edit className="h-4 w-4" />
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => setDeleteSubgroupId(sg.id)}
                                data-testid={`button-delete-subgroup-${sg.id}`}
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
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

      {/* Block List Create/Edit Dialog */}
      <Dialog open={showBlockListDialog} onOpenChange={setShowBlockListDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingBlockList ? "Edit Block List" : "Create Block List"}
            </DialogTitle>
            <DialogDescription>
              {editingBlockList
                ? "Update the Block List configuration below."
                : "Define a set of blocked domains to restrict student access during class."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="block-list-name">Block List Name *</Label>
              <Input
                id="block-list-name"
                data-testid="input-block-list-name"
                value={blockListName}
                onChange={(e) => setBlockListName(e.target.value)}
                placeholder="e.g., AI Tools, Social Media, Gaming Sites"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="block-list-description">Description (optional)</Label>
              <Textarea
                id="block-list-description"
                data-testid="textarea-block-list-description"
                value={blockListDescription}
                onChange={(e) => setBlockListDescription(e.target.value)}
                placeholder="Describe the purpose of this Block List"
                className="min-h-[80px]"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="block-list-domains">Blocked Domains *</Label>
              <Input
                id="block-list-domains"
                data-testid="input-block-list-domains"
                value={blockListDomains}
                onChange={(e) => setBlockListDomains(e.target.value)}
                placeholder="lens.google.com, chat.openai.com, quillbot.com"
              />
              <div className="text-xs text-muted-foreground space-y-1">
                <p>Comma-separated domains. Students will be blocked from accessing these sites.</p>
                <p className="font-medium text-destructive">Common Block Examples:</p>
                <ul className="ml-3 space-y-0.5">
                  <li>• <code className="text-xs bg-muted px-1 rounded">lens.google.com</code> - Google Lens (image search/AI)</li>
                  <li>• <code className="text-xs bg-muted px-1 rounded">chat.openai.com</code> - ChatGPT</li>
                  <li>• <code className="text-xs bg-muted px-1 rounded">quillbot.com</code> - QuillBot AI writing</li>
                  <li>• <code className="text-xs bg-muted px-1 rounded">discord.com</code> - Discord</li>
                </ul>
                <p className="text-amber-600 dark:text-amber-500 pt-1 flex items-start gap-1">
                  <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                  <span>Admin-level blocks always take precedence over teacher block lists.</span>
                </p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowBlockListDialog(false)}
              data-testid="button-cancel-block-list"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSaveBlockList}
              disabled={!blockListName.trim() || !blockListDomains.trim() ||
                       createBlockListMutation.isPending || updateBlockListMutation.isPending}
              data-testid="button-save-block-list"
            >
              <Save className="h-4 w-4 mr-2" />
              {editingBlockList ? "Update Block List" : "Create Block List"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Block List Confirmation Dialog */}
      <Dialog open={!!deleteBlockListId} onOpenChange={() => setDeleteBlockListId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Block List?</DialogTitle>
            <DialogDescription>
              This action cannot be undone. If this block list is currently applied to students, it will be removed from their session.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteBlockListId(null)}
              data-testid="button-cancel-delete-block-list"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => deleteBlockListId && deleteBlockListMutation.mutate(deleteBlockListId)}
              disabled={deleteBlockListMutation.isPending}
              data-testid="button-confirm-delete-block-list"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete Block List
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create/Edit Subgroup Dialog */}
      <Dialog open={showSubgroupDialog} onOpenChange={(open) => { if (!open) resetSubgroupForm(); setShowSubgroupDialog(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingSubgroup ? "Edit Subgroup" : "Create Subgroup"}</DialogTitle>
            <DialogDescription>
              {editingSubgroup ? "Update this subgroup's details" : "Create a new subgroup for differentiated instruction"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="subgroup-name">Subgroup Name</Label>
              <Input
                id="subgroup-name"
                value={subgroupName}
                onChange={(e) => setSubgroupName(e.target.value)}
                placeholder="e.g., Reading Group A"
                data-testid="input-subgroup-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="subgroup-color">Color</Label>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  id="subgroup-color"
                  value={subgroupColor}
                  onChange={(e) => setSubgroupColor(e.target.value)}
                  className="w-12 h-10 rounded cursor-pointer"
                  data-testid="input-subgroup-color"
                />
                <div className="flex gap-2">
                  {['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899'].map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={`w-8 h-8 rounded-full border-2 ${subgroupColor === color ? 'border-foreground' : 'border-transparent'}`}
                      style={{ backgroundColor: color }}
                      onClick={() => setSubgroupColor(color)}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => { resetSubgroupForm(); setShowSubgroupDialog(false); }}
              data-testid="button-cancel-subgroup"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSaveSubgroup}
              disabled={createSubgroupMutation.isPending || updateSubgroupMutation.isPending || !subgroupName.trim()}
              data-testid="button-save-subgroup"
            >
              <Save className="h-4 w-4 mr-2" />
              {editingSubgroup ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Subgroup Confirmation Dialog */}
      <Dialog open={!!deleteSubgroupId} onOpenChange={() => setDeleteSubgroupId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Subgroup?</DialogTitle>
            <DialogDescription>
              This will remove the subgroup and all member assignments. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteSubgroupId(null)}
              data-testid="button-cancel-delete-subgroup"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => deleteSubgroupId && deleteSubgroupMutation.mutate(deleteSubgroupId)}
              disabled={deleteSubgroupMutation.isPending}
              data-testid="button-confirm-delete-subgroup"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete Subgroup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manage Subgroup Members Dialog */}
      <Dialog open={showManageMembersDialog} onOpenChange={(open) => { if (!open) { setManagingSubgroup(null); setSubgroupMembers([]); } setShowManageMembersDialog(open); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              <div className="flex items-center gap-2">
                <div
                  className="w-4 h-4 rounded-full"
                  style={{ backgroundColor: managingSubgroup?.color || '#9333ea' }}
                />
                {managingSubgroup?.name} - Members
              </div>
            </DialogTitle>
            <DialogDescription>
              Add or remove students from this subgroup
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[400px] overflow-y-auto space-y-2 py-4">
            {groupStudents.length === 0 ? (
              <p className="text-center text-muted-foreground py-4">No students in this class</p>
            ) : (
              groupStudents.map((student) => {
                const isMember = subgroupMembers.includes(student.id);
                return (
                  <div
                    key={student.id}
                    className="flex items-center justify-between p-3 rounded-lg border"
                    data-testid={`member-row-${student.id}`}
                  >
                    <div>
                      <p className="font-medium">{student.studentName || student.id}</p>
                      <p className="text-xs text-muted-foreground">{student.studentEmail}</p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant={isMember ? "destructive" : "outline"}
                      onClick={() => {
                        if (isMember && managingSubgroup) {
                          removeSubgroupMemberMutation.mutate({ subgroupId: managingSubgroup.id, studentId: student.id });
                        } else if (managingSubgroup) {
                          addSubgroupMemberMutation.mutate({ subgroupId: managingSubgroup.id, studentId: student.id });
                        }
                      }}
                      disabled={addSubgroupMemberMutation.isPending || removeSubgroupMemberMutation.isPending}
                      data-testid={`button-toggle-member-${student.id}`}
                    >
                      {isMember ? (
                        <>
                          <UserMinus className="h-4 w-4 mr-1" />
                          Remove
                        </>
                      ) : (
                        <>
                          <UserPlus className="h-4 w-4 mr-1" />
                          Add
                        </>
                      )}
                    </Button>
                  </div>
                );
              })
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => setShowManageMembersDialog(false)} data-testid="button-close-members">
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
