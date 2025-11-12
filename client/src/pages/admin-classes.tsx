import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateStudentCaches } from "@/lib/cacheUtils";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Plus, Users, Trash2, Edit, ChevronDown, ChevronRight, X } from "lucide-react";
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

const editStudentSchema = z.object({
  studentName: z.string().min(1, "Name is required"),
  studentEmail: z.string().email("Invalid email format"),
  gradeLevel: z.string().optional(),
});

type EditStudentForm = z.infer<typeof editStudentSchema>;

const createStudentSchema = z.object({
  studentName: z.string().min(1, "Name is required"),
  studentEmail: z.string().email("Invalid email format"),
  gradeLevel: z.string().min(1, "Grade level is required"),
  classId: z.string().optional(),
});

type CreateStudentForm = z.infer<typeof createStudentSchema>;

// Predefined grade options
const GRADE_OPTIONS = ['K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];

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

interface TeachersResponse {
  teachers: Teacher[];
}

interface StudentsResponse {
  students: Student[];
}

interface EditStudentDialogProps {
  student: Student;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function EditStudentDialog({ student, open, onOpenChange }: EditStudentDialogProps) {
  const { toast } = useToast();
  const form = useForm<EditStudentForm>({
    resolver: zodResolver(editStudentSchema),
    defaultValues: {
      studentName: student.studentName,
      studentEmail: student.studentEmail,
      gradeLevel: student.gradeLevel || "",
    },
  });

  const editMutation = useMutation({
    mutationFn: async (data: EditStudentForm) => {
      const res = await apiRequest("PATCH", `/api/students/${student.id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/groups"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/teacher-students"] });
      toast({
        title: "Student updated",
        description: "Student information has been updated successfully.",
      });
      onOpenChange(false);
      form.reset();
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to update student",
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-edit-student">
        <DialogHeader>
          <DialogTitle>Edit Student</DialogTitle>
          <DialogDescription>
            Update student information
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((data) => editMutation.mutate(data))} className="space-y-4">
            <FormField
              control={form.control}
              name="studentName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Student Name</FormLabel>
                  <FormControl>
                    <Input {...field} data-testid="input-edit-student-name" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="studentEmail"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input {...field} type="email" data-testid="input-edit-student-email" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="gradeLevel"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Grade Level (Optional)</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="e.g., 9" data-testid="input-edit-student-grade" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                data-testid="button-cancel-edit"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={editMutation.isPending}
                data-testid="button-save-student"
              >
                {editMutation.isPending ? "Saving..." : "Save Changes"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

interface CreateStudentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  classes: Group[];
}

function CreateStudentDialog({ open, onOpenChange, classes }: CreateStudentDialogProps) {
  const { toast } = useToast();
  const form = useForm<CreateStudentForm>({
    resolver: zodResolver(createStudentSchema),
    defaultValues: {
      studentName: "",
      studentEmail: "",
      gradeLevel: "",
      classId: "",
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: CreateStudentForm) => {
      const res = await apiRequest("POST", "/api/admin/students", data);
      return res.json();
    },
    onSuccess: () => {
      invalidateStudentCaches();
      toast({
        title: "Student created",
        description: "Student has been created successfully.",
      });
      onOpenChange(false);
      form.reset();
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to create student",
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-create-student">
        <DialogHeader>
          <DialogTitle>Create Student</DialogTitle>
          <DialogDescription>
            Add a new student to the system
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((data) => createMutation.mutate(data))} className="space-y-4">
            <FormField
              control={form.control}
              name="studentName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Student Name</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="John Doe" data-testid="input-create-student-name" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="studentEmail"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input {...field} type="email" placeholder="student@school.edu" data-testid="input-create-student-email" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="gradeLevel"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Grade Level</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger data-testid="select-create-student-grade">
                        <SelectValue placeholder="Select grade" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {GRADE_OPTIONS.map((grade) => (
                        <SelectItem key={grade} value={grade}>
                          {grade === 'K' ? 'Kindergarten' : `Grade ${grade}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="classId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Assign to Class (Optional)</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger data-testid="select-create-student-class">
                        <SelectValue placeholder="Select a class" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {classes.map((group) => (
                        <SelectItem key={group.id} value={group.id}>
                          {group.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                data-testid="button-cancel-create"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={createMutation.isPending}
                data-testid="button-create-student"
              >
                {createMutation.isPending ? "Creating..." : "Create Student"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
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
  const [bulkImportDialogOpen, setBulkImportDialogOpen] = useState(false);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [importResults, setImportResults] = useState<any>(null);
  const [createStudentOpen, setCreateStudentOpen] = useState(false);
  const [bulkImportGrade, setBulkImportGrade] = useState<string>("");

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

  // Bulk import mutation
  const bulkImportMutation = useMutation({
    mutationFn: async ({ fileContent, fileType, gradeLevel }: { fileContent: string; fileType: 'csv' | 'excel'; gradeLevel: string }) => {
      const res = await apiRequest("POST", "/api/admin/bulk-import", { fileContent, fileType, gradeLevel });
      return res.json();
    },
    onSuccess: async (data) => {
      invalidateStudentCaches();
      setImportResults(data.results);
      setCsvFile(null);
      setBulkImportGrade("");
      toast({
        title: "Import Complete",
        description: `Created ${data.results.created} students, updated ${data.results.updated}, assigned ${data.results.assigned} to classes`,
      });
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Import Failed",
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

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setCsvFile(file);
      setImportResults(null); // Clear previous results
    }
  };

  const handleBulkImport = async () => {
    if (!csvFile) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Please select a file",
      });
      return;
    }

    if (!bulkImportGrade) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Please select a grade level",
      });
      return;
    }

    try {
      const fileExtension = csvFile.name.split('.').pop()?.toLowerCase();
      const isExcel = fileExtension === 'xlsx' || fileExtension === 'xls';
      
      let fileContent: string;
      const fileType: 'csv' | 'excel' = isExcel ? 'excel' : 'csv';
      
      if (isExcel) {
        // Read Excel file as base64
        fileContent = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result as string;
            // Remove the data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64, prefix
            const base64 = result.split(',')[1];
            resolve(base64);
          };
          reader.onerror = reject;
          reader.readAsDataURL(csvFile);
        });
      } else {
        // Read CSV file as text
        fileContent = await csvFile.text();
      }
      
      bulkImportMutation.mutate({ fileContent, fileType, gradeLevel: bulkImportGrade });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to read file",
      });
    }
  };

  const downloadTemplate = () => {
    const template = "Email,Name,Grade,Class\nstudent@school.edu,John Doe,8,8th Math (sarah)\nstudent2@school.edu,Jane Smith,7,7th Science (bob)";
    const blob = new Blob([template], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'student_import_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
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
            <h1 className="text-3xl font-bold">Class Management</h1>
            <p className="text-muted-foreground">Create and manage class rosters for teachers</p>
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
                          {teachers.filter(t => t.role === 'teacher').map((teacher) => (
                            <SelectItem key={teacher.id} value={teacher.id}>
                              {teacher.username}
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
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Plus className="h-5 w-5" />
                Add Single Student
              </CardTitle>
              <CardDescription>
                Create one student at a time
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => setCreateStudentOpen(true)}
                className="w-full"
                data-testid="button-open-create-student"
              >
                <Plus className="h-4 w-4 mr-2" />
                Create Student
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Plus className="h-5 w-5" />
                Bulk Import Students
              </CardTitle>
              <CardDescription>
                Upload CSV or Excel files to import multiple students
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="bulk-import-grade">Grade Level</Label>
                <Select value={bulkImportGrade} onValueChange={setBulkImportGrade}>
                  <SelectTrigger id="bulk-import-grade" data-testid="select-bulk-import-grade">
                    <SelectValue placeholder="Select grade for import" />
                  </SelectTrigger>
                  <SelectContent>
                    {GRADE_OPTIONS.map((grade) => (
                      <SelectItem key={grade} value={grade}>
                        {grade === 'K' ? 'Kindergarten' : `Grade ${grade}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  All students in the file will be assigned this grade
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="csv-file">CSV or Excel File</Label>
                <Input
                  id="csv-file"
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  onChange={handleFileUpload}
                  data-testid="input-csv-file"
                />
                {csvFile && (
                  <p className="text-sm text-muted-foreground">
                    Selected: {csvFile.name}
                  </p>
                )}
              </div>

              <div className="flex gap-2">
                <Button
                  onClick={handleBulkImport}
                  disabled={!csvFile || !bulkImportGrade || bulkImportMutation.isPending}
                  data-testid="button-bulk-import"
                  className="flex-1"
                >
                  {bulkImportMutation.isPending ? "Importing..." : "Import Students"}
                </Button>
                <Button
                  variant="outline"
                  onClick={downloadTemplate}
                  data-testid="button-download-template"
                >
                  Download Template
                </Button>
              </div>

              {importResults && (
                <div className="mt-4 space-y-3 p-3 border rounded-lg">
                  <div className="flex items-center justify-between">
                    <h4 className="font-medium">Import Results</h4>
                  </div>
                  
                  <div className="grid grid-cols-3 gap-2 text-sm">
                    <div className="text-center p-2 bg-green-500/10 rounded">
                      <p className="font-bold text-green-600 dark:text-green-400">{importResults.created}</p>
                      <p className="text-muted-foreground">Created</p>
                    </div>
                    <div className="text-center p-2 bg-blue-500/10 rounded">
                      <p className="font-bold text-blue-600 dark:text-blue-400">{importResults.updated}</p>
                      <p className="text-muted-foreground">Updated</p>
                    </div>
                    <div className="text-center p-2 bg-purple-500/10 rounded">
                      <p className="font-bold text-purple-600 dark:text-purple-400">{importResults.assigned}</p>
                      <p className="text-muted-foreground">Assigned</p>
                    </div>
                  </div>

                  {importResults.errors && importResults.errors.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-sm font-medium text-destructive">
                        Errors ({importResults.errors.length}):
                      </p>
                      <div className="max-h-40 overflow-y-auto space-y-1">
                        {importResults.errors.map((error: string, index: number) => (
                          <p key={index} className="text-sm text-destructive bg-destructive/10 p-2 rounded">
                            {error}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}

                  {importResults.warnings && importResults.warnings.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-sm font-medium text-yellow-600 dark:text-yellow-400">
                        Warnings ({importResults.warnings.length}):
                      </p>
                      <div className="max-h-40 overflow-y-auto space-y-1">
                        {importResults.warnings.map((warning: string, index: number) => (
                          <p key={index} className="text-sm text-yellow-600 dark:text-yellow-400 bg-yellow-500/10 p-2 rounded">
                            {warning}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="text-xs text-muted-foreground space-y-1">
                <p><strong>CSV Format:</strong></p>
                <p>• Required columns: Email, Name</p>
                <p>• Optional columns: Grade, Class</p>
                <p>• Class names must match existing classes exactly</p>
                <p>• Students with existing emails will be updated</p>
              </div>
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

      <CreateStudentDialog
        open={createStudentOpen}
        onOpenChange={setCreateStudentOpen}
        classes={adminClasses}
      />
    </div>
  );
}
