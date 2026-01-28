import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Building2, Plus, Users, GraduationCap, Shield, Search, MoreVertical, Trash2, Pause, Play, UserCog, KeyRound, Copy, Check, Mail, Send } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { formatDistanceToNow } from "date-fns";

interface School {
  id: string;
  name: string;
  domain: string;
  status: string;
  maxLicenses: number;
  teacherCount: number;
  studentCount: number;
  adminCount: number;
  createdAt: string;
  trialEndsAt: string | null;
  deletedAt: string | null;
  lastActivityAt: string | null;
}

interface Summary {
  totalSchools: number;
  activeSchools: number;
  trialSchools: number;
  suspendedSchools: number;
  totalLicenses: number;
  totalStudents: number;
}

export default function SchoolsList() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [schoolToDelete, setSchoolToDelete] = useState<School | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [resetLoginDialogOpen, setResetLoginDialogOpen] = useState(false);
  const [tempPassword, setTempPassword] = useState<string>("");
  const [resetAdminInfo, setResetAdminInfo] = useState<{ email: string; displayName: string | null } | null>(null);
  const [broadcastDialogOpen, setBroadcastDialogOpen] = useState(false);
  const [broadcastSubject, setBroadcastSubject] = useState("");
  const [broadcastMessage, setBroadcastMessage] = useState("");

  const { data, isLoading } = useQuery<{ 
    success: boolean; 
    schools: School[];
    summary: Summary;
  }>({
    queryKey: ['/api/super-admin/schools', searchQuery, statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (searchQuery) params.append('search', searchQuery);
      if (statusFilter && statusFilter !== 'all') params.append('status', statusFilter);
      
      const response = await fetch(`/api/super-admin/schools?${params}`);
      if (!response.ok) throw new Error('Failed to fetch schools');
      return response.json();
    },
  });

  const schools = data?.schools || [];
  const summary = data?.summary || {
    totalSchools: 0,
    activeSchools: 0,
    trialSchools: 0,
    suspendedSchools: 0,
    totalLicenses: 0,
    totalStudents: 0,
  };

  const deleteMutation = useMutation({
    mutationFn: async (schoolId: string) => {
      return await apiRequest("DELETE", `/api/super-admin/schools/${schoolId}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/schools'] });
      toast({
        title: "School deleted",
        description: "The school has been successfully deleted",
      });
      setDeleteDialogOpen(false);
      setSchoolToDelete(null);
      setConfirmText("");
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to delete school",
        description: error.message || "An error occurred",
      });
    },
  });

  const suspendMutation = useMutation({
    mutationFn: async (schoolId: string) => {
      return await apiRequest("POST", `/api/super-admin/schools/${schoolId}/suspend`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/schools'] });
      toast({
        title: "School suspended",
        description: "The school has been suspended",
      });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to suspend school",
        description: error.message || "An error occurred",
      });
    },
  });

  const unsuspendMutation = useMutation({
    mutationFn: async (schoolId: string) => {
      return await apiRequest("PATCH", `/api/super-admin/schools/${schoolId}`, { status: "active" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/schools'] });
      toast({
        title: "School activated",
        description: "The school has been reactivated",
      });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to activate school",
        description: error.message || "An error occurred",
      });
    },
  });

  const impersonateMutation = useMutation({
    mutationFn: async (schoolId: string) => {
      const res = await apiRequest("POST", `/api/super-admin/schools/${schoolId}/impersonate`, {});
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({
        title: "Impersonating admin",
        description: `Now logged in as ${data.admin.displayName || data.admin.email}`,
      });
      // Redirect to dashboard as the school admin
      setTimeout(() => {
        window.location.href = "/dashboard";
      }, 500);
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to impersonate",
        description: error.message || "An error occurred",
      });
    },
  });

  const resetLoginMutation = useMutation({
    mutationFn: async (schoolId: string) => {
      const res = await apiRequest("POST", `/api/super-admin/schools/${schoolId}/reset-login`, {});
      return res.json();
    },
    onSuccess: (data: any) => {
      setTempPassword(data.tempPassword);
      setResetAdminInfo(data.admin);
      setResetLoginDialogOpen(true);
      toast({
        title: "Password reset successful",
        description: `Temporary password generated for ${data.admin.displayName || data.admin.email}`,
      });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to reset login",
        description: error.message || "An error occurred",
      });
    },
  });

  const [passwordCopied, setPasswordCopied] = useState(false);

  const copyPassword = () => {
    navigator.clipboard.writeText(tempPassword);
    setPasswordCopied(true);
    setTimeout(() => setPasswordCopied(false), 2000);
  };

  // Query to get admin email counts for broadcast preview
  const { data: adminEmailsData } = useQuery<{
    success: boolean;
    totalAdmins: number;
    schoolCount: number;
  }>({
    queryKey: ['/api/super-admin/admin-emails'],
    queryFn: async () => {
      const response = await fetch('/api/super-admin/admin-emails');
      if (!response.ok) throw new Error('Failed to fetch admin emails');
      return response.json();
    },
    enabled: broadcastDialogOpen,
  });

  const broadcastMutation = useMutation({
    mutationFn: async ({ subject, message }: { subject: string; message: string }) => {
      const res = await apiRequest("POST", "/api/super-admin/broadcast-email", { subject, message });
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({
        title: "Broadcast sent",
        description: `Email sent to ${data.sent} admin${data.sent !== 1 ? 's' : ''}${data.failed > 0 ? ` (${data.failed} failed)` : ''}`,
      });
      setBroadcastDialogOpen(false);
      setBroadcastSubject("");
      setBroadcastMessage("");
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to send broadcast",
        description: error.message || "An error occurred",
      });
    },
  });

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive"> = {
      trial: "secondary",
      active: "default",
      suspended: "destructive",
    };
    return <Badge variant={variants[status] || "default"}>{status}</Badge>;
  };

  const handleDeleteSchool = (school: School) => {
    setSchoolToDelete(school);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = () => {
    if (schoolToDelete && confirmText === schoolToDelete.name) {
      deleteMutation.mutate(schoolToDelete.id);
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading schools...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold">Schools Management</h1>
            <p className="text-muted-foreground mt-2">
              Manage all schools and their configurations
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={() => setBroadcastDialogOpen(true)}
              data-testid="button-broadcast-email"
            >
              <Send className="w-4 h-4 mr-2" />
              Broadcast Email
            </Button>
            <Button
              variant="outline"
              onClick={() => setLocation("/super-admin/trial-requests")}
              data-testid="button-trial-requests"
            >
              <Mail className="w-4 h-4 mr-2" />
              Trial Requests
            </Button>
            <Button
              onClick={() => setLocation("/super-admin/schools/new")}
              data-testid="button-create-school"
            >
              <Plus className="w-4 h-4 mr-2" />
              Create School
            </Button>
          </div>
        </div>

        {/* Summary Stats */}
        <div className="grid gap-4 md:grid-cols-4 mb-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Schools</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid="text-total-schools">{summary.totalSchools}</div>
              <p className="text-xs text-muted-foreground">
                Active: <span data-testid="text-active-schools">{summary.activeSchools}</span> | Trial: <span data-testid="text-trial-schools">{summary.trialSchools}</span>
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Licenses</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid="text-total-licenses">{summary.totalLicenses}</div>
              <p className="text-xs text-muted-foreground">
                In use: <span data-testid="text-licenses-in-use">{summary.totalStudents}</span>
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Active Students</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid="text-total-students">{summary.totalStudents}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Suspended</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid="text-suspended-schools">{summary.suspendedSchools}</div>
            </CardContent>
          </Card>
        </div>

        {/* Search and Filters */}
        <div className="flex gap-4 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search by name or domain..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
              data-testid="input-search"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-48" data-testid="select-status-filter">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="trial">Trial</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="suspended">Suspended</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Schools Grid */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {schools.map((school) => (
            <Card
              key={school.id}
              className="hover-elevate active-elevate-2"
              data-testid={`card-school-${school.id}`}
            >
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                <div 
                  className="flex-1 cursor-pointer" 
                  onClick={() => setLocation(`/super-admin/schools/${school.id}`)}
                >
                  <CardTitle className="text-lg font-semibold">
                    {school.name}
                  </CardTitle>
                </div>
                <div className="flex items-center gap-2">
                  {getStatusBadge(school.status)}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        onClick={(e) => e.stopPropagation()}
                        data-testid={`button-menu-${school.id}`}
                      >
                        <MoreVertical className="w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem 
                        onClick={() => setLocation(`/super-admin/schools/${school.id}`)}
                        data-testid={`menu-manage-${school.id}`}
                      >
                        Manage School
                      </DropdownMenuItem>
                      <DropdownMenuItem 
                        onClick={() => impersonateMutation.mutate(school.id)}
                        disabled={school.adminCount === 0}
                        data-testid={`menu-impersonate-${school.id}`}
                      >
                        <UserCog className="w-4 h-4 mr-2" />
                        Impersonate Admin
                      </DropdownMenuItem>
                      <DropdownMenuItem 
                        onClick={() => resetLoginMutation.mutate(school.id)}
                        disabled={school.adminCount === 0}
                        data-testid={`menu-reset-login-${school.id}`}
                      >
                        <KeyRound className="w-4 h-4 mr-2" />
                        Reset Admin Login
                      </DropdownMenuItem>
                      {school.status === 'suspended' ? (
                        <DropdownMenuItem 
                          onClick={() => unsuspendMutation.mutate(school.id)}
                          data-testid={`menu-activate-${school.id}`}
                        >
                          <Play className="w-4 h-4 mr-2" />
                          Activate School
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem 
                          onClick={() => suspendMutation.mutate(school.id)}
                          data-testid={`menu-suspend-${school.id}`}
                        >
                          <Pause className="w-4 h-4 mr-2" />
                          Suspend School
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem 
                        onClick={() => handleDeleteSchool(school)}
                        className="text-destructive"
                        data-testid={`menu-delete-${school.id}`}
                      >
                        <Trash2 className="w-4 h-4 mr-2" />
                        Delete School
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardHeader>
              <CardContent onClick={() => setLocation(`/super-admin/schools/${school.id}`)} className="cursor-pointer">
                <div className="space-y-2">
                  <div className="flex items-center text-sm text-muted-foreground">
                    <Building2 className="w-4 h-4 mr-2" />
                    {school.domain}
                  </div>
                  <div className="grid grid-cols-3 gap-2 mt-4">
                    <div className="text-center">
                      <div className="flex items-center justify-center mb-1">
                        <Shield className="w-4 h-4 text-primary" />
                      </div>
                      <p className="text-2xl font-bold">{school.adminCount}</p>
                      <p className="text-xs text-muted-foreground">Admins</p>
                    </div>
                    <div className="text-center">
                      <div className="flex items-center justify-center mb-1">
                        <Users className="w-4 h-4 text-primary" />
                      </div>
                      <p className="text-2xl font-bold">{school.teacherCount}</p>
                      <p className="text-xs text-muted-foreground">Teachers</p>
                    </div>
                    <div className="text-center">
                      <div className="flex items-center justify-center mb-1">
                        <GraduationCap className="w-4 h-4 text-primary" />
                      </div>
                      <p className="text-2xl font-bold">{school.studentCount}</p>
                      <p className="text-xs text-muted-foreground">Students</p>
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground mt-4 space-y-1">
                    <div data-testid={`text-max-licenses-${school.id}`}>Max Licenses: {school.maxLicenses}</div>
                    {school.trialEndsAt && (
                      <div data-testid={`text-trial-ends-${school.id}`}>Trial ends: {new Date(school.trialEndsAt).toLocaleDateString()}</div>
                    )}
                    {school.lastActivityAt && (
                      <div data-testid={`text-last-activity-${school.id}`}>Last active: {formatDistanceToNow(new Date(school.lastActivityAt), { addSuffix: true })}</div>
                    )}
                    <div className="text-xs text-muted-foreground/60" data-testid={`text-school-id-${school.id}`}>ID: {school.id.substring(0, 8)}</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {schools.length === 0 && (
          <Card className="p-12 text-center">
            <Building2 className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
            <p className="text-lg font-semibold mb-2">No schools found</p>
            <p className="text-muted-foreground mb-4">
              {searchQuery || statusFilter !== 'all'
                ? "Try adjusting your search or filters"
                : "Create your first school to get started"}
            </p>
            {!searchQuery && statusFilter === 'all' && (
              <Button onClick={() => setLocation("/super-admin/schools/new")}>
                <Plus className="w-4 h-4 mr-2" />
                Create School
              </Button>
            )}
          </Card>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete School</DialogTitle>
            <DialogDescription>
              This action will soft-delete the school. All admins, teachers, and student data will be deactivated.
              You'll be able to restore this school for 30 days.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <p className="text-sm font-medium">School: {schoolToDelete?.name}</p>
              <p className="text-sm text-muted-foreground">Domain: {schoolToDelete?.domain}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm">Type the school name to confirm</Label>
              <Input
                id="confirm"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={schoolToDelete?.name}
                data-testid="input-confirm-delete"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeleteDialogOpen(false);
                setSchoolToDelete(null);
                setConfirmText("");
              }}
              data-testid="button-cancel-delete"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={confirmText !== schoolToDelete?.name || deleteMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete School"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset Login Dialog */}
      <Dialog open={resetLoginDialogOpen} onOpenChange={setResetLoginDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Temporary Password Generated</DialogTitle>
            <DialogDescription>
              Share this temporary password with the school admin. They should change it after logging in.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <p className="text-sm font-medium">Admin: {resetAdminInfo?.displayName || resetAdminInfo?.email}</p>
              <p className="text-sm text-muted-foreground">Email: {resetAdminInfo?.email}</p>
            </div>
            <div className="space-y-2">
              <Label>Temporary Password</Label>
              <div className="flex gap-2">
                <Input
                  value={tempPassword}
                  readOnly
                  className="font-mono"
                  data-testid="input-temp-password"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={copyPassword}
                  data-testid="button-copy-password"
                >
                  {passwordCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Click the copy button to copy the password to clipboard
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                setResetLoginDialogOpen(false);
                setTempPassword("");
                setResetAdminInfo(null);
                setPasswordCopied(false);
              }}
              data-testid="button-close-reset-dialog"
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Broadcast Email Dialog */}
      <Dialog open={broadcastDialogOpen} onOpenChange={setBroadcastDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Broadcast Email to All Admins</DialogTitle>
            <DialogDescription>
              Send an email to all school administrators. Use this for important announcements, maintenance notices, or incident updates.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {adminEmailsData && (
              <div className="p-3 bg-muted rounded-lg text-sm">
                <p className="font-medium">Recipients: {adminEmailsData.totalAdmins} admin{adminEmailsData.totalAdmins !== 1 ? 's' : ''}</p>
                <p className="text-muted-foreground">Across {adminEmailsData.schoolCount} active/trial school{adminEmailsData.schoolCount !== 1 ? 's' : ''}</p>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="broadcast-subject">Subject</Label>
              <Input
                id="broadcast-subject"
                value={broadcastSubject}
                onChange={(e) => setBroadcastSubject(e.target.value)}
                placeholder="Important: ClassPilot Service Notice"
                data-testid="input-broadcast-subject"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="broadcast-message">Message</Label>
              <Textarea
                id="broadcast-message"
                value={broadcastMessage}
                onChange={(e) => setBroadcastMessage(e.target.value)}
                placeholder="Enter your message here..."
                rows={6}
                data-testid="input-broadcast-message"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setBroadcastDialogOpen(false);
                setBroadcastSubject("");
                setBroadcastMessage("");
              }}
              data-testid="button-cancel-broadcast"
            >
              Cancel
            </Button>
            <Button
              onClick={() => broadcastMutation.mutate({ subject: broadcastSubject, message: broadcastMessage })}
              disabled={!broadcastSubject || !broadcastMessage || broadcastMutation.isPending}
              data-testid="button-send-broadcast"
            >
              {broadcastMutation.isPending ? "Sending..." : "Send to All Admins"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
