import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Trash2, UserPlus, Users, ArrowLeft, AlertTriangle, Clock, Settings as SettingsIcon, Key, FileText, ChevronLeft, ChevronRight, BarChart3, LogOut } from "lucide-react";
import { useLocation } from "wouter";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import type { Settings, Session, Group, AuditLog } from "@shared/schema";

// Helper to normalize grade levels (strip "th", "rd", "st", "nd" suffixes)
function normalizeGrade(grade: string | null | undefined): string | null {
  if (!grade) return null;
  const trimmed = grade.trim();
  if (!trimmed) return null;
  // Remove ordinal suffixes (1st, 2nd, 3rd, 4th, etc.)
  return trimmed.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');
}

const createStaffSchema = z.object({
  name: z.string().optional(),
  email: z.string().email("Invalid email address"),
  role: z.enum(["teacher", "school_admin"]),
  password: z.string().optional(),
});

type CreateStaffForm = z.infer<typeof createStaffSchema>;

interface StaffUser {
  id: string;
  email: string;
  displayName?: string | null;
  role: "teacher" | "school_admin";
  schoolName?: string | null;
}

interface CurrentUser {
  id: string;
  username: string;
  role: string;
  schoolName: string;
}

interface StaffResponse {
  users: StaffUser[];
}

export default function Admin() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [staffToDelete, setStaffToDelete] = useState<StaffUser | null>(null);
  const [cleanupDialogOpen, setCleanupDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [staffToEdit, setStaffToEdit] = useState<StaffUser | null>(null);
  const [selectedRole, setSelectedRole] = useState<"teacher" | "school_admin">("teacher");
  const [editName, setEditName] = useState("");
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [staffToResetPassword, setStaffToResetPassword] = useState<StaffUser | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [enableTrackingHours, setEnableTrackingHours] = useState(false);
  const [trackingStartTime, setTrackingStartTime] = useState("08:00");
  const [trackingEndTime, setTrackingEndTime] = useState("15:00");
  const [schoolTimezone, setSchoolTimezone] = useState("America/New_York");
  const [trackingDays, setTrackingDays] = useState<string[]>(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]);
  const [afterHoursMode, setAfterHoursMode] = useState<"off" | "limited" | "full">("off");
  const [initialAfterHoursMode, setInitialAfterHoursMode] = useState<"off" | "limited" | "full">("off");
  const [afterHoursConfirmOpen, setAfterHoursConfirmOpen] = useState(false);
  const [tracking247ConfirmOpen, setTracking247ConfirmOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"staff" | "audit">("staff");
  const [auditPage, setAuditPage] = useState(0);
  const [auditActionFilter, setAuditActionFilter] = useState<string>("");

  const form = useForm<CreateStaffForm>({
    resolver: zodResolver(createStaffSchema),
    defaultValues: {
      name: "",
      email: "",
      role: "teacher",
      password: "",
    },
  });

  const { data: staffData, isLoading } = useQuery<StaffResponse>({
    queryKey: ["/api/admin/users"],
  });

  const { data: currentUserData } = useQuery<{ success: boolean; user: CurrentUser }>({
    queryKey: ["/api/me"],
  });
  const currentUser = currentUserData?.user;

  const { data: settings } = useQuery<Settings>({
    queryKey: ["/api/settings"],
  });

  const { data: activeSessions = [] } = useQuery<Session[]>({
    queryKey: ["/api/sessions/all"],
    refetchInterval: 10000, // Poll every 10 seconds
  });

  const { data: allGroups = [] } = useQuery<Group[]>({
    queryKey: ["/api/teacher/groups"],
  });

  // Audit logs query
  const { data: auditLogsData, isLoading: auditLogsLoading } = useQuery<{ logs: AuditLog[]; total: number }>({
    queryKey: ["/api/admin/audit-logs", auditPage, auditActionFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("limit", "20");
      params.set("offset", String(auditPage * 20));
      if (auditActionFilter) params.set("action", auditActionFilter);
      const res = await apiRequest("GET", `/api/admin/audit-logs?${params.toString()}`);
      return res.json();
    },
    enabled: activeTab === "audit",
  });

  const getFriendlyErrorMessage = (error: unknown) => {
    if (!error) return "";
    const message = error instanceof Error ? error.message : String(error);
    const jsonMatch = message.match(/\{.*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.error) {
          return parsed.error as string;
        }
      } catch {
        return message;
      }
    }
    return message;
  };

  const createStaffMutation = useMutation({
    mutationFn: async (data: CreateStaffForm) => {
      const payload = {
        email: data.email,
        role: data.role,
        name: data.name?.trim() ? data.name.trim() : undefined,
        password: data.password?.trim() ? data.password : null,
      };
      return await apiRequest("POST", "/api/admin/users", payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/teachers"] });
      form.reset();
      toast({
        title: "Staff member added",
        description: "The staff account has been created successfully.",
      });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to add staff",
        description: error.message || "An error occurred",
      });
    },
  });

  const deleteStaffMutation = useMutation({
    mutationFn: async (id: string) => {
      return await apiRequest("DELETE", `/api/admin/users/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/teachers"] });
      toast({
        title: "Staff account deleted",
        description: "The staff account has been deleted successfully.",
      });
      setDeleteDialogOpen(false);
      setStaffToDelete(null);
    },
    onError: (error: any) => {
      const message = getFriendlyErrorMessage(error);
      if (message.includes("last school admin")) {
        toast({
          title: "Action blocked",
          description: message,
        });
        return;
      }
      toast({
        variant: "destructive",
        title: "Failed to delete staff",
        description: message || "An error occurred",
      });
    },
  });

  const updateStaffMutation = useMutation({
    mutationFn: async (payload: { userId: string; role: "teacher" | "school_admin"; name?: string }) => {
      return await apiRequest("PATCH", `/api/admin/users/${payload.userId}`, {
        role: payload.role,
        name: payload.name?.trim() || undefined,
      });
    },
    onSuccess: () => {
      toast({
        title: "Staff updated",
        description: "Staff details have been updated successfully.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/teachers"] });
      setEditDialogOpen(false);
      setStaffToEdit(null);
    },
    onError: (error: any) => {
      const message = getFriendlyErrorMessage(error);
      if (message.includes("last school admin")) {
        toast({
          title: "Action blocked",
          description: message,
        });
        return;
      }
      toast({
        variant: "destructive",
        title: "Failed to update staff",
        description: message || "An error occurred",
      });
    },
  });

  const resetPasswordMutation = useMutation({
    mutationFn: async (payload: { userId: string; newPassword: string }) => {
      return await apiRequest("POST", `/api/admin/users/${payload.userId}/password`, {
        newPassword: payload.newPassword,
      });
    },
    onSuccess: () => {
      toast({
        title: "Password reset",
        description: "The staff member's password has been reset successfully.",
      });
      setPasswordDialogOpen(false);
      setStaffToResetPassword(null);
      setNewPassword("");
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to reset password",
        description: getFriendlyErrorMessage(error) || "An error occurred",
      });
    },
  });

  const cleanupStudentsMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest("POST", "/api/admin/cleanup-students");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/students"] });
      toast({
        title: "Student data cleared",
        description: "All student devices and activity data have been cleared successfully.",
      });
      setCleanupDialogOpen(false);
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to cleanup student data",
        description: error.message || "An error occurred",
      });
    },
  });

  const updateTrackingHoursMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest("PATCH", "/api/settings", {
        enableTrackingHours,
        trackingStartTime,
        trackingEndTime,
        schoolTimezone,
        trackingDays,
        afterHoursMode,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      setInitialAfterHoursMode(afterHoursMode);
      toast({
        title: "Tracking hours updated",
        description: "School tracking hours have been configured successfully.",
      });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to update tracking hours",
        description: error.message || "An error occurred",
      });
    },
  });

  // Initialize tracking hours from settings
  useEffect(() => {
    if (settings) {
      setEnableTrackingHours(settings.enableTrackingHours ?? false);
      setTrackingStartTime(settings.trackingStartTime || "08:00");
      setTrackingEndTime(settings.trackingEndTime || "15:00");
      setSchoolTimezone(settings.schoolTimezone || "America/New_York");
      setTrackingDays(settings.trackingDays || ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]);
      const mode = (settings.afterHoursMode as "off" | "limited" | "full") || "off";
      setAfterHoursMode(mode);
      setInitialAfterHoursMode(mode);
    }
  }, [settings]);

  const onSubmit = (data: CreateStaffForm) => {
    createStaffMutation.mutate(data);
  };

  const handleDeleteClick = (staff: StaffUser) => {
    setStaffToDelete(staff);
    setDeleteDialogOpen(true);
  };

  const handleEditClick = (staff: StaffUser) => {
    setStaffToEdit(staff);
    setSelectedRole(staff.role);
    setEditName(staff.displayName || "");
    setEditDialogOpen(true);
  };

  const handleResetPasswordClick = (staff: StaffUser) => {
    setStaffToResetPassword(staff);
    setNewPassword("");
    setPasswordDialogOpen(true);
  };

  const handleResetPasswordSubmit = () => {
    if (!staffToResetPassword || !newPassword) return;
    resetPasswordMutation.mutate({
      userId: staffToResetPassword.id,
      newPassword,
    });
  };

  const handleDeleteConfirm = () => {
    if (staffToDelete) {
      deleteStaffMutation.mutate(staffToDelete.id);
    }
  };

  const handleEditSubmit = () => {
    if (!staffToEdit) {
      return;
    }
    updateStaffMutation.mutate({ userId: staffToEdit.id, role: selectedRole, name: editName });
  };

  const is247 =
    enableTrackingHours
    && trackingDays.length === 7
    && trackingStartTime === "00:00"
    && (trackingEndTime === "23:59" || trackingEndTime === "24:00");
  const needsAfterHoursConfirm = initialAfterHoursMode === "off" && afterHoursMode !== "off";
  const afterHoursHelperText =
    afterHoursMode === "off"
      ? "No monitoring outside school hours. Extension stops all network activity so the system can sleep and reduce cost."
      : "After-hours monitoring increases server traffic and storage and may increase plan cost.";

  const handleSaveTrackingHours = ({
    skipAfterHoursConfirm = false,
    skip247Confirm = false,
  }: { skipAfterHoursConfirm?: boolean; skip247Confirm?: boolean } = {}) => {
    if (needsAfterHoursConfirm && !skipAfterHoursConfirm) {
      setAfterHoursConfirmOpen(true);
      return;
    }
    if (is247 && !skip247Confirm) {
      setTracking247ConfirmOpen(true);
      return;
    }
    updateTrackingHoursMutation.mutate();
  };

  const staff = staffData?.users || [];

  return (
    <div className="container mx-auto p-6 max-w-6xl space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-lg bg-primary flex items-center justify-center">
            <Users className="h-6 w-6 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-3xl font-semibold">Admin Dashboard</h1>
            <p className="text-muted-foreground">
              {currentUser?.schoolName && <span className="font-medium">{currentUser.schoolName}</span>}
              {currentUser?.schoolName && ' • '}
              Manage staff accounts for your school
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button
            variant="outline"
            onClick={() => setLocation("/admin/analytics")}
          >
            <BarChart3 className="h-4 w-4 mr-2" />
            Analytics
          </Button>
          <Button
            variant="outline"
            onClick={() => setLocation("/dashboard")}
            data-testid="button-back-dashboard"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Dashboard
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setLocation("/")}
            data-testid="button-logout"
            title="Log out"
          >
            <LogOut className="h-5 w-5" />
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "staff" | "audit")} className="space-y-4">
        <TabsList>
          <TabsTrigger value="staff" className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            Staff & Settings
          </TabsTrigger>
          <TabsTrigger value="audit" className="flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Audit Logs
          </TabsTrigger>
        </TabsList>

        <TabsContent value="staff" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5" />
              Add Staff
            </CardTitle>
            <CardDescription>
              Add a teacher or school admin to your school
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name (Optional)</Label>
                <Input
                  id="name"
                  data-testid="input-staff-name"
                  type="text"
                  placeholder="e.g., John Smith"
                  {...form.register("name")}
                />
                {form.formState.errors.name && (
                  <p className="text-sm text-destructive">
                    {form.formState.errors.name.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  data-testid="input-staff-email"
                  type="email"
                  placeholder="e.g., john.smith@school.edu"
                  {...form.register("email")}
                />
                {form.formState.errors.email && (
                  <p className="text-sm text-destructive">
                    {form.formState.errors.email.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="role">Role</Label>
                <Select
                  value={form.watch("role")}
                  onValueChange={(value) => form.setValue("role", value as "teacher" | "school_admin")}
                >
                  <SelectTrigger id="role" data-testid="select-staff-role">
                    <SelectValue placeholder="Select role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="teacher">Teacher</SelectItem>
                    <SelectItem value="school_admin">School Admin</SelectItem>
                  </SelectContent>
                </Select>
                <input type="hidden" {...form.register("role")} />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Temp Password (Optional)</Label>
                <Input
                  id="password"
                  data-testid="input-staff-password"
                  type="password"
                  placeholder="Leave blank for Google-only login"
                  {...form.register("password")}
                />
                {form.formState.errors.password && (
                  <p className="text-sm text-destructive">
                    {form.formState.errors.password.message}
                  </p>
                )}
              </div>

              <Button
                type="submit"
                data-testid="button-create-staff"
                className="w-full"
                disabled={createStaffMutation.isPending}
              >
                {createStaffMutation.isPending ? "Adding..." : "Add Staff"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Staff Accounts</CardTitle>
            <CardDescription>
              {staff.length} {staff.length === 1 ? "staff member" : "staff members"} in the system
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-center py-8 text-muted-foreground">
                Loading staff...
              </div>
            ) : staff.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No staff yet. Add a staff member to get started!
              </div>
            ) : (
              <div className="space-y-2">
                {staff.map((member: StaffUser) => (
                  <div
                    key={member.id}
                    data-testid={`staff-row-${member.id}`}
                    className="flex items-center justify-between p-3 rounded-lg border hover-elevate"
                  >
                    <div>
                      <p className="font-medium" data-testid={`staff-name-${member.id}`}>
                        {member.displayName || member.email}
                      </p>
                      <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                        <Badge variant={member.role === "school_admin" ? "default" : "secondary"}>
                          {member.role === "school_admin" ? "School Admin" : "Teacher"}
                        </Badge>
                        <span>{member.schoolName}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        data-testid={`button-edit-${member.id}`}
                        onClick={() => handleEditClick(member)}
                        disabled={updateStaffMutation.isPending}
                      >
                        Edit Role
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        data-testid={`button-reset-password-${member.id}`}
                        onClick={() => handleResetPasswordClick(member)}
                        disabled={resetPasswordMutation.isPending}
                      >
                        <Key className="h-4 w-4 mr-1" />
                        Password
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        data-testid={`button-delete-${member.id}`}
                        onClick={() => handleDeleteClick(member)}
                        disabled={deleteStaffMutation.isPending}
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
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            School Tracking Hours
          </CardTitle>
          <CardDescription>
            Configure when student monitoring is active for privacy compliance
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="bg-muted p-4 rounded-lg space-y-3">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="enableTrackingHours"
                checked={enableTrackingHours}
                onCheckedChange={(checked) => setEnableTrackingHours(checked as boolean)}
                data-testid="checkbox-enable-tracking-hours"
              />
              <Label htmlFor="enableTrackingHours" className="font-medium cursor-pointer">
                Enable School Hours Tracking
              </Label>
            </div>
            <p className="text-sm text-muted-foreground">
              When enabled, student activity will only be tracked during the specified hours. Heartbeats received outside these hours will be ignored.
            </p>
          </div>

          {enableTrackingHours && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="trackingStartTime">School Start Time</Label>
                  <Input
                    id="trackingStartTime"
                    type="time"
                    value={trackingStartTime}
                    onChange={(e) => setTrackingStartTime(e.target.value)}
                    data-testid="input-tracking-start-time"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="trackingEndTime">School End Time</Label>
                  <Input
                    id="trackingEndTime"
                    type="time"
                    value={trackingEndTime}
                    onChange={(e) => setTrackingEndTime(e.target.value)}
                    data-testid="input-tracking-end-time"
                  />
                </div>
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="schoolTimezone">School Timezone</Label>
                <Select value={schoolTimezone} onValueChange={setSchoolTimezone}>
                  <SelectTrigger id="schoolTimezone" data-testid="select-school-timezone">
                    <SelectValue placeholder="Select timezone" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="America/New_York">Eastern Time (ET)</SelectItem>
                    <SelectItem value="America/Chicago">Central Time (CT)</SelectItem>
                    <SelectItem value="America/Denver">Mountain Time (MT)</SelectItem>
                    <SelectItem value="America/Phoenix">Arizona (MST)</SelectItem>
                    <SelectItem value="America/Los_Angeles">Pacific Time (PT)</SelectItem>
                    <SelectItem value="America/Anchorage">Alaska Time (AKT)</SelectItem>
                    <SelectItem value="Pacific/Honolulu">Hawaii Time (HST)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Tracking hours will be enforced in this timezone, regardless of server location.
                </p>
              </div>

              <div className="space-y-2">
                <Label>Tracking Days</Label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) => (
                    <div key={day} className="flex items-center space-x-2">
                      <Checkbox
                        id={`tracking-day-${day}`}
                        checked={trackingDays.includes(day)}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setTrackingDays([...trackingDays, day]);
                          } else {
                            setTrackingDays(trackingDays.filter(d => d !== day));
                          }
                        }}
                        data-testid={`checkbox-tracking-day-${day.toLowerCase()}`}
                      />
                      <Label htmlFor={`tracking-day-${day}`} className="cursor-pointer text-sm font-normal">
                        {day}
                      </Label>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Select which days of the week student activity should be tracked. Deselect weekends or holidays to pause monitoring.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="afterHoursMode">Outside School Hours</Label>
                <Select
                  value={afterHoursMode}
                  onValueChange={(value) => setAfterHoursMode(value as "off" | "limited" | "full")}
                >
                  <SelectTrigger id="afterHoursMode" data-testid="select-after-hours-mode">
                    <SelectValue placeholder="Select after-hours mode" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">Off (recommended)</SelectItem>
                    <SelectItem value="limited">Limited (may increase cost)</SelectItem>
                    <SelectItem value="full">Full (highest cost)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {afterHoursHelperText}
                </p>
              </div>

              {afterHoursMode !== "off" && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 h-4 w-4" />
                  <span>
                    After-hours monitoring increases server traffic and storage. This may increase your plan cost.
                  </span>
                </div>
              )}
            </div>
          )}

          {is247 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <span>
                You are enabling 24/7 monitoring. This may significantly increase traffic and cost.
              </span>
            </div>
          )}

          <Button
            onClick={() => handleSaveTrackingHours()}
            disabled={updateTrackingHoursMutation.isPending}
            data-testid="button-save-tracking-hours"
            className="w-full"
          >
            {updateTrackingHoursMutation.isPending ? "Saving..." : "Save Tracking Hours"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Student Roster Management
          </CardTitle>
          <CardDescription>
            Manage student records and import new students
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="bg-muted p-4 rounded-lg">
            <p className="text-sm mb-2">
              <strong>Student Roster:</strong> Centralized management of all student records.
            </p>
            <ul className="text-sm space-y-1 list-disc list-inside text-muted-foreground">
              <li>Import students via CSV files</li>
              <li>Edit student information (name, email, grade)</li>
              <li>Delete student records</li>
              <li>Filter students by grade level</li>
            </ul>
          </div>
          <Button
            variant="default"
            data-testid="button-manage-students"
            onClick={() => setLocation("/students")}
          >
            Manage Students
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SettingsIcon className="h-5 w-5" />
            Class Management
          </CardTitle>
          <CardDescription>
            Create and manage class rosters for teachers
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="bg-muted p-4 rounded-lg">
            <p className="text-sm mb-2">
              <strong>Admin Class Creation:</strong> Create official class rosters for teachers.
            </p>
            <ul className="text-sm space-y-1 list-disc list-inside text-muted-foreground">
              <li>Browse classes by grade level</li>
              <li>Create classes (e.g., "7th Science P3") and assign to teachers</li>
              <li>Assign students to class rosters</li>
              <li>Teachers can then start/end sessions for these classes</li>
            </ul>
          </div>
          <Button
            variant="default"
            data-testid="button-manage-classes"
            onClick={() => setLocation("/admin/classes")}
          >
            Manage Classes
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Active Sessions Monitor
          </CardTitle>
          <CardDescription>
            View all ongoing class sessions school-wide
          </CardDescription>
        </CardHeader>
        <CardContent>
          {activeSessions.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Clock className="h-12 w-12 mx-auto mb-3 text-muted-foreground/30" />
              <p className="text-sm">No active class sessions</p>
            </div>
          ) : (
            <div className="space-y-2">
              {activeSessions.map((session) => {
                const teacher = staff.find(t => t.id === session.teacherId);
                const group = allGroups.find(g => g.id === session.groupId);
                return (
                  <div
                    key={session.id}
                    className="flex items-center justify-between p-3 rounded-lg border hover-elevate"
                    data-testid={`session-${session.id}`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                      <div>
                        <p className="font-medium">{group?.name || 'Unknown Group'}</p>
                        <p className="text-sm text-muted-foreground">
                          {teacher?.displayName || teacher?.email || 'Unknown Teacher'} • Started {new Date(session.startTime).toLocaleTimeString()}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            Database Cleanup
          </CardTitle>
          <CardDescription>
            Remove all student devices and monitoring data from the system
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="bg-muted p-4 rounded-lg">
            <p className="text-sm mb-2">
              <strong>Warning:</strong> This will permanently delete:
            </p>
            <ul className="text-sm space-y-1 list-disc list-inside text-muted-foreground">
              <li>All registered student/Chromebook devices</li>
              <li>All heartbeat and activity history</li>
              <li>All URL visit records</li>
            </ul>
            <p className="text-sm mt-3 text-muted-foreground">
              Use this to clean up duplicate entries or start fresh. Extensions will need to re-register after cleanup.
            </p>
          </div>
          <Button
            variant="destructive"
            data-testid="button-cleanup-students"
            onClick={() => setCleanupDialogOpen(true)}
            disabled={cleanupStudentsMutation.isPending}
          >
            {cleanupStudentsMutation.isPending ? "Cleaning up..." : "Clear All Student Data"}
          </Button>
        </CardContent>
      </Card>
        </TabsContent>

        <TabsContent value="audit" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5" />
                Audit Logs
              </CardTitle>
              <CardDescription>
                Track administrative actions and changes for compliance
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <Label htmlFor="action-filter">Filter by Action</Label>
                  <Select
                    value={auditActionFilter}
                    onValueChange={(v) => {
                      setAuditActionFilter(v === "all" ? "" : v);
                      setAuditPage(0);
                    }}
                  >
                    <SelectTrigger id="action-filter">
                      <SelectValue placeholder="All actions" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All actions</SelectItem>
                      <SelectItem value="auth.login">Login</SelectItem>
                      <SelectItem value="auth.logout">Logout</SelectItem>
                      <SelectItem value="settings.update">Settings Update</SelectItem>
                      <SelectItem value="user.create">User Created</SelectItem>
                      <SelectItem value="user.update">User Updated</SelectItem>
                      <SelectItem value="user.delete">User Deleted</SelectItem>
                      <SelectItem value="student.create">Student Created</SelectItem>
                      <SelectItem value="student.update">Student Updated</SelectItem>
                      <SelectItem value="student.delete">Student Deleted</SelectItem>
                      <SelectItem value="session.start">Session Started</SelectItem>
                      <SelectItem value="session.end">Session Ended</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {auditLogsLoading ? (
                <div className="text-center py-8 text-muted-foreground">Loading audit logs...</div>
              ) : auditLogsData?.logs && auditLogsData.logs.length > 0 ? (
                <div className="space-y-4">
                  <div className="border rounded-lg overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-muted">
                        <tr>
                          <th className="px-4 py-2 text-left font-medium">Time</th>
                          <th className="px-4 py-2 text-left font-medium">User</th>
                          <th className="px-4 py-2 text-left font-medium">Action</th>
                          <th className="px-4 py-2 text-left font-medium">Details</th>
                        </tr>
                      </thead>
                      <tbody>
                        {auditLogsData.logs.map((log) => (
                          <tr key={log.id} className="border-t">
                            <td className="px-4 py-2 whitespace-nowrap">
                              {new Date(log.createdAt).toLocaleString()}
                            </td>
                            <td className="px-4 py-2">
                              <div>{log.userEmail || log.userId}</div>
                              {log.userRole && (
                                <Badge variant="outline" className="text-xs mt-1">
                                  {log.userRole}
                                </Badge>
                              )}
                            </td>
                            <td className="px-4 py-2">
                              <Badge variant={
                                log.action.startsWith('auth.') ? 'default' :
                                log.action.includes('delete') ? 'destructive' :
                                'secondary'
                              }>
                                {log.action}
                              </Badge>
                            </td>
                            <td className="px-4 py-2 max-w-xs truncate">
                              {log.entityName && <span>{log.entityName}</span>}
                              {log.entityType && !log.entityName && <span className="text-muted-foreground">{log.entityType}</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="text-sm text-muted-foreground">
                      Showing {auditPage * 20 + 1} - {Math.min((auditPage + 1) * 20, auditLogsData.total)} of {auditLogsData.total}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={auditPage === 0}
                        onClick={() => setAuditPage(p => p - 1)}
                      >
                        <ChevronLeft className="h-4 w-4" />
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={(auditPage + 1) * 20 >= auditLogsData.total}
                        onClick={() => setAuditPage(p => p + 1)}
                      >
                        Next
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  No audit logs found. Actions will be recorded as users interact with the system.
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog
        open={editDialogOpen}
        onOpenChange={(open) => {
          setEditDialogOpen(open);
          if (!open) {
            setStaffToEdit(null);
          }
        }}
      >
        <DialogContent data-testid="dialog-edit-staff">
          <DialogHeader>
            <DialogTitle>Edit Staff</DialogTitle>
            <DialogDescription>
              Update details for <strong>{staffToEdit?.displayName || staffToEdit?.email}</strong>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Display Name</Label>
              <Input
                id="edit-name"
                data-testid="input-edit-name"
                type="text"
                placeholder="e.g., John Smith"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-role">Role</Label>
              <Select
                value={selectedRole}
                onValueChange={(value) =>
                  setSelectedRole(value as "teacher" | "school_admin")
                }
              >
                <SelectTrigger id="edit-role" data-testid="select-edit-role">
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="teacher">Teacher</SelectItem>
                  <SelectItem value="school_admin">School Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={handleEditSubmit} disabled={updateStaffMutation.isPending}>
                {updateStaffMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={passwordDialogOpen}
        onOpenChange={(open) => {
          setPasswordDialogOpen(open);
          if (!open) {
            setStaffToResetPassword(null);
            setNewPassword("");
          }
        }}
      >
        <DialogContent data-testid="dialog-reset-password">
          <DialogHeader>
            <DialogTitle>Reset Password</DialogTitle>
            <DialogDescription>
              Set a new password for <strong>{staffToResetPassword?.displayName || staffToResetPassword?.email}</strong>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-password">New Password</Label>
              <Input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter new password (min 10 characters)"
                data-testid="input-new-password"
              />
              <p className="text-xs text-muted-foreground">
                Minimum 10 characters required.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setPasswordDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleResetPasswordSubmit}
                disabled={resetPasswordMutation.isPending || newPassword.length < 10}
              >
                {resetPasswordMutation.isPending ? "Resetting..." : "Reset Password"}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Staff Account</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the account for{" "}
              <strong>{staffToDelete?.displayName || staffToDelete?.email}</strong>? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-delete"
              onClick={handleDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete Account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={cleanupDialogOpen} onOpenChange={setCleanupDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear All Student Data</AlertDialogTitle>
            <AlertDialogDescription>
              Are you absolutely sure? This will permanently delete all student devices, activity history, and monitoring data from the database. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-cleanup">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-cleanup"
              onClick={() => cleanupStudentsMutation.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Yes, Clear All Data
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={afterHoursConfirmOpen} onOpenChange={setAfterHoursConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enable after-hours monitoring?</AlertDialogTitle>
            <AlertDialogDescription>
              This will allow monitoring outside school hours and may increase cost due to additional device traffic and storage.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setAfterHoursConfirmOpen(false);
                handleSaveTrackingHours({ skipAfterHoursConfirm: true });
              }}
            >
              Enable
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={tracking247ConfirmOpen} onOpenChange={setTracking247ConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enable 24/7 monitoring?</AlertDialogTitle>
            <AlertDialogDescription>
              This may significantly increase traffic and cost. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setTracking247ConfirmOpen(false);
                handleSaveTrackingHours({ skip247Confirm: true });
              }}
            >
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
