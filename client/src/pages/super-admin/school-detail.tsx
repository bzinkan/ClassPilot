import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation, useParams } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Building2, Plus, Mail, User, Edit, UserCog, KeyRound, Copy, Check, Clock, CreditCard, Send, DollarSign } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
  // Tracking hours configuration
  trackingStartHour: number;
  trackingEndHour: number;
  is24HourEnabled: boolean;
  schoolTimezone: string;
  // Billing
  billingEmail: string | null;
  stripeCustomerId: string | null;
  planTier: string;
  planStatus: string;
  activeUntil: string | null;
  lastPaymentAmount: number | null;
  lastPaymentDate: string | null;
  totalPaid: number;
}

interface Admin {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
}

interface Teacher {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
}

export default function SchoolDetail() {
  const params = useParams();
  const schoolId = params.id;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [isAddAdminOpen, setIsAddAdminOpen] = useState(false);
  const [newAdminEmail, setNewAdminEmail] = useState("");
  const [newAdminName, setNewAdminName] = useState("");
  const [isEditLicensesOpen, setIsEditLicensesOpen] = useState(false);
  const [newMaxLicenses, setNewMaxLicenses] = useState(100);
  const [onboardingEmailDialogOpen, setOnboardingEmailDialogOpen] = useState(false);
  const [resetLoginDialogOpen, setResetLoginDialogOpen] = useState(false);
  const [tempPassword, setTempPassword] = useState<string>("");
  const [resetAdminInfo, setResetAdminInfo] = useState<{ email: string; displayName: string | null } | null>(null);
  const [passwordCopied, setPasswordCopied] = useState(false);
  const [newAdminCredentialsDialogOpen, setNewAdminCredentialsDialogOpen] = useState(false);
  const [newAdminCredentials, setNewAdminCredentials] = useState<{ email: string; displayName: string; tempPassword: string } | null>(null);
  const [newAdminPasswordCopied, setNewAdminPasswordCopied] = useState(false);
  // Tracking hours state
  const [isEditTrackingHoursOpen, setIsEditTrackingHoursOpen] = useState(false);
  const [trackingStartHour, setTrackingStartHour] = useState(7);
  const [trackingEndHour, setTrackingEndHour] = useState(17);
  const [is24HourEnabled, setIs24HourEnabled] = useState(false);
  const [schoolTimezone, setSchoolTimezone] = useState("America/New_York");
  // Billing state
  const [isInvoiceDialogOpen, setIsInvoiceDialogOpen] = useState(false);
  const [invoiceStudentCount, setInvoiceStudentCount] = useState(100);
  const [invoiceBasePrice, setInvoiceBasePrice] = useState(500);
  const [invoicePerStudentPrice, setInvoicePerStudentPrice] = useState(2);
  const [invoiceDescription, setInvoiceDescription] = useState("");
  const [invoiceDaysUntilDue, setInvoiceDaysUntilDue] = useState(30);
  const [invoiceBillingEmail, setInvoiceBillingEmail] = useState("");
  const [isEditBillingEmailOpen, setIsEditBillingEmailOpen] = useState(false);
  const [newBillingEmail, setNewBillingEmail] = useState("");

  const { data, isLoading } = useQuery<{ 
    success: boolean; 
    school: School; 
    admins: Admin[];
    teachers: Teacher[];
  }>({
    queryKey: [`/api/super-admin/schools/${schoolId}`],
  });

  const school = data?.school;
  const admins = data?.admins || [];
  const teachers = data?.teachers || [];

  const addAdminMutation = useMutation({
    mutationFn: async (data: { email: string; displayName: string }) => {
      const res = await apiRequest("POST", `/api/super-admin/schools/${schoolId}/admins`, data);
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: [`/api/super-admin/schools/${schoolId}`] });
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/schools'] });
      
      // Store credentials and show dialog
      setNewAdminCredentials({
        email: data.admin.email,
        displayName: data.admin.displayName,
        tempPassword: data.tempPassword,
      });
      setNewAdminCredentialsDialogOpen(true);
      
      toast({
        title: "Admin added successfully",
        description: `New admin created: ${data.admin.displayName || data.admin.email}`,
      });
      
      setIsAddAdminOpen(false);
      setNewAdminEmail("");
      setNewAdminName("");
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to add admin",
        description: error.message || "An error occurred",
      });
    },
  });

  const handleAddAdmin = () => {
    if (!newAdminEmail) return;
    addAdminMutation.mutate({ email: newAdminEmail, displayName: newAdminName });
  };

  const editLicensesMutation = useMutation({
    mutationFn: async (maxLicenses: number) => {
      return await apiRequest("PATCH", `/api/super-admin/schools/${schoolId}`, { maxLicenses });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/super-admin/schools/${schoolId}`] });
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/schools'] });
      
      toast({
        title: "License limit updated",
        description: `Maximum licenses set to ${newMaxLicenses}`,
      });
      
      setIsEditLicensesOpen(false);
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to update license limit",
        description: error.message || "An error occurred",
      });
    },
  });

  const handleEditLicenses = () => {
    if (newMaxLicenses < 1) return;
    editLicensesMutation.mutate(newMaxLicenses);
  };

  // Send invoice mutation
  const sendInvoiceMutation = useMutation({
    mutationFn: async (data: {
      studentCount: number;
      basePrice: number;
      perStudentPrice: number;
      description?: string;
      daysUntilDue: number;
      billingEmail?: string;
    }) => {
      const res = await apiRequest("POST", `/api/super-admin/schools/${schoolId}/send-invoice`, data);
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: [`/api/super-admin/schools/${schoolId}`] });
      toast({
        title: "Invoice sent",
        description: data.invoiceUrl ? "Invoice has been sent to the billing email." : "Invoice created successfully.",
      });
      setIsInvoiceDialogOpen(false);
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to send invoice",
        description: error.message || "An error occurred",
      });
    },
  });

  // Update billing email mutation
  const updateBillingEmailMutation = useMutation({
    mutationFn: async (billingEmail: string) => {
      return await apiRequest("PATCH", `/api/super-admin/schools/${schoolId}`, { billingEmail });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/super-admin/schools/${schoolId}`] });
      toast({ title: "Billing email updated" });
      setIsEditBillingEmailOpen(false);
    },
    onError: (error: any) => {
      toast({ variant: "destructive", title: "Failed to update billing email", description: error.message });
    },
  });

  // Tracking hours mutation
  const editTrackingHoursMutation = useMutation({
    mutationFn: async (updates: {
      trackingStartHour: number;
      trackingEndHour: number;
      is24HourEnabled: boolean;
      schoolTimezone: string;
    }) => {
      return await apiRequest("PATCH", `/api/super-admin/schools/${schoolId}`, updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/super-admin/schools/${schoolId}`] });
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/schools'] });

      toast({
        title: "Tracking hours updated",
        description: is24HourEnabled
          ? "24/7 monitoring enabled for this school"
          : `Tracking window set to ${formatHour(trackingStartHour)} - ${formatHour(trackingEndHour)}`,
      });

      setIsEditTrackingHoursOpen(false);
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to update tracking hours",
        description: error.message || "An error occurred",
      });
    },
  });

  const handleEditTrackingHours = () => {
    editTrackingHoursMutation.mutate({
      trackingStartHour,
      trackingEndHour,
      is24HourEnabled,
      schoolTimezone,
    });
  };

  // Format hour (0-23) to readable time
  const formatHour = (hour: number): string => {
    const period = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour % 12 || 12;
    return `${displayHour}:00 ${period}`;
  };

  const impersonateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/super-admin/schools/${schoolId}/impersonate`, {});
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({
        title: "Impersonating admin",
        description: `Now logged in as ${data.admin.displayName || data.admin.email}`,
      });
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

  const onboardingEmailMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/super-admin/schools/${schoolId}/send-onboarding-email`, {});
      return res.json();
    },
    onSuccess: (data: any) => {
      setOnboardingEmailDialogOpen(false);
      toast({
        title: "Onboarding emails sent",
        description: `${data.sent} email${data.sent !== 1 ? "s" : ""} sent successfully${data.failed > 0 ? `, ${data.failed} failed` : ""}`,
      });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to send onboarding emails",
        description: error.message || "An error occurred",
      });
    },
  });

  const resetLoginMutation = useMutation({
    mutationFn: async () => {
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

  const copyPassword = () => {
    navigator.clipboard.writeText(tempPassword);
    setPasswordCopied(true);
    setTimeout(() => setPasswordCopied(false), 2000);
  };

  const copyNewAdminPassword = () => {
    if (newAdminCredentials) {
      navigator.clipboard.writeText(newAdminCredentials.tempPassword);
      setNewAdminPasswordCopied(true);
      setTimeout(() => setNewAdminPasswordCopied(false), 2000);
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading school details...</p>
      </div>
    );
  }

  if (!school) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-muted-foreground">School not found</p>
      </div>
    );
  }

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive"> = {
      trial: "secondary",
      active: "default",
      suspended: "destructive",
    };
    return <Badge variant={variants[status] || "default"}>{status}</Badge>;
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto p-6">
        <Button
          variant="ghost"
          onClick={() => setLocation("/super-admin/schools")}
          className="mb-4"
          data-testid="button-back"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Schools
        </Button>

        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold">{school.name}</h1>
              {getStatusBadge(school.status)}
            </div>
            <p className="text-muted-foreground mt-2">{school.domain}</p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="default"
              onClick={() => setIsAddAdminOpen(true)}
              data-testid="button-add-admin-header"
            >
              <Plus className="w-4 h-4 mr-2" />
              Add Admin
            </Button>
            <Button
              variant="outline"
              onClick={() => impersonateMutation.mutate()}
              disabled={school.adminCount === 0 || impersonateMutation.isPending}
              data-testid="button-impersonate-admin"
            >
              <UserCog className="w-4 h-4 mr-2" />
              Impersonate Admin
            </Button>
            <Button
              variant="outline"
              onClick={() => resetLoginMutation.mutate()}
              disabled={school.adminCount === 0 || resetLoginMutation.isPending}
              data-testid="button-reset-login"
            >
              <KeyRound className="w-4 h-4 mr-2" />
              Reset Admin Login
            </Button>
            <Button
              variant="outline"
              onClick={() => setOnboardingEmailDialogOpen(true)}
              disabled={school.adminCount === 0 || onboardingEmailMutation.isPending}
            >
              <Send className="w-4 h-4 mr-2" />
              Send Onboarding Email
            </Button>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-4 mb-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Admins</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{school.adminCount}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Teachers</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{school.teacherCount}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Students</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{school.studentCount}</div>
              <div className="flex items-center justify-between mt-1">
                <p className="text-xs text-muted-foreground">
                  Max: {school.maxLicenses}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setNewMaxLicenses(school.maxLicenses);
                    setIsEditLicensesOpen(true);
                  }}
                  className="h-6 px-2"
                  data-testid="button-edit-licenses"
                >
                  <Edit className="w-3 h-3 mr-1" />
                  Edit
                </Button>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-1">
                <Clock className="w-4 h-4" />
                Tracking Hours
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-lg font-bold">
                {school.is24HourEnabled ? (
                  <span className="text-green-600">24/7</span>
                ) : (
                  `${formatHour(school.trackingStartHour)} - ${formatHour(school.trackingEndHour)}`
                )}
              </div>
              <div className="flex items-center justify-between mt-1">
                <p className="text-xs text-muted-foreground">
                  {school.is24HourEnabled ? "Premium" : `${school.trackingEndHour - school.trackingStartHour}h window`}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setTrackingStartHour(school.trackingStartHour);
                    setTrackingEndHour(school.trackingEndHour);
                    setIs24HourEnabled(school.is24HourEnabled);
                    setSchoolTimezone(school.schoolTimezone);
                    setIsEditTrackingHoursOpen(true);
                  }}
                  className="h-6 px-2"
                  data-testid="button-edit-tracking-hours"
                >
                  <Edit className="w-3 h-3 mr-1" />
                  Edit
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Billing & Payments */}
        <Card className="mb-6">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <CreditCard className="w-5 h-5" />
                Billing & Payments
              </CardTitle>
              <Button
                size="sm"
                onClick={() => {
                  setInvoiceStudentCount(school.maxLicenses || 100);
                  setInvoiceBillingEmail(school.billingEmail || "");
                  setIsInvoiceDialogOpen(true);
                }}
              >
                <Send className="w-4 h-4 mr-2" />
                Send Invoice
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-sm text-muted-foreground">Payment Status</p>
                <Badge variant={school.planStatus === 'active' ? 'default' : school.planStatus === 'past_due' ? 'destructive' : 'secondary'} className="mt-1">
                  {school.status === 'trial' ? 'Trial' : school.planStatus}
                </Badge>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Last Payment</p>
                <p className="text-lg font-semibold mt-1">
                  {school.lastPaymentAmount
                    ? `$${(school.lastPaymentAmount / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                    : '—'}
                </p>
                {school.lastPaymentDate && (
                  <p className="text-xs text-muted-foreground">
                    {new Date(school.lastPaymentDate).toLocaleDateString()}
                  </p>
                )}
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Total Paid</p>
                <p className="text-lg font-semibold mt-1">
                  ${((school.totalPaid || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Active Until</p>
                <p className="text-lg font-semibold mt-1">
                  {school.activeUntil
                    ? new Date(school.activeUntil).toLocaleDateString()
                    : school.trialEndsAt
                      ? `Trial ends ${new Date(school.trialEndsAt).toLocaleDateString()}`
                      : '—'}
                </p>
              </div>
            </div>
            <div className="mt-4 pt-4 border-t flex items-center gap-4">
              <div className="flex-1">
                <p className="text-sm text-muted-foreground">Billing Email</p>
                <p className="text-sm font-medium">{school.billingEmail || 'Not set'}</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setNewBillingEmail(school.billingEmail || "");
                  setIsEditBillingEmailOpen(true);
                }}
              >
                <Edit className="w-3 h-3 mr-1" />
                Edit
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>School Admins</CardTitle>
                <Dialog open={isAddAdminOpen} onOpenChange={setIsAddAdminOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm" data-testid="button-add-admin-card">
                      <Plus className="w-4 h-4 mr-2" />
                      Add Admin
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Add School Admin</DialogTitle>
                      <DialogDescription>
                        Create a new admin account for this school
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <Label htmlFor="email">Email</Label>
                        <Input
                          id="email"
                          type="email"
                          placeholder="admin@example.com"
                          value={newAdminEmail}
                          onChange={(e) => setNewAdminEmail(e.target.value)}
                          data-testid="input-admin-email"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="displayName">Display Name</Label>
                        <Input
                          id="displayName"
                          placeholder="John Doe"
                          value={newAdminName}
                          onChange={(e) => setNewAdminName(e.target.value)}
                          data-testid="input-admin-name"
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button
                        variant="outline"
                        onClick={() => setIsAddAdminOpen(false)}
                      >
                        Cancel
                      </Button>
                      <Button
                        onClick={handleAddAdmin}
                        disabled={!newAdminEmail || addAdminMutation.isPending}
                        data-testid="button-confirm-add-admin"
                      >
                        {addAdminMutation.isPending ? "Adding..." : "Add Admin"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent>
              {admins.length === 0 ? (
                <p className="text-sm text-muted-foreground">No admins yet</p>
              ) : (
                <div className="space-y-2">
                  {admins.map((admin) => (
                    <div
                      key={admin.id}
                      className="flex items-center gap-3 p-3 rounded-lg border"
                      data-testid={`admin-${admin.id}`}
                    >
                      <div className="flex-1">
                        <p className="font-medium">{admin.displayName || admin.email}</p>
                        <p className="text-sm text-muted-foreground">{admin.email}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Teachers</CardTitle>
            </CardHeader>
            <CardContent>
              {teachers.length === 0 ? (
                <p className="text-sm text-muted-foreground">No teachers yet</p>
              ) : (
                <div className="space-y-2">
                  {teachers.map((teacher) => (
                    <div
                      key={teacher.id}
                      className="flex items-center gap-3 p-3 rounded-lg border"
                      data-testid={`teacher-${teacher.id}`}
                    >
                      <div className="flex-1">
                        <p className="font-medium">{teacher.displayName || teacher.email}</p>
                        <p className="text-sm text-muted-foreground">{teacher.email}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Edit License Limits Dialog */}
        <Dialog open={isEditLicensesOpen} onOpenChange={setIsEditLicensesOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit License Limit</DialogTitle>
              <DialogDescription>
                Set the maximum number of student licenses for this school
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="maxLicenses">Maximum Licenses</Label>
                <Input
                  id="maxLicenses"
                  type="number"
                  min="1"
                  value={newMaxLicenses}
                  onChange={(e) => setNewMaxLicenses(parseInt(e.target.value) || 0)}
                  data-testid="input-max-licenses"
                />
                <p className="text-xs text-muted-foreground">
                  Current usage: {school?.studentCount} students
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setIsEditLicensesOpen(false)}
                data-testid="button-cancel-edit-licenses"
              >
                Cancel
              </Button>
              <Button
                onClick={handleEditLicenses}
                disabled={newMaxLicenses < 1 || editLicensesMutation.isPending}
                data-testid="button-confirm-edit-licenses"
              >
                {editLicensesMutation.isPending ? "Updating..." : "Update Limit"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Edit Tracking Hours Dialog */}
        <Dialog open={isEditTrackingHoursOpen} onOpenChange={setIsEditTrackingHoursOpen}>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Edit Tracking Hours</DialogTitle>
              <DialogDescription>
                Configure when student activity is monitored for this school
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="is24Hour">24/7 Monitoring</Label>
                  <p className="text-xs text-muted-foreground">
                    Premium feature - monitor students around the clock
                  </p>
                </div>
                <Switch
                  id="is24Hour"
                  checked={is24HourEnabled}
                  onCheckedChange={setIs24HourEnabled}
                  data-testid="switch-24-hour"
                />
              </div>

              {!is24HourEnabled && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="startHour">Start Time</Label>
                    <Select
                      value={trackingStartHour.toString()}
                      onValueChange={(value) => setTrackingStartHour(parseInt(value))}
                    >
                      <SelectTrigger id="startHour" data-testid="select-start-hour">
                        <SelectValue placeholder="Select start time" />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 24 }, (_, i) => (
                          <SelectItem key={i} value={i.toString()}>
                            {formatHour(i)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="endHour">End Time</Label>
                    <Select
                      value={trackingEndHour.toString()}
                      onValueChange={(value) => setTrackingEndHour(parseInt(value))}
                    >
                      <SelectTrigger id="endHour" data-testid="select-end-hour">
                        <SelectValue placeholder="Select end time" />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 24 }, (_, i) => (
                          <SelectItem key={i} value={i.toString()}>
                            {formatHour(i)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="timezone">Timezone</Label>
                    <Select
                      value={schoolTimezone}
                      onValueChange={setSchoolTimezone}
                    >
                      <SelectTrigger id="timezone" data-testid="select-timezone">
                        <SelectValue placeholder="Select timezone" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="America/New_York">Eastern (ET)</SelectItem>
                        <SelectItem value="America/Chicago">Central (CT)</SelectItem>
                        <SelectItem value="America/Denver">Mountain (MT)</SelectItem>
                        <SelectItem value="America/Los_Angeles">Pacific (PT)</SelectItem>
                        <SelectItem value="America/Anchorage">Alaska (AKT)</SelectItem>
                        <SelectItem value="Pacific/Honolulu">Hawaii (HT)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <p className="text-sm text-muted-foreground">
                    Tracking window: {trackingEndHour - trackingStartHour} hours
                    {trackingEndHour - trackingStartHour < 10 && (
                      <span className="text-yellow-600 ml-2">
                        (Recommended: 10 hours)
                      </span>
                    )}
                  </p>
                </>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setIsEditTrackingHoursOpen(false)}
                data-testid="button-cancel-edit-tracking-hours"
              >
                Cancel
              </Button>
              <Button
                onClick={handleEditTrackingHours}
                disabled={editTrackingHoursMutation.isPending || (!is24HourEnabled && trackingEndHour <= trackingStartHour)}
                data-testid="button-confirm-edit-tracking-hours"
              >
                {editTrackingHoursMutation.isPending ? "Updating..." : "Save Changes"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Reset Login Dialog */}
        <Dialog open={onboardingEmailDialogOpen} onOpenChange={setOnboardingEmailDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Send Onboarding Email</DialogTitle>
              <DialogDescription>
                This will send a welcome email to all admins of {school.name} with login instructions, Chrome extension install guide, and getting started links.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOnboardingEmailDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => onboardingEmailMutation.mutate()}
                disabled={onboardingEmailMutation.isPending}
              >
                <Send className="w-4 h-4 mr-2" />
                {onboardingEmailMutation.isPending ? "Sending..." : "Send Email"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

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
                    data-testid="input-temp-password-detail"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={copyPassword}
                    data-testid="button-copy-password-detail"
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
                data-testid="button-close-reset-dialog-detail"
              >
                Done
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* New Admin Credentials Dialog */}
        <Dialog open={newAdminCredentialsDialogOpen} onOpenChange={setNewAdminCredentialsDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Admin Account Created</DialogTitle>
              <DialogDescription>
                Share these credentials with the new school admin. They should change the password after their first login.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <p className="text-sm font-medium">Admin: {newAdminCredentials?.displayName}</p>
                <p className="text-sm text-muted-foreground">Email: {newAdminCredentials?.email}</p>
              </div>
              <div className="space-y-2">
                <Label>Email (Username)</Label>
                <Input
                  value={newAdminCredentials?.email || ""}
                  readOnly
                  className="font-mono"
                  data-testid="input-new-admin-email"
                />
              </div>
              <div className="space-y-2">
                <Label>Temporary Password</Label>
                <div className="flex gap-2">
                  <Input
                    value={newAdminCredentials?.tempPassword || ""}
                    readOnly
                    className="font-mono"
                    data-testid="input-new-admin-password"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={copyNewAdminPassword}
                    data-testid="button-copy-new-admin-password"
                  >
                    {newAdminPasswordCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
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
                  setNewAdminCredentialsDialogOpen(false);
                  setNewAdminCredentials(null);
                  setNewAdminPasswordCopied(false);
                }}
                data-testid="button-close-new-admin-dialog"
              >
                Done
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      {/* Send Invoice Dialog */}
      <Dialog open={isInvoiceDialogOpen} onOpenChange={setIsInvoiceDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Send Invoice</DialogTitle>
            <DialogDescription>
              Create and send a Stripe invoice to the school's billing contact.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Billing Email</Label>
              <Input
                type="email"
                value={invoiceBillingEmail}
                onChange={(e) => setInvoiceBillingEmail(e.target.value)}
                placeholder="billing@school.edu"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Student Count</Label>
                <Input
                  type="number"
                  min={1}
                  value={invoiceStudentCount}
                  onChange={(e) => setInvoiceStudentCount(Number(e.target.value))}
                />
              </div>
              <div className="space-y-2">
                <Label>Days Until Due</Label>
                <Input
                  type="number"
                  min={1}
                  value={invoiceDaysUntilDue}
                  onChange={(e) => setInvoiceDaysUntilDue(Number(e.target.value))}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Base Price ($)</Label>
                <Input
                  type="number"
                  min={0}
                  value={invoiceBasePrice}
                  onChange={(e) => setInvoiceBasePrice(Number(e.target.value))}
                />
              </div>
              <div className="space-y-2">
                <Label>Per Student ($)</Label>
                <Input
                  type="number"
                  min={0}
                  step={0.01}
                  value={invoicePerStudentPrice}
                  onChange={(e) => setInvoicePerStudentPrice(Number(e.target.value))}
                />
              </div>
            </div>
            <div className="p-3 bg-muted rounded-md">
              <div className="flex justify-between text-sm">
                <span>Base fee</span>
                <span>${invoiceBasePrice.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span>{invoiceStudentCount} students × ${invoicePerStudentPrice}</span>
                <span>${(invoiceStudentCount * invoicePerStudentPrice).toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-sm font-bold border-t mt-2 pt-2">
                <span>Total</span>
                <span>${(invoiceBasePrice + invoiceStudentCount * invoicePerStudentPrice).toLocaleString()}</span>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Description (optional)</Label>
              <Input
                value={invoiceDescription}
                onChange={(e) => setInvoiceDescription(e.target.value)}
                placeholder="ClassPilot Annual Plan"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsInvoiceDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={() => {
                sendInvoiceMutation.mutate({
                  studentCount: invoiceStudentCount,
                  basePrice: invoiceBasePrice,
                  perStudentPrice: invoicePerStudentPrice,
                  description: invoiceDescription || undefined,
                  daysUntilDue: invoiceDaysUntilDue,
                  billingEmail: invoiceBillingEmail || undefined,
                });
              }}
              disabled={sendInvoiceMutation.isPending || !invoiceBillingEmail}
            >
              <Send className="w-4 h-4 mr-2" />
              {sendInvoiceMutation.isPending ? 'Sending...' : 'Send Invoice'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Billing Email Dialog */}
      <Dialog open={isEditBillingEmailOpen} onOpenChange={setIsEditBillingEmailOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Billing Email</DialogTitle>
            <DialogDescription>
              Set the email address where invoices will be sent.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Billing Email</Label>
              <Input
                type="email"
                value={newBillingEmail}
                onChange={(e) => setNewBillingEmail(e.target.value)}
                placeholder="billing@school.edu"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditBillingEmailOpen(false)}>Cancel</Button>
            <Button
              onClick={() => updateBillingEmailMutation.mutate(newBillingEmail)}
              disabled={updateBillingEmailMutation.isPending || !newBillingEmail}
            >
              {updateBillingEmailMutation.isPending ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
}
