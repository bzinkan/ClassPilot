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
import { ArrowLeft, Plus, Users, Trash2, Edit, ChevronDown, ChevronRight, X, Cloud, Check, RefreshCw } from "lucide-react";
import { useLocation } from "wouter";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { EditStudentDialog } from "@/components/edit-student-dialog";
import type { Group, Settings } from "@shared/schema";

// Helper to normalize grade levels
function normalizeGrade(grade: string | null | undefined): string | null {
  if (!grade) return null;
  const trimmed = grade.trim();
  if (!trimmed) return null;
  return trimmed.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');
}

const createClassSchema = z.object({
  name: z.string().min(1, "Class name is required"),
  teacherId: z.string().min(1, "Teacher is required"),
  gradeLevel: z.string().optional(),
  periodLabel: z.string().optional(),
  description: z.string().optional(),
});

type CreateClassForm = z.infer<typeof createClassSchema>;

interface Teacher {
  id: string;
  username: string;
  email: string;
  displayName: string | null;
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

interface TeachersResponse {
  teachers: Teacher[];
}

interface StudentsResponse {
  students: Student[];
}

interface ClassroomCoursePreview {
  courseId: string;
  name: string;
  section: string | null;
  room: string | null;
  studentCount: number;
  teacher: {
    id: string;
    displayName: string | null;
    email: string;
  } | null;
  teacherGoogleId: string | null;
  alreadyExists: boolean;
  lastSyncedAt: string;
}

interface ClassCardProps {
  group: Group;
  teacher: Teacher | undefined;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onDelete: () => void;
  isDeleting: boolean;
}

function ClassCard({ group, teacher, isExpanded, onToggleExpand, onDelete, isDeleting }: ClassCardProps) {
  const { toast } = useToast();
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  
  // Fetch students for this class (always fetch to show count)
  const { data: classStudents = [], isLoading } = useQuery<Student[]>({
    queryKey: ["/api/groups", group.id, "students"],
  });

  const removeStudentMutation = useMutation({
    mutationFn: async (studentId: string) => {
      const res = await apiRequest("DELETE", `/api/groups/${group.id}/students/${studentId}`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/groups", group.id, "students"] });
      toast({
        title: "Student removed",
        description: "Student has been removed from the class.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to remove student from class",
        variant: "destructive",
      });
    },
  });

  return (
    <Collapsible
      open={isExpanded}
      onOpenChange={onToggleExpand}
      className="border rounded-lg hover-elevate"
      data-testid={`class-${group.id}`}
    >
      <div className="flex items-center justify-between p-3">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                data-testid={`button-toggle-${group.id}`}
              >
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </Button>
            </CollapsibleTrigger>
            <div className="flex-1">
              <p className="font-medium">{group.name}</p>
              <p className="text-sm text-muted-foreground">
                {teacher?.username || 'Unknown Teacher'}
                {group.periodLabel && ` • ${group.periodLabel}`}
                {group.gradeLevel && ` • Grade ${group.gradeLevel}`}
              </p>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          <div className="text-sm text-muted-foreground">
            {isLoading ? (
              <span className="animate-pulse">...</span>
            ) : (
              <span data-testid={`student-count-${group.id}`}>
                {classStudents.length} {classStudents.length === 1 ? 'student' : 'students'}
              </span>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onDelete}
            disabled={isDeleting}
            data-testid={`button-delete-${group.id}`}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </div>
      
      <CollapsibleContent>
        <div className="px-3 pb-3 pt-0">
          <div className="border-t pt-3">
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading students...</p>
            ) : classStudents.length === 0 ? (
              <p className="text-sm text-muted-foreground">No students assigned yet</p>
            ) : (
              <div className="space-y-2">
                <p className="text-sm font-medium mb-2">Students in this class:</p>
                {classStudents.map((student) => (
                  <div
                    key={student.id}
                    className="flex items-center justify-between pl-4 pr-2 py-1 rounded hover-elevate"
                    data-testid={`student-${student.id}-in-${group.id}`}
                  >
                    <span className="text-sm text-muted-foreground">
                      • {student.studentName}
                      {student.gradeLevel && ` (Grade ${student.gradeLevel})`}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setEditingStudent(student)}
                        data-testid={`button-edit-student-${student.id}`}
                      >
                        <Edit className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => removeStudentMutation.mutate(student.id)}
                        disabled={removeStudentMutation.isPending}
                        data-testid={`button-remove-student-${student.id}`}
                      >
                        <X className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </CollapsibleContent>
      {editingStudent && (
        <EditStudentDialog
          student={editingStudent}
          open={!!editingStudent}
          onOpenChange={(open) => !open && setEditingStudent(null)}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ["/api/groups"], exact: false });
            queryClient.invalidateQueries({ queryKey: ["/api/admin/teacher-students"] });
          }}
        />
      )}
    </Collapsible>
  );
}

export default function AdminClasses() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [selectedGrade, setSelectedGrade] = useState<string>("");
  const [assignStudentsGrade, setAssignStudentsGrade] = useState<string>("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [selectedStudents, setSelectedStudents] = useState<Set<string>>(new Set());
  const [selectedClassId, setSelectedClassId] = useState<string>("");
  const [expandedClasses, setExpandedClasses] = useState<Set<string>>(new Set());
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);
  const [selectedCourses, setSelectedCourses] = useState<Set<string>>(new Set());
  const [courseTeacherOverrides, setCourseTeacherOverrides] = useState<Map<string, string>>(new Map());
  const [courseGradeLevels, setCourseGradeLevels] = useState<Map<string, string>>(new Map());

  const form = useForm<CreateClassForm>({
    resolver: zodResolver(createClassSchema),
    defaultValues: {
      name: "",
      teacherId: "",
      gradeLevel: "",
      periodLabel: "",
      description: "",
    },
  });

  // Queries
  const { data: teachersData } = useQuery<TeachersResponse>({
    queryKey: ["/api/admin/teachers"],
  });

  const { data: studentsData } = useQuery<StudentsResponse>({
    queryKey: ["/api/admin/teacher-students"],
  });

  const { data: allGroups = [] } = useQuery<Group[]>({
    queryKey: ["/api/teacher/groups"],
  });

  const { data: settings } = useQuery<Settings>({
    queryKey: ["/api/settings"],
  });

  const { data: classroomCourses = [], isLoading: isLoadingCourses, refetch: refetchCourses } = useQuery<ClassroomCoursePreview[]>({
    queryKey: ["/api/admin/classroom/courses-preview"],
    enabled: syncDialogOpen,
  });

  const teachers = teachersData?.teachers || [];
  const allStudents = studentsData?.students || [];

  // Get available grades from BOTH students AND classes (so empty classes show up in tabs)
  const adminClasses = allGroups.filter(g => g.groupType === 'admin_class');
  const gradesFromStudents = allStudents
    .map(s => normalizeGrade(s.gradeLevel))
    .filter((g): g is string => g !== null);
  const gradesFromClasses = adminClasses
    .map(c => normalizeGrade(c.gradeLevel))
    .filter((g): g is string => g !== null);
  
  const availableGrades = Array.from(
    new Set([...gradesFromStudents, ...gradesFromClasses])
  ).sort((a, b) => {
    const numA = parseInt(a);
    const numB = parseInt(b);
    return isNaN(numA) || isNaN(numB) ? a.localeCompare(b) : numA - numB;
  });

  // Filter students by selected grade (for assign students section - independent filter)
  const assignFilteredStudents = assignStudentsGrade
    ? allStudents.filter(s => normalizeGrade(s.gradeLevel) === assignStudentsGrade)
    : allStudents;

  // Filter classes by selected grade
  const filteredClasses = selectedGrade
    ? adminClasses.filter(g => normalizeGrade(g.gradeLevel) === selectedGrade)
    : adminClasses;

  // Create class mutation
  const createClassMutation = useMutation({
    mutationFn: async (data: CreateClassForm) => {
      const res = await apiRequest("POST", "/api/teacher/groups", {
        ...data,
        groupType: "admin_class",
        schoolId: settings?.schoolId || "default-school",
      });
      return res.json();
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/teacher/groups"], exact: false });
      toast({
        title: "Class Created",
        description: "Class roster has been created successfully",
      });
      setCreateDialogOpen(false);
      form.reset();
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    },
  });

  // Assign students mutation
  const assignStudentsMutation = useMutation({
    mutationFn: async ({ classId, studentIds }: { classId: string; studentIds: string[] }) => {
      const results = await Promise.all(
        studentIds.map(studentId =>
          apiRequest("POST", `/api/groups/${classId}/students/${studentId}`, {})
        )
      );
      return results;
    },
    onSuccess: async () => {
      // Invalidate both /api/groups and /api/teacher/groups to ensure UI updates
      await queryClient.invalidateQueries({ queryKey: ["/api/groups"], exact: false });
      await queryClient.invalidateQueries({ queryKey: ["/api/teacher/groups"], exact: false });
      toast({
        title: "Students Assigned",
        description: `${selectedStudents.size} students added to class`,
      });
      setSelectedStudents(new Set());
      setSelectedClassId("");
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    },
  });

  // Delete class mutation
  const deleteClassMutation = useMutation({
    mutationFn: async (classId: string) => {
      const res = await apiRequest("DELETE", `/api/teacher/groups/${classId}`, {});
      return res.json();
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/teacher/groups"], exact: false });
      toast({
        title: "Class Deleted",
        description: "Class roster has been deleted",
      });
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    },
  });

  // Create class from Google Classroom course mutation
  const createFromClassroomMutation = useMutation({
    mutationFn: async (course: ClassroomCoursePreview) => {
      const overrideTeacherId = courseTeacherOverrides.get(course.courseId);
      const teacherId = overrideTeacherId || course.teacher?.id;
      if (!teacherId) {
        throw new Error("No teacher assigned to this course. Please select a teacher.");
      }
      const gradeLevel = courseGradeLevels.get(course.courseId);
      const res = await apiRequest("POST", "/api/admin/classroom/create-class", {
        courseId: course.courseId,
        teacherId,
        gradeLevel: gradeLevel || undefined,
      });
      return res.json();
    },
    onSuccess: async (_, course) => {
      await queryClient.invalidateQueries({ queryKey: ["/api/teacher/groups"], exact: false });
      await refetchCourses();
      setSelectedCourses((prev) => {
        const newSet = new Set(prev);
        newSet.delete(course.courseId);
        return newSet;
      });
      toast({
        title: "Class Created",
        description: `"${course.name}" has been imported from Google Classroom`,
      });
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message,
      });
    },
  });

  // Sync courses from Google Classroom (actually fetches from Google API)
  const syncFromGoogleMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("GET", "/api/classroom/courses");
      return res.json();
    },
    onSuccess: async () => {
      await refetchCourses();
      toast({
        title: "Sync Complete",
        description: "Google Classroom courses have been synced",
      });
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Sync Failed",
        description: error.message,
      });
    },
  });

  const onSubmit = (data: CreateClassForm) => {
    createClassMutation.mutate(data);
  };

  const handleAssignStudents = () => {
    if (!selectedClassId || selectedStudents.size === 0) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Please select a class and at least one student",
      });
      return;
    }
    assignStudentsMutation.mutate({
      classId: selectedClassId,
      studentIds: Array.from(selectedStudents),
    });
  };

  const toggleStudentSelection = (studentId: string) => {
    const newSelection = new Set(selectedStudents);
    if (newSelection.has(studentId)) {
      newSelection.delete(studentId);
    } else {
      newSelection.add(studentId);
    }
    setSelectedStudents(newSelection);
  };

  const selectAllFilteredStudents = () => {
    const newSelection = new Set(selectedStudents);
    assignFilteredStudents.forEach(student => {
      newSelection.add(student.id);
    });
    setSelectedStudents(newSelection);
  };

  const clearAllSelections = () => {
    setSelectedStudents(new Set());
  };

  const toggleCourseSelection = (courseId: string) => {
    setSelectedCourses((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(courseId)) {
        newSet.delete(courseId);
      } else {
        newSet.add(courseId);
      }
      return newSet;
    });
  };

  const importableCoursesCount = classroomCourses.filter(c => !c.alreadyExists && (c.teacher || courseTeacherOverrides.has(c.courseId))).length;

  const handleImportSelectedCourses = async () => {
    const coursesToImport = classroomCourses.filter(
      c => selectedCourses.has(c.courseId) && !c.alreadyExists && (c.teacher || courseTeacherOverrides.has(c.courseId))
    );
    for (const course of coursesToImport) {
      createFromClassroomMutation.mutate(course);
    }
  };

  const setTeacherOverride = (courseId: string, teacherId: string) => {
    setCourseTeacherOverrides((prev) => {
      const newMap = new Map(prev);
      if (teacherId) {
        newMap.set(courseId, teacherId);
      } else {
        newMap.delete(courseId);
      }
      return newMap;
    });
  };

  const setCourseGradeLevel = (courseId: string, gradeLevel: string) => {
    setCourseGradeLevels((prev) => {
      const newMap = new Map(prev);
      if (gradeLevel) {
        newMap.set(courseId, gradeLevel);
      } else {
        newMap.delete(courseId);
      }
      return newMap;
    });
  };

  return (
    <div className="min-h-screen">
      <div className="container mx-auto p-6 max-w-7xl space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setLocation("/admin")}
            data-testid="button-back"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">Class Management</h1>
            <p className="text-muted-foreground text-sm">Create and manage class rosters for teachers</p>
          </div>
        </div>
        <ThemeToggle />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column: Create Class & Class List */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Plus className="h-5 w-5" />
                Create New Class
              </CardTitle>
              <CardDescription>
                Create an official class roster for a teacher
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
                <DialogTrigger asChild>
                  <Button className="w-full" data-testid="button-create-class">
                    <Plus className="h-4 w-4 mr-2" />
                    Create Class
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-md">
                  <DialogHeader>
                    <DialogTitle>Create New Class</DialogTitle>
                    <DialogDescription>
                      Create an official class roster and assign it to a teacher
                    </DialogDescription>
                  </DialogHeader>
                  <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="name">Class Name *</Label>
                      <Input
                        id="name"
                        placeholder="e.g., 7th Science P3"
                        data-testid="input-class-name"
                        {...form.register("name")}
                      />
                      {form.formState.errors.name && (
                        <p className="text-sm text-destructive">{form.formState.errors.name.message}</p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="teacherId">Teacher *</Label>
                      <Select
                        value={form.watch("teacherId")}
                        onValueChange={(value) => form.setValue("teacherId", value)}
                      >
                        <SelectTrigger data-testid="select-teacher">
                          <SelectValue placeholder="Select a teacher" />
                        </SelectTrigger>
                        <SelectContent>
                          {teachers.filter(t => t.role === 'teacher' || t.role === 'school_admin').map((teacher) => (
                            <SelectItem key={teacher.id} value={teacher.id}>
                              {teacher.displayName || teacher.email || teacher.username} {teacher.role === 'school_admin' ? '(Admin)' : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {form.formState.errors.teacherId && (
                        <p className="text-sm text-destructive">{form.formState.errors.teacherId.message}</p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="gradeLevel">Grade Level</Label>
                      <Input
                        id="gradeLevel"
                        placeholder="e.g., 7"
                        data-testid="input-grade-level"
                        {...form.register("gradeLevel")}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="periodLabel">Period</Label>
                      <Input
                        id="periodLabel"
                        placeholder="e.g., P3 or 10:10-10:55"
                        data-testid="input-period-label"
                        {...form.register("periodLabel")}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="description">Description</Label>
                      <Input
                        id="description"
                        placeholder="Optional description"
                        data-testid="input-description"
                        {...form.register("description")}
                      />
                    </div>

                    <Button
                      type="submit"
                      className="w-full"
                      disabled={createClassMutation.isPending}
                      data-testid="button-submit-class"
                    >
                      {createClassMutation.isPending ? "Creating..." : "Create Class"}
                    </Button>
                  </form>
                </DialogContent>
              </Dialog>

              <div className="relative my-4">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-background px-2 text-muted-foreground">or</span>
                </div>
              </div>

              <Dialog open={syncDialogOpen} onOpenChange={(open) => {
                setSyncDialogOpen(open);
                if (!open) {
                  setSelectedCourses(new Set());
                  setCourseTeacherOverrides(new Map());
                  setCourseGradeLevels(new Map());
                }
              }}>
                <DialogTrigger asChild>
                  <Button variant="outline" className="w-full" data-testid="button-sync-classroom">
                    <Cloud className="h-4 w-4 mr-2" />
                    Sync from Google Classroom
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                      <Cloud className="h-5 w-5" />
                      Import from Google Classroom
                    </DialogTitle>
                    <DialogDescription>
                      Select courses to import as ClassPilot classes. Students will be automatically assigned.
                    </DialogDescription>
                  </DialogHeader>

                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-muted-foreground">
                        {isLoadingCourses || syncFromGoogleMutation.isPending
                          ? "Syncing courses from Google..."
                          : `${importableCoursesCount} courses available to import`}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => syncFromGoogleMutation.mutate()}
                        disabled={isLoadingCourses || syncFromGoogleMutation.isPending}
                        data-testid="button-refresh-courses"
                      >
                        <RefreshCw className={`h-4 w-4 mr-2 ${isLoadingCourses || syncFromGoogleMutation.isPending ? 'animate-spin' : ''}`} />
                        Sync from Google
                      </Button>
                    </div>

                    {isLoadingCourses || syncFromGoogleMutation.isPending ? (
                      <div className="py-8 text-center text-muted-foreground">
                        Fetching courses from Google Classroom...
                      </div>
                    ) : classroomCourses.length === 0 ? (
                      <div className="py-8 text-center text-muted-foreground">
                        <p>No Google Classroom courses found.</p>
                        <p className="text-sm mt-2">Click "Sync from Google" to fetch your courses.</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {classroomCourses.map((course) => {
                          const hasTeacher = course.teacher || courseTeacherOverrides.has(course.courseId);
                          const isDisabled = course.alreadyExists;
                          const isSelected = selectedCourses.has(course.courseId);
                          const overrideTeacherId = courseTeacherOverrides.get(course.courseId);
                          const courseGradeLevel = courseGradeLevels.get(course.courseId);
                          return (
                            <div
                              key={course.courseId}
                              className={`flex items-center gap-3 p-3 rounded-lg border ${
                                isDisabled ? 'opacity-60 bg-muted/50' : 'hover-elevate'
                              } ${isSelected ? 'border-primary bg-primary/5' : ''}`}
                              data-testid={`course-row-${course.courseId}`}
                            >
                              <Checkbox
                                checked={isSelected}
                                disabled={isDisabled || !hasTeacher}
                                onCheckedChange={() => !isDisabled && hasTeacher && toggleCourseSelection(course.courseId)}
                                data-testid={`checkbox-course-${course.courseId}`}
                              />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <p className="font-medium truncate">{course.name}</p>
                                  {course.alreadyExists && (
                                    <span className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 px-2 py-0.5 rounded-full flex items-center gap-1">
                                      <Check className="h-3 w-3" />
                                      Already exists
                                    </span>
                                  )}
                                </div>
                                <div className="text-sm text-muted-foreground flex items-center gap-2 flex-wrap">
                                  {course.teacher ? (
                                    <span>{course.teacher.displayName || course.teacher.email}</span>
                                  ) : (
                                    <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                                      <Select
                                        value={overrideTeacherId || ""}
                                        onValueChange={(val) => setTeacherOverride(course.courseId, val)}
                                      >
                                        <SelectTrigger className="h-7 w-[180px] text-xs" data-testid={`select-teacher-override-${course.courseId}`}>
                                          <SelectValue placeholder="Select teacher..." />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {teachers.filter(t => t.role === 'teacher' || t.role === 'school_admin').map((teacher) => (
                                            <SelectItem key={teacher.id} value={teacher.id}>
                                              {teacher.displayName || teacher.email || teacher.username} {teacher.role === 'school_admin' ? '(Admin)' : ''}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                      {!overrideTeacherId && (
                                        <span className="text-amber-600 dark:text-amber-400 text-xs">No matching teacher</span>
                                      )}
                                    </div>
                                  )}
                                  {course.section && <span>• {course.section}</span>}
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                {!isDisabled && (
                                  <div onClick={(e) => e.stopPropagation()}>
                                    <Select
                                      value={courseGradeLevel || ""}
                                      onValueChange={(val) => setCourseGradeLevel(course.courseId, val)}
                                    >
                                      <SelectTrigger className="h-7 w-[90px] text-xs" data-testid={`select-grade-${course.courseId}`}>
                                        <SelectValue placeholder="Grade" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="">No grade</SelectItem>
                                        <SelectItem value="K">K</SelectItem>
                                        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((g) => (
                                          <SelectItem key={g} value={String(g)}>
                                            {g}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </div>
                                )}
                                <div className="text-sm text-muted-foreground whitespace-nowrap">
                                  {course.studentCount} students
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <DialogFooter className="mt-4">
                    <Button
                      variant="outline"
                      onClick={() => setSyncDialogOpen(false)}
                      data-testid="button-cancel-sync"
                    >
                      Cancel
                    </Button>
                    <Button
                      onClick={handleImportSelectedCourses}
                      disabled={selectedCourses.size === 0 || createFromClassroomMutation.isPending}
                      data-testid="button-import-courses"
                    >
                      {createFromClassroomMutation.isPending ? "Importing..." : `Import ${selectedCourses.size} Course(s)`}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                Classes
              </CardTitle>
              <CardDescription>
                {filteredClasses.length} {selectedGrade ? `class(es) in Grade ${selectedGrade}` : "total classes"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Tabs value={selectedGrade} onValueChange={setSelectedGrade} className="w-full">
                <TabsList className="w-full justify-start flex-wrap h-auto">
                  <TabsTrigger value="" className="flex-shrink-0" data-testid="grade-tab-all">
                    All Grades
                  </TabsTrigger>
                  {availableGrades.map((grade) => (
                    <TabsTrigger 
                      key={grade} 
                      value={grade} 
                      className="flex-shrink-0"
                      data-testid={`grade-tab-${grade}`}
                    >
                      Grade {grade}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>

              <div className="space-y-2">
                {filteredClasses.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Users className="h-12 w-12 mx-auto mb-3 text-muted-foreground/30" />
                    <p className="text-sm">
                      {selectedGrade ? `No classes in Grade ${selectedGrade}` : "No classes created yet"}
                    </p>
                  </div>
                ) : (
                  filteredClasses.map((group) => {
                    const teacher = teachers.find(t => t.id === group.teacherId);
                    const isExpanded = expandedClasses.has(group.id);
                    
                    const toggleExpand = () => {
                      const newExpanded = new Set(expandedClasses);
                      if (newExpanded.has(group.id)) {
                        newExpanded.delete(group.id);
                      } else {
                        newExpanded.add(group.id);
                      }
                      setExpandedClasses(newExpanded);
                    };
                    
                    return (
                      <ClassCard
                        key={group.id}
                        group={group}
                        teacher={teacher}
                        isExpanded={isExpanded}
                        onToggleExpand={toggleExpand}
                        onDelete={() => deleteClassMutation.mutate(group.id)}
                        isDeleting={deleteClassMutation.isPending}
                      />
                    );
                  })
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Column: Assign Students */}
        <Card>
          <CardHeader>
            <CardTitle>Assign Students to Class</CardTitle>
            <CardDescription>
              Select a class and add students to its roster
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="class-select">Select Class</Label>
              <Select
                value={selectedClassId}
                onValueChange={setSelectedClassId}
              >
                <SelectTrigger data-testid="select-class">
                  <SelectValue placeholder="Choose a class" />
                </SelectTrigger>
                <SelectContent>
                  {filteredClasses.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name} ({teachers.find(t => t.id === group.teacherId)?.username})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Select Students ({selectedStudents.size} selected)</Label>
              
              {/* Grade filter tabs for students */}
              <Tabs value={assignStudentsGrade} onValueChange={setAssignStudentsGrade} className="w-full">
                <TabsList className="w-full justify-start flex-wrap h-auto">
                  <TabsTrigger value="" className="flex-shrink-0" data-testid="assign-grade-tab-all">
                    All Grades
                  </TabsTrigger>
                  {availableGrades.map((grade) => (
                    <TabsTrigger 
                      key={grade} 
                      value={grade}
                      className="flex-shrink-0"
                      data-testid={`assign-grade-tab-${grade}`}
                    >
                      Grade {grade}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              
              {/* Select All / Clear buttons */}
              {assignFilteredStudents.length > 0 && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={selectAllFilteredStudents}
                    data-testid="button-select-all-students"
                  >
                    Select All {assignStudentsGrade ? `Grade ${assignStudentsGrade}` : ''}
                    {assignStudentsGrade && ` (${assignFilteredStudents.length})`}
                  </Button>
                  {selectedStudents.size > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={clearAllSelections}
                      data-testid="button-clear-selection"
                    >
                      Clear Selection
                    </Button>
                  )}
                </div>
              )}
              
              <div className="border rounded-lg p-4 max-h-96 overflow-y-auto space-y-2">
                {assignFilteredStudents.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    {assignStudentsGrade ? `No students in Grade ${assignStudentsGrade}` : "No students available"}
                  </p>
                ) : (
                  assignFilteredStudents.map((student) => (
                    <div
                      key={student.id}
                      className="flex items-center space-x-2 p-2 rounded hover-elevate"
                      data-testid={`student-${student.id}`}
                    >
                      <Checkbox
                        id={`student-${student.id}`}
                        checked={selectedStudents.has(student.id)}
                        onCheckedChange={() => toggleStudentSelection(student.id)}
                        data-testid={`checkbox-student-${student.id}`}
                      />
                      <Label
                        htmlFor={`student-${student.id}`}
                        className="flex-1 cursor-pointer text-sm font-normal"
                      >
                        {student.studentName}
                        {student.gradeLevel && (
                          <span className="text-muted-foreground ml-2">
                            • Grade {student.gradeLevel}
                          </span>
                        )}
                      </Label>
                    </div>
                  ))
                )}
              </div>
            </div>

            <Button
              onClick={handleAssignStudents}
              disabled={!selectedClassId || selectedStudents.size === 0 || assignStudentsMutation.isPending}
              className="w-full"
              data-testid="button-assign-students"
            >
              {assignStudentsMutation.isPending 
                ? "Assigning..." 
                : `Assign ${selectedStudents.size} Student${selectedStudents.size !== 1 ? 's' : ''}`}
            </Button>
          </CardContent>
        </Card>
      </div>
      </div>
    </div>
  );
}
