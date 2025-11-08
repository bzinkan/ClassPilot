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
import { Trash2, UserPlus, Users, ArrowLeft, AlertTriangle, UserCheck, Clock, Settings as SettingsIcon } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Settings, Session, Group } from "@shared/schema";

// Helper to normalize grade levels (strip "th", "rd", "st", "nd" suffixes)
function normalizeGrade(grade: string | null | undefined): string | null {
  if (!grade) return null;
  const trimmed = grade.trim();
  if (!trimmed) return null;
  // Remove ordinal suffixes (1st, 2nd, 3rd, 4th, etc.)
  return trimmed.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');
}

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

interface Student {
  id: string;
  studentName: string;
  studentEmail: string;
  gradeLevel: string | null;
  deviceId: string;
}

interface Assignment {
  teacherId: string;
  teacherName: string;
  studentIds: string[];
}

interface TeachersResponse {
  teachers: Teacher[];
}

interface AssignmentsResponse {
  students: Student[];
  assignments: Assignment[];
}

export default function Admin() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [teacherToDelete, setTeacherToDelete] = useState<Teacher | null>(null);
  const [cleanupDialogOpen, setCleanupDialogOpen] = useState(false);
  const [selectedTeacherId, setSelectedTeacherId] = useState<string>("");
  const [selectedStudentIds, setSelectedStudentIds] = useState<Set<string>>(new Set());
  const [selectedGradeFilter, setSelectedGradeFilter] = useState<string>("");
  const [enableTrackingHours, setEnableTrackingHours] = useState(false);
  const [trackingStartTime, setTrackingStartTime] = useState("08:00");
  const [trackingEndTime, setTrackingEndTime] = useState("15:00");
  const [schoolTimezone, setSchoolTimezone] = useState("America/New_York");
  const [trackingDays, setTrackingDays] = useState<string[]>(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]);

  const form = useForm<CreateTeacherForm>({
    resolver: zodResolver(createTeacherSchema),
    defaultValues: {
      username: "",
      password: "",
      schoolName: "",
    },
  });

  const { data: teachersData, isLoading } = useQuery<TeachersResponse>({
    queryKey: ["/api/admin/teachers"],
  });

  const { data: assignmentsData, isLoading: isLoadingAssignments } = useQuery<AssignmentsResponse>({
    queryKey: ["/api/admin/teacher-students"],
  });

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

  const assignStudentsMutation = useMutation({
    mutationFn: async ({ teacherId, studentIds }: { teacherId: string; studentIds: string[] }) => {
      return await apiRequest("POST", `/api/admin/teacher-students/${teacherId}`, { studentIds });
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/teacher-students"] });
      toast({
        title: "Assignments updated",
        description: data.message || "Student assignments have been updated successfully.",
      });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to update assignments",
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
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
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

  const migrateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/migrate-to-groups", {});
      return res.json();
    },
    onSuccess: async (data: any) => {
      // Invalidate all group-related caches with prefix matching
      await queryClient.invalidateQueries({ 
        queryKey: ['/api/teacher/groups'],
        exact: false  
      });
      await queryClient.invalidateQueries({ 
        queryKey: ['/api/groups'],
        exact: false  // This will match all /api/groups/* queries
      });
      await queryClient.invalidateQueries({ 
        queryKey: ['/api/sessions/active'],
        exact: false  
      });
      await queryClient.invalidateQueries({ 
        queryKey: ['/api/sessions/all'],
        exact: false  
      });
      // Force immediate refetch
      await queryClient.refetchQueries({ queryKey: ['/api/teacher/groups'] });
      toast({
        title: "Migration completed",
        description: `Created ${data.groupsCreated} groups and assigned ${data.studentsAssigned} students.`,
      });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Migration failed",
        description: error.message || "An error occurred during migration",
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
    }
  }, [settings]);

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

  const handleTeacherSelect = (teacherId: string) => {
    setSelectedTeacherId(teacherId);
    
    // Find current assignments for this teacher
    const assignment = assignmentsData?.assignments?.find(
      (a: Assignment) => a.teacherId === teacherId
    );
    
    setSelectedStudentIds(new Set(assignment?.studentIds || []));
  };

  const handleStudentToggle = (studentId: string, checked: boolean) => {
    const newSet = new Set(selectedStudentIds);
    if (checked) {
      newSet.add(studentId);
    } else {
      newSet.delete(studentId);
    }
    setSelectedStudentIds(newSet);
  };

  const handleSaveAssignments = () => {
    if (!selectedTeacherId) {
      toast({
        variant: "destructive",
        title: "No teacher selected",
        description: "Please select a teacher first.",
      });
      return;
    }

    assignStudentsMutation.mutate({
      teacherId: selectedTeacherId,
      studentIds: Array.from(selectedStudentIds),
    });
  };

  const teachers = teachersData?.teachers || [];
  const students = assignmentsData?.students || [];
  const assignments = assignmentsData?.assignments || [];

  // Use all available grade levels from settings (like dashboard does)
  const availableGrades = settings?.gradeLevels || [];

  // Filter students by grade (normalize both sides for comparison)
  const filteredStudents = selectedGradeFilter 
    ? students.filter((s: Student) => 
        normalizeGrade(s.gradeLevel) === normalizeGrade(selectedGradeFilter)
      )
    : students;

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
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button
            variant="outline"
            onClick={() => setLocation("/dashboard")}
            data-testid="button-back-dashboard"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dashboard
          </Button>
        </div>
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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserCheck className="h-5 w-5" />
            Assign Students to Teachers
          </CardTitle>
          <CardDescription>
            Manage which students each teacher can see on their dashboard
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoadingAssignments ? (
            <div className="text-center py-8 text-muted-foreground">
              Loading assignments...
            </div>
          ) : teachers.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              Create a teacher account first to assign students.
            </div>
          ) : students.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No students registered yet. Students will appear here once they connect with the Chrome extension.
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="teacher-select">Select Teacher</Label>
                <Select
                  value={selectedTeacherId}
                  onValueChange={handleTeacherSelect}
                >
                  <SelectTrigger data-testid="select-teacher" className="w-full">
                    <SelectValue placeholder="Choose a teacher..." />
                  </SelectTrigger>
                  <SelectContent>
                    {teachers.map((teacher: Teacher) => (
                      <SelectItem key={teacher.id} value={teacher.id}>
                        {teacher.username} ({teacher.schoolName})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {selectedTeacherId && (
                <>
                  {/* Grade Filter Tabs */}
                  {availableGrades.length > 0 && (
                    <div className="space-y-2">
                      <Label>Filter by Grade</Label>
                      <Tabs 
                        value={selectedGradeFilter} 
                        onValueChange={setSelectedGradeFilter}
                        className="w-full"
                      >
                        <TabsList className="w-full justify-start flex-wrap h-auto">
                          <TabsTrigger 
                            value="" 
                            data-testid="grade-tab-all"
                            className="flex-shrink-0"
                          >
                            All Grades
                          </TabsTrigger>
                          {availableGrades.map((grade) => (
                            <TabsTrigger 
                              key={grade} 
                              value={grade}
                              data-testid={`grade-tab-${grade}`}
                              className="flex-shrink-0"
                            >
                              {grade}
                            </TabsTrigger>
                          ))}
                        </TabsList>
                      </Tabs>
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label>
                      Students ({selectedStudentIds.size} selected
                      {selectedGradeFilter && ` • Showing ${filteredStudents.length} in ${selectedGradeFilter}`})
                    </Label>
                    <div className="border rounded-lg p-4 max-h-96 overflow-y-auto space-y-3">
                      {filteredStudents.length === 0 ? (
                        <div className="text-center py-8 text-muted-foreground">
                          {selectedGradeFilter 
                            ? `No students found in ${selectedGradeFilter}`
                            : "No students available"
                          }
                        </div>
                      ) : (
                        filteredStudents.map((student: Student) => (
                          <div
                            key={student.id}
                            className="flex items-center space-x-3 p-2 rounded-md hover-elevate"
                            data-testid={`student-row-${student.id}`}
                          >
                            <Checkbox
                              id={`student-${student.id}`}
                              data-testid={`checkbox-student-${student.id}`}
                              checked={selectedStudentIds.has(student.id)}
                              onCheckedChange={(checked) => 
                                handleStudentToggle(student.id, checked as boolean)
                              }
                            />
                            <label
                              htmlFor={`student-${student.id}`}
                              className="flex-1 cursor-pointer"
                            >
                              <p className="font-medium">{student.studentName}</p>
                              <p className="text-sm text-muted-foreground">
                                {student.studentEmail}
                                {student.gradeLevel && ` • ${student.gradeLevel}`}
                              </p>
                            </label>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <Button
                    onClick={handleSaveAssignments}
                    data-testid="button-save-assignments"
                    disabled={assignStudentsMutation.isPending}
                    className="w-full"
                  >
                    {assignStudentsMutation.isPending ? "Saving..." : "Save Assignments"}
                  </Button>
                </>
              )}
            </>
          )}
        </CardContent>
      </Card>

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
            </div>
          )}

          <Button
            onClick={() => updateTrackingHoursMutation.mutate()}
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
            Groups Migration
          </CardTitle>
          <CardDescription>
            Convert existing teacher-student assignments to the new groups system
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="bg-muted p-4 rounded-lg">
            <p className="text-sm mb-2">
              <strong>One-time migration:</strong> This will create default groups for each teacher.
            </p>
            <ul className="text-sm space-y-1 list-disc list-inside text-muted-foreground">
              <li>Creates an "All Students" group for each teacher</li>
              <li>Assigns existing students to their teacher's default group</li>
              <li>Enables session-based classroom management</li>
            </ul>
            <p className="text-sm mt-3 text-muted-foreground">
              Safe to run multiple times - will not create duplicates.
            </p>
          </div>
          <Button
            variant="default"
            data-testid="button-migrate-groups"
            onClick={() => migrateMutation.mutate()}
            disabled={migrateMutation.isPending}
          >
            {migrateMutation.isPending ? "Migrating..." : "Run Migration"}
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
                const teacher = teachers.find(t => t.id === session.teacherId);
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
                          {teacher?.username || 'Unknown Teacher'} • Started {new Date(session.startTime).toLocaleTimeString()}
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
