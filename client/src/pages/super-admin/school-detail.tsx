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
import { ArrowLeft, Building2, Plus, Mail, User } from "lucide-react";

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
      const result = await apiRequest("POST", `/api/super-admin/schools/${schoolId}/admins`, data);
      return result;
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: [`/api/super-admin/schools/${schoolId}`] });
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/schools'] });
      
      toast({
        title: "Admin added successfully",
        description: `Temporary password: ${data.tempPassword}`,
        duration: 10000,
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
        </div>

        <div className="grid gap-4 md:grid-cols-3 mb-6">
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
              <p className="text-xs text-muted-foreground">
                Max: {school.maxLicenses}
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>School Admins</CardTitle>
                <Dialog open={isAddAdminOpen} onOpenChange={setIsAddAdminOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm" data-testid="button-add-admin">
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
      </div>
    </div>
  );
}
