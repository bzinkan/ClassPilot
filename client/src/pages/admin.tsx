import { useState } from "react";
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
import { Trash2, UserPlus, Users, ArrowLeft, AlertTriangle } from "lucide-react";
import { useLocation } from "wouter";
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

const createTeacherSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  schoolName: z.string().optional(),
});

type CreateTeacherForm = z.infer<typeof createTeacherSchema>;

interface Teacher {
  id: string;
  username: string;
  role: string;
  schoolName: string;
}

export default function Admin() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [teacherToDelete, setTeacherToDelete] = useState<Teacher | null>(null);
  const [cleanupDialogOpen, setCleanupDialogOpen] = useState(false);

  const form = useForm<CreateTeacherForm>({
    resolver: zodResolver(createTeacherSchema),
    defaultValues: {
      username: "",
      password: "",
      schoolName: "",
    },
  });

  const { data: teachersData, isLoading } = useQuery({
    queryKey: ["/api/admin/teachers"],
  });

  const createTeacherMutation = useMutation({
    mutationFn: async (data: CreateTeacherForm) => {
      return await apiRequest("POST", "/api/admin/teachers", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/teachers"] });
      form.reset();
      toast({
        title: "Teacher created",
        description: "The teacher account has been created successfully.",
      });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to create teacher",
        description: error.message || "An error occurred",
      });
    },
  });

  const deleteTeacherMutation = useMutation({
    mutationFn: async (id: string) => {
      return await apiRequest("DELETE", `/api/admin/teachers/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/teachers"] });
      toast({
        title: "Teacher deleted",
        description: "The teacher account has been deleted successfully.",
      });
      setDeleteDialogOpen(false);
      setTeacherToDelete(null);
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to delete teacher",
        description: error.message || "An error occurred",
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

  const onSubmit = (data: CreateTeacherForm) => {
    createTeacherMutation.mutate(data);
  };

  const handleDeleteClick = (teacher: Teacher) => {
    setTeacherToDelete(teacher);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = () => {
    if (teacherToDelete) {
      deleteTeacherMutation.mutate(teacherToDelete.id);
    }
  };

  const teachers = teachersData?.teachers || [];

  return (
    <div className="container mx-auto p-6 max-w-6xl space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-lg bg-primary flex items-center justify-center">
            <Users className="h-6 w-6 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-3xl font-semibold">Admin Dashboard</h1>
            <p className="text-muted-foreground">Manage teacher accounts for your school</p>
          </div>
        </div>
        <Button
          variant="outline"
          onClick={() => setLocation("/dashboard")}
          data-testid="button-back-dashboard"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Dashboard
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5" />
              Create Teacher Account
            </CardTitle>
            <CardDescription>
              Add a new teacher to the system
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  data-testid="input-teacher-username"
                  type="text"
                  placeholder="e.g., john.smith"
                  {...form.register("username")}
                />
                {form.formState.errors.username && (
                  <p className="text-sm text-destructive">
                    {form.formState.errors.username.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  data-testid="input-teacher-password"
                  type="password"
                  placeholder="At least 6 characters"
                  {...form.register("password")}
                />
                {form.formState.errors.password && (
                  <p className="text-sm text-destructive">
                    {form.formState.errors.password.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="schoolName">School Name (Optional)</Label>
                <Input
                  id="schoolName"
                  data-testid="input-teacher-school"
                  type="text"
                  placeholder="e.g., Lincoln High School"
                  {...form.register("schoolName")}
                />
              </div>

              <Button
                type="submit"
                data-testid="button-create-teacher"
                className="w-full"
                disabled={createTeacherMutation.isPending}
              >
                {createTeacherMutation.isPending ? "Creating..." : "Create Teacher Account"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Teacher Accounts</CardTitle>
            <CardDescription>
              {teachers.length} {teachers.length === 1 ? "teacher" : "teachers"} in the system
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-center py-8 text-muted-foreground">
                Loading teachers...
              </div>
            ) : teachers.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No teachers yet. Create one to get started!
              </div>
            ) : (
              <div className="space-y-2">
                {teachers.map((teacher: Teacher) => (
                  <div
                    key={teacher.id}
                    data-testid={`teacher-row-${teacher.id}`}
                    className="flex items-center justify-between p-3 rounded-lg border hover-elevate"
                  >
                    <div>
                      <p className="font-medium" data-testid={`teacher-username-${teacher.id}`}>
                        {teacher.username}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {teacher.role === 'admin' ? '👑 Admin' : '👤 Teacher'} • {teacher.schoolName}
                      </p>
                    </div>
                    {teacher.role !== 'admin' && (
                      <Button
                        variant="ghost"
                        size="icon"
                        data-testid={`button-delete-${teacher.id}`}
                        onClick={() => handleDeleteClick(teacher)}
                        disabled={deleteTeacherMutation.isPending}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

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

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Teacher Account</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the account for{" "}
              <strong>{teacherToDelete?.username}</strong>? This action cannot be undone.
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
    </div>
  );
}
