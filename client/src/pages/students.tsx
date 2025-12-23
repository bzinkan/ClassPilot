import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Upload, Download, Edit, Trash2, FileSpreadsheet, GraduationCap, RefreshCw, Users, Loader2, Building2, AlertCircle, Plus, Search } from "lucide-react";
import { useLocation } from "wouter";
import { ThemeToggle } from "@/components/theme-toggle";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EditStudentDialog } from "@/components/edit-student-dialog";

interface CurrentUser {
  id: string;
  username: string;
  role: string;
  schoolName: string;
}

// Helper to normalize grade levels
function normalizeGrade(grade: string | null | undefined): string | null {
  if (!grade) return null;
  const trimmed = grade.trim();
  if (!trimmed) return null;
  return trimmed.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');
}

interface Student {
  id: string;
  studentName: string;
  studentEmail: string;
  gradeLevel: string | null;
  deviceId: string;
}

interface StudentsResponse {
  students: Student[];
}

interface GoogleClassroomCourse {
  id: string;
  name: string;
  section: string | null;
  room: string | null;
  descriptionHeading: string | null;
  ownerId: string | null;
  lastSyncedAt: string | null;
}

interface ClassroomCoursesResponse {
  courses: GoogleClassroomCourse[];
}

interface DirectoryUser {
  id: string;
  email: string;
  name: string;
  orgUnitPath?: string;
  isAdmin?: boolean;
  suspended?: boolean;
}

interface DirectoryUsersResponse {
  users: DirectoryUser[];
  nextPageToken?: string;
}

interface DirectoryImportResult {
  success: boolean;
  imported: number;
  updated: number;
  skipped: number;
  errors: string[];
}

// Admin Guard Wrapper - Only checks auth, doesn't run any queries/mutations
export default function StudentsPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  // Only fetch current user for auth check
  const { data: currentUserData, isLoading: isLoadingUser } = useQuery<{ success: boolean; user: CurrentUser }>({
    queryKey: ['/api/me'],
  });

  const currentUser = currentUserData?.user;

  // Redirect non-admin users (allow admin, school_admin, and super_admin)
  const isAdminRole = currentUser?.role === 'admin' || currentUser?.role === 'school_admin' || currentUser?.role === 'super_admin';
  
  useEffect(() => {
    if (!isLoadingUser && !isAdminRole) {
      toast({
        title: "Access Denied",
        description: "This page is only accessible to administrators",
        variant: "destructive",
      });
      setLocation("/dashboard");
    }
  }, [currentUser, isLoadingUser, isAdminRole, setLocation, toast]);

  // Show loading while checking auth
  if (isLoadingUser) {
    return (
      <div className="container mx-auto p-6 max-w-7xl">
        <div className="text-center py-20">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      </div>
    );
  }

  // Don't render anything for non-admins
  if (!isAdminRole) {
    return null;
  }

  // Only render content for confirmed admins
  return <StudentsContent />;
}

// Content Component - Only runs for confirmed admins
function StudentsContent() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [selectedGrade, setSelectedGrade] = useState<string>("");
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [importResults, setImportResults] = useState<any>(null);
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [deletingStudent, setDeletingStudent] = useState<Student | null>(null);
  const [showClassroomDialog, setShowClassroomDialog] = useState(false);
  const [syncingCourseId, setSyncingCourseId] = useState<string | null>(null);
  const [showWorkspaceDialog, setShowWorkspaceDialog] = useState(false);
  const [workspaceImportResult, setWorkspaceImportResult] = useState<DirectoryImportResult | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showAddStudentDialog, setShowAddStudentDialog] = useState(false);
  const [newStudentName, setNewStudentName] = useState("");
  const [newStudentEmail, setNewStudentEmail] = useState("");
  const [newStudentGrade, setNewStudentGrade] = useState("");
  const [showAddGradeDialog, setShowAddGradeDialog] = useState(false);
  const [manualGrades, setManualGrades] = useState<string[]>([]); // Manually added grade categories

  // Fetch all students (only runs for admins)
  const { data: studentsData, isLoading } = useQuery<StudentsResponse>({
    queryKey: ["/api/admin/teacher-students"],
  });

  // Fetch Google Classroom courses (only when dialog is open)
  const { data: classroomData, isLoading: isLoadingCourses, error: classroomError, refetch: refetchCourses } = useQuery<ClassroomCoursesResponse>({
    queryKey: ["/api/classroom/courses"],
    enabled: showClassroomDialog,
  });

  const classroomCourses = classroomData?.courses || [];
  
  // Parse error code from classroom error
  const classroomNotConnected = (() => {
    if (!classroomError) return false;
    const errorMessage = (classroomError as Error).message || "";
    try {
      const jsonMatch = errorMessage.match(/\{.*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed.code === "NO_TOKENS";
      }
    } catch {
      return errorMessage.includes("NO_TOKENS");
    }
    return false;
  })();

  // Sync Google Classroom roster mutation
  const syncClassroomMutation = useMutation({
    mutationFn: async (courseId: string) => {
      setSyncingCourseId(courseId);
      const res = await apiRequest("POST", `/api/classroom/courses/${courseId}/sync`, {});
      return res.json();
    },
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/teacher-students"], exact: false });
      await queryClient.invalidateQueries({ queryKey: ["/api/groups"], exact: false });
      await queryClient.invalidateQueries({ queryKey: ["/api/teacher/groups"], exact: false });
      await queryClient.invalidateQueries({ queryKey: ["/api/classroom/courses"] });
      toast({
        title: "Import Complete",
        description: `Imported ${data.studentsImported || 0} students from Google Classroom`,
      });
      setSyncingCourseId(null);
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Sync Failed",
        description: error.message,
      });
      setSyncingCourseId(null);
    },
  });

  // Fetch Google Workspace Directory users (only when dialog is open)
  const { data: directoryData, isLoading: isLoadingDirectory, error: directoryError, refetch: refetchDirectory } = useQuery<DirectoryUsersResponse>({
    queryKey: ["/api/directory/users"],
    enabled: showWorkspaceDialog,
  });

  const directoryUsers = directoryData?.users || [];
  
  // Parse error codes from the error message (format: "403: {\"error\":\"...\",\"code\":\"...\"}")
  const getDirectoryErrorCode = (): string | null => {
    if (!directoryError) return null;
    const errorMessage = (directoryError as Error).message || "";
    try {
      const jsonMatch = errorMessage.match(/\{.*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed.code || null;
      }
    } catch {
      // Not JSON, check for keywords
      if (errorMessage.includes("NO_TOKENS")) return "NO_TOKENS";
      if (errorMessage.includes("INSUFFICIENT_PERMISSIONS")) return "INSUFFICIENT_PERMISSIONS";
    }
    return null;
  };
  
  const directoryErrorCode = getDirectoryErrorCode();
  const directoryNotConnected = directoryErrorCode === "NO_TOKENS";
  const directoryNoPermission = directoryErrorCode === "INSUFFICIENT_PERMISSIONS";

  // Import from Google Workspace Directory mutation
  const importDirectoryMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/directory/import", {});
      return res.json();
    },
    onSuccess: async (data: DirectoryImportResult) => {
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/teacher-students"], exact: false });
      setWorkspaceImportResult(data);
      toast({
        title: "Import Complete",
        description: `Imported ${data.imported} new students, updated ${data.updated} existing`,
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

  const allStudents = studentsData?.students || [];

  // All possible grades for the Add Grade dialog (K-12)
  const allPossibleGrades = ["K", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
  
  // Get grades that have students (from imports)
  const gradesWithStudents = Array.from(
    new Set(
      allStudents
        .map(s => normalizeGrade(s.gradeLevel))
        .filter((g): g is string => g !== null)
    )
  );
  
  // Combine imported grades with manually added grades (unique, sorted)
  const activeGrades = Array.from(new Set([...gradesWithStudents, ...manualGrades])).sort((a, b) => {
    if (a === "K") return -1;
    if (b === "K") return 1;
    return parseInt(a) - parseInt(b);
  });
  
  // Get student counts per grade for badge display
  const gradeStudentCounts = activeGrades.reduce((acc, grade) => {
    acc[grade] = allStudents.filter(s => normalizeGrade(s.gradeLevel) === grade).length;
    return acc;
  }, {} as Record<string, number>);

  // Filter students by selected grade and search query
  const filteredStudents = allStudents.filter(student => {
    // Grade filter
    if (selectedGrade && normalizeGrade(student.gradeLevel) !== selectedGrade) {
      return false;
    }
    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const nameMatch = student.studentName?.toLowerCase().includes(query);
      const emailMatch = student.studentEmail?.toLowerCase().includes(query);
      return nameMatch || emailMatch;
    }
    return true;
  });
  
  // Handle adding a new grade category
  const handleAddGrade = (grade: string) => {
    if (!manualGrades.includes(grade) && !gradesWithStudents.includes(grade)) {
      setManualGrades([...manualGrades, grade]);
    }
    setShowAddGradeDialog(false);
  };
  
  // Get grades available to add (not already active)
  const availableGradesToAdd = allPossibleGrades.filter(g => !activeGrades.includes(g));

  // Bulk import mutation
  const bulkImportMutation = useMutation({
    mutationFn: async ({ fileContent, fileType }: { fileContent: string; fileType: 'csv' | 'excel' }) => {
      const res = await apiRequest("POST", "/api/admin/bulk-import", { fileContent, fileType });
      return res.json();
    },
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/teacher-students"], exact: false });
      await queryClient.invalidateQueries({ queryKey: ["/api/groups"], exact: false });
      await queryClient.invalidateQueries({ queryKey: ["/api/teacher/groups"], exact: false });
      setImportResults(data.results);
      toast({
        title: "Import Complete",
        description: `Created ${data.results.created} students, updated ${data.results.updated}, assigned ${data.results.assigned} to classes`,
      });
      setCsvFile(null);
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Import Failed",
        description: error.message,
      });
    },
  });

  // Delete student mutation
  const deleteStudentMutation = useMutation({
    mutationFn: async (studentId: string) => {
      const res = await apiRequest("DELETE", `/api/students/${studentId}`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/teacher-students"] });
      queryClient.invalidateQueries({ queryKey: ["/api/groups"], exact: false });
      toast({
        title: "Student Deleted",
        description: "Student has been removed from the system",
      });
      setDeletingStudent(null);
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to delete student",
        variant: "destructive",
      });
    },
  });

  // Add student mutation
  const addStudentMutation = useMutation({
    mutationFn: async (data: { studentName: string; studentEmail: string; gradeLevel?: string }) => {
      const res = await apiRequest("POST", "/api/students", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/teacher-students"] });
      toast({
        title: "Student Added",
        description: "Student has been added to the roster",
      });
      setShowAddStudentDialog(false);
      setNewStudentName("");
      setNewStudentEmail("");
      setNewStudentGrade("");
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to add student",
        variant: "destructive",
      });
    },
  });

  const handleAddStudent = () => {
    const name = newStudentName.trim();
    const email = newStudentEmail.trim();
    
    // Validate name
    if (!name) {
      toast({
        title: "Validation Error",
        description: "Student name is required",
        variant: "destructive",
      });
      return;
    }
    
    // Validate email
    if (!email) {
      toast({
        title: "Validation Error",
        description: "Email address is required",
        variant: "destructive",
      });
      return;
    }
    
    // Basic email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      toast({
        title: "Validation Error",
        description: "Please enter a valid email address",
        variant: "destructive",
      });
      return;
    }
    
    // Build mutation data with optional grade
    const mutationData: { studentName: string; studentEmail: string; gradeLevel?: string } = {
      studentName: name,
      studentEmail: email,
    };
    
    if (newStudentGrade) {
      mutationData.gradeLevel = newStudentGrade;
    }
    
    addStudentMutation.mutate(mutationData);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setCsvFile(file);
      setImportResults(null);
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

    try {
      const fileExtension = csvFile.name.split('.').pop()?.toLowerCase();
      const isExcel = fileExtension === 'xlsx' || fileExtension === 'xls';
      
      let fileContent: string;
      const fileType: 'csv' | 'excel' = isExcel ? 'excel' : 'csv';
      
      if (isExcel) {
        // Use ArrayBuffer for Excel files
        fileContent = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result;
            
            if (!(result instanceof ArrayBuffer)) {
              reject(new Error("Failed to read file as ArrayBuffer"));
              return;
            }
            
            // Convert ArrayBuffer to base64
            const bytes = new Uint8Array(result);
            if (bytes.length === 0) {
              reject(new Error("File is empty"));
              return;
            }
            
            const binaryString = Array.from(bytes)
              .map(byte => String.fromCharCode(byte))
              .join('');
            const base64 = btoa(binaryString);
            resolve(base64);
          };
          reader.onerror = () => reject(new Error("Failed to read file"));
          reader.readAsArrayBuffer(csvFile);
        });
      } else {
        // Read CSV as text
        fileContent = await csvFile.text();
      }
      
      bulkImportMutation.mutate({ fileContent, fileType });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to read file",
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

  const handleEditSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/teacher-students"] });
    queryClient.invalidateQueries({ queryKey: ["/api/groups"], exact: false });
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
            <h1 className="text-3xl font-bold">Students</h1>
            <p className="text-muted-foreground">Manage student roster and import students</p>
          </div>
        </div>
        <ThemeToggle />
      </div>

      {/* CSV Import Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            Bulk Import Students
          </CardTitle>
          <CardDescription>
            Upload a CSV or Excel file to import multiple students at once
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="csv-upload">CSV or Excel File</Label>
            <div className="flex gap-2">
              <Input
                id="csv-upload"
                type="file"
                accept=".csv,.xlsx,.xls"
                onChange={handleFileUpload}
                data-testid="input-csv-upload"
              />
              <Button
                onClick={handleBulkImport}
                disabled={!csvFile || bulkImportMutation.isPending}
                data-testid="button-import-students"
              >
                <Upload className="h-4 w-4 mr-2" />
                {bulkImportMutation.isPending ? "Importing..." : "Import Students"}
              </Button>
              <Button
                variant="outline"
                onClick={downloadTemplate}
                data-testid="button-download-template"
              >
                <Download className="h-4 w-4 mr-2" />
                Download Template
              </Button>
            </div>
          </div>

          <div className="text-sm text-muted-foreground space-y-1">
            <p className="font-medium">CSV Format:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Required columns: Email, Name</li>
              <li>Optional columns: Grade, Class</li>
              <li>Class names must match existing classes exactly</li>
              <li>Students with existing emails will be updated</li>
            </ul>
          </div>

          {importResults && (
            <div className="p-4 border rounded-md space-y-2" data-testid="import-results">
              <p className="font-medium">Import Results:</p>
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground">Created</p>
                  <p className="text-2xl font-bold text-green-600">{importResults.created}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Updated</p>
                  <p className="text-2xl font-bold text-blue-600">{importResults.updated}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Assigned to Classes</p>
                  <p className="text-2xl font-bold text-purple-600">{importResults.assigned}</p>
                </div>
              </div>
              {importResults.errors && importResults.errors.length > 0 && (
                <div className="mt-3 p-3 bg-destructive/10 rounded-md">
                  <p className="font-medium text-destructive mb-2">Errors:</p>
                  <ul className="list-disc list-inside text-sm text-destructive space-y-1">
                    {importResults.errors.map((error: string, i: number) => (
                      <li key={i}>{error}</li>
                    ))}
                  </ul>
                </div>
              )}
              {importResults.warnings && importResults.warnings.length > 0 && (
                <div className="mt-3 p-3 bg-yellow-500/10 rounded-md">
                  <p className="font-medium text-yellow-700 dark:text-yellow-500 mb-2">Warnings:</p>
                  <ul className="list-disc list-inside text-sm text-yellow-700 dark:text-yellow-500 space-y-1">
                    {importResults.warnings.map((warning: string, i: number) => (
                      <li key={i}>{warning}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Google Classroom Import Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GraduationCap className="h-5 w-5" />
            Import from Google Classroom
          </CardTitle>
          <CardDescription>
            Sync student rosters directly from your Google Classroom courses
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            onClick={() => setShowClassroomDialog(true)}
            data-testid="button-open-classroom-import"
          >
            <GraduationCap className="h-4 w-4 mr-2" />
            Import from Google Classroom
          </Button>
        </CardContent>
      </Card>

      {/* Google Classroom Import Dialog */}
      <Dialog open={showClassroomDialog} onOpenChange={setShowClassroomDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GraduationCap className="h-5 w-5" />
              Import from Google Classroom
            </DialogTitle>
            <DialogDescription>
              Select a course to import its student roster into ClassPilot
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {isLoadingCourses ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin mr-2" />
                <span className="text-muted-foreground">Loading courses...</span>
              </div>
            ) : classroomNotConnected ? (
              <div className="text-center py-8 space-y-4">
                <p className="text-muted-foreground">
                  Google Classroom is not connected. Please sign out and sign back in with Google, 
                  making sure to grant Google Classroom access permissions.
                </p>
                <Button
                  variant="outline"
                  onClick={() => window.location.href = "/auth/google"}
                  data-testid="button-reconnect-google"
                >
                  Reconnect Google Account
                </Button>
              </div>
            ) : classroomCourses.length === 0 ? (
              <div className="text-center py-8 space-y-2">
                <p className="text-muted-foreground">No courses found in your Google Classroom account.</p>
                <Button
                  variant="outline"
                  onClick={() => refetchCourses()}
                  data-testid="button-refresh-courses"
                >
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Refresh Courses
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between mb-4">
                  <p className="text-sm text-muted-foreground">
                    Found {classroomCourses.length} course{classroomCourses.length !== 1 ? 's' : ''}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => refetchCourses()}
                    data-testid="button-refresh-courses"
                  >
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Refresh
                  </Button>
                </div>
                <div className="border rounded-md divide-y max-h-96 overflow-auto">
                  {classroomCourses.map((course) => (
                    <div
                      key={course.id}
                      className="flex items-center justify-between p-4 hover-elevate"
                      data-testid={`row-course-${course.id}`}
                    >
                      <div className="space-y-1">
                        <p className="font-medium">{course.name}</p>
                        {course.section && (
                          <p className="text-sm text-muted-foreground">{course.section}</p>
                        )}
                        {course.lastSyncedAt && (
                          <p className="text-xs text-muted-foreground">
                            Last synced: {new Date(course.lastSyncedAt).toLocaleDateString()}
                          </p>
                        )}
                      </div>
                      <Button
                        onClick={() => syncClassroomMutation.mutate(course.id)}
                        disabled={syncingCourseId !== null}
                        data-testid={`button-sync-course-${course.id}`}
                      >
                        {syncingCourseId === course.id ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Importing...
                          </>
                        ) : (
                          <>
                            <Users className="h-4 w-4 mr-2" />
                            Import Students
                          </>
                        )}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Google Workspace Import Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            Import from Google Workspace
          </CardTitle>
          <CardDescription>
            Import all students from your school's Google Workspace domain (requires admin access)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            onClick={() => setShowWorkspaceDialog(true)}
            data-testid="button-open-workspace-import"
          >
            <Building2 className="h-4 w-4 mr-2" />
            Import from Google Workspace
          </Button>
        </CardContent>
      </Card>

      {/* Google Workspace Import Dialog */}
      <Dialog open={showWorkspaceDialog} onOpenChange={(open) => {
        setShowWorkspaceDialog(open);
        if (!open) setWorkspaceImportResult(null);
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5" />
              Import from Google Workspace
            </DialogTitle>
            <DialogDescription>
              Import all students from your school's Google Workspace domain
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {isLoadingDirectory ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin mr-2" />
                <span className="text-muted-foreground">Loading users from Google Workspace...</span>
              </div>
            ) : directoryNotConnected ? (
              <div className="text-center py-8 space-y-4">
                <p className="text-muted-foreground">
                  Google Workspace is not connected. Please sign out and sign back in with Google.
                </p>
                <Button
                  variant="outline"
                  onClick={() => window.location.href = "/auth/google"}
                  data-testid="button-reconnect-google-workspace"
                >
                  Reconnect Google Account
                </Button>
              </div>
            ) : directoryNoPermission ? (
              <div className="text-center py-8 space-y-4">
                <div className="flex items-center justify-center gap-2 text-yellow-600">
                  <AlertCircle className="h-5 w-5" />
                  <span className="font-medium">Admin Access Required</span>
                </div>
                <p className="text-muted-foreground">
                  This feature requires Google Workspace administrator privileges. 
                  Your Google account must have admin access to your school's domain to import users directly.
                </p>
                <p className="text-sm text-muted-foreground">
                  Alternatively, use the Google Classroom import or CSV upload options above.
                </p>
              </div>
            ) : workspaceImportResult ? (
              <div className="space-y-4">
                <div className="p-4 border rounded-md space-y-3">
                  <p className="font-medium">Import Results:</p>
                  <div className="grid grid-cols-3 gap-4 text-sm">
                    <div>
                      <p className="text-muted-foreground">Imported</p>
                      <p className="text-2xl font-bold text-green-600">{workspaceImportResult.imported}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Updated</p>
                      <p className="text-2xl font-bold text-blue-600">{workspaceImportResult.updated}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Skipped</p>
                      <p className="text-2xl font-bold text-gray-600">{workspaceImportResult.skipped}</p>
                    </div>
                  </div>
                  {workspaceImportResult.errors.length > 0 && (
                    <div className="mt-3 p-3 bg-destructive/10 rounded-md">
                      <p className="font-medium text-destructive mb-2">Errors:</p>
                      <ul className="list-disc list-inside text-sm text-destructive space-y-1">
                        {workspaceImportResult.errors.slice(0, 10).map((error, i) => (
                          <li key={i}>{error}</li>
                        ))}
                        {workspaceImportResult.errors.length > 10 && (
                          <li>...and {workspaceImportResult.errors.length - 10} more</li>
                        )}
                      </ul>
                    </div>
                  )}
                </div>
                <div className="flex justify-end">
                  <Button onClick={() => setShowWorkspaceDialog(false)}>
                    Done
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">
                    Found {directoryUsers.length} user{directoryUsers.length !== 1 ? 's' : ''} in your domain
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => refetchDirectory()}
                    data-testid="button-refresh-directory"
                  >
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Refresh
                  </Button>
                </div>

                {directoryUsers.length > 0 && (
                  <div className="border rounded-md divide-y max-h-64 overflow-auto">
                    {directoryUsers.slice(0, 20).map((user) => (
                      <div
                        key={user.id}
                        className="flex items-center justify-between p-3 text-sm"
                        data-testid={`row-user-${user.id}`}
                      >
                        <div>
                          <p className="font-medium">{user.name}</p>
                          <p className="text-muted-foreground text-xs">{user.email}</p>
                        </div>
                        {user.orgUnitPath && (
                          <span className="text-xs text-muted-foreground">{user.orgUnitPath}</span>
                        )}
                      </div>
                    ))}
                    {directoryUsers.length > 20 && (
                      <div className="p-3 text-sm text-center text-muted-foreground">
                        ...and {directoryUsers.length - 20} more users
                      </div>
                    )}
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setShowWorkspaceDialog(false)}>
                    Cancel
                  </Button>
                  <Button
                    onClick={() => importDirectoryMutation.mutate()}
                    disabled={importDirectoryMutation.isPending || directoryUsers.length === 0}
                    data-testid="button-import-workspace-users"
                  >
                    {importDirectoryMutation.isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Importing...
                      </>
                    ) : (
                      <>
                        <Users className="h-4 w-4 mr-2" />
                        Import {directoryUsers.length} Students
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Student Roster */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <CardTitle>Current Student Roster</CardTitle>
              <CardDescription>
                {filteredStudents.length} student{filteredStudents.length !== 1 ? 's' : ''}{selectedGrade ? ` in Grade ${selectedGrade}` : ''}{searchQuery ? ` matching "${searchQuery}"` : ''}
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setShowAddGradeDialog(true)}
                disabled={availableGradesToAdd.length === 0}
                data-testid="button-add-grade"
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Grade
              </Button>
              <Button
                onClick={() => setShowAddStudentDialog(true)}
                data-testid="button-add-student"
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Student
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Grade Filter Buttons - Only show if there are active grades */}
          {activeGrades.length > 0 && (
            <div className="space-y-3">
              <Label className="text-sm font-medium">Filter by Grade</Label>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant={selectedGrade === "" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setSelectedGrade("")}
                  data-testid="button-grade-all"
                >
                  All ({allStudents.length})
                </Button>
                {activeGrades.map((grade) => (
                  <Button
                    key={grade}
                    variant={selectedGrade === grade ? "default" : "outline"}
                    size="sm"
                    onClick={() => setSelectedGrade(grade)}
                    data-testid={`button-grade-${grade}`}
                  >
                    {grade === "K" ? "K" : `${grade}${grade === "1" ? "st" : grade === "2" ? "nd" : grade === "3" ? "rd" : "th"}`}
                    <span className="ml-1 text-xs opacity-70">({gradeStudentCounts[grade] || 0})</span>
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/* Search Input */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search students by name or email..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
              data-testid="input-search-students"
            />
          </div>

          {/* Student Table */}
          {isLoading ? (
            <div className="text-center py-8 text-muted-foreground">
              Loading students...
            </div>
          ) : filteredStudents.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              {selectedGrade 
                ? `No students found in grade ${selectedGrade}` 
                : "No students found. Import students to get started."}
            </div>
          ) : (
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Grade</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredStudents.map((student) => (
                    <TableRow key={student.id} data-testid={`row-student-${student.id}`}>
                      <TableCell className="font-medium">{student.studentName}</TableCell>
                      <TableCell>{student.studentEmail}</TableCell>
                      <TableCell>
                        {student.gradeLevel ? `Grade ${student.gradeLevel}` : '-'}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setEditingStudent(student)}
                            data-testid={`button-edit-${student.id}`}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setDeletingStudent(student)}
                            data-testid={`button-delete-${student.id}`}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Edit Student Dialog */}
      {editingStudent && (
        <EditStudentDialog
          student={editingStudent}
          open={!!editingStudent}
          onOpenChange={(open) => !open && setEditingStudent(null)}
          onSuccess={handleEditSuccess}
        />
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deletingStudent} onOpenChange={(open) => !open && setDeletingStudent(null)}>
        <AlertDialogContent data-testid="dialog-delete-student">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Student?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{deletingStudent?.studentName}</strong>?
              This will remove them from all classes and delete their activity history.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingStudent && deleteStudentMutation.mutate(deletingStudent.id)}
              disabled={deleteStudentMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {deleteStudentMutation.isPending ? "Deleting..." : "Delete Student"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Add Student Dialog */}
      <Dialog open={showAddStudentDialog} onOpenChange={(open) => {
        setShowAddStudentDialog(open);
        if (!open) {
          setNewStudentName("");
          setNewStudentEmail("");
          setNewStudentGrade("");
        }
      }}>
        <DialogContent data-testid="dialog-add-student">
          <DialogHeader>
            <DialogTitle>Add New Student</DialogTitle>
            <DialogDescription>
              Manually add a student to your school roster
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label htmlFor="studentName">Student Name *</Label>
              <Input
                id="studentName"
                placeholder="Enter student's full name"
                value={newStudentName}
                onChange={(e) => setNewStudentName(e.target.value)}
                data-testid="input-new-student-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="studentEmail">Email Address *</Label>
              <Input
                id="studentEmail"
                type="email"
                placeholder="student@school.edu"
                value={newStudentEmail}
                onChange={(e) => setNewStudentEmail(e.target.value)}
                data-testid="input-new-student-email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="gradeLevel">Grade Level</Label>
              <div className="flex flex-wrap gap-2">
                {allPossibleGrades.map((grade) => (
                  <Button
                    key={grade}
                    type="button"
                    variant={newStudentGrade === grade ? "default" : "outline"}
                    size="sm"
                    onClick={() => setNewStudentGrade(grade)}
                    data-testid={`button-select-grade-${grade}`}
                  >
                    {grade === "K" ? "K" : `${grade}${grade === "1" ? "st" : grade === "2" ? "nd" : grade === "3" ? "rd" : "th"}`}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <Button variant="outline" onClick={() => setShowAddStudentDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleAddStudent}
                disabled={addStudentMutation.isPending || !newStudentName.trim() || !newStudentEmail.trim()}
                data-testid="button-submit-add-student"
              >
                {addStudentMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Adding...
                  </>
                ) : (
                  <>
                    <Plus className="h-4 w-4 mr-2" />
                    Add Student
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Grade Dialog */}
      <Dialog open={showAddGradeDialog} onOpenChange={setShowAddGradeDialog}>
        <DialogContent data-testid="dialog-add-grade">
          <DialogHeader>
            <DialogTitle>Add Grade Level</DialogTitle>
            <DialogDescription>
              Select a grade level to add to your roster. Students can then be assigned to this grade.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div className="grid grid-cols-4 gap-2">
              {availableGradesToAdd.map((grade) => (
                <Button
                  key={grade}
                  variant="outline"
                  onClick={() => handleAddGrade(grade)}
                  data-testid={`button-add-grade-${grade}`}
                  className="h-12"
                >
                  {grade === "K" ? "Kindergarten" : `${grade}${grade === "1" ? "st" : grade === "2" ? "nd" : grade === "3" ? "rd" : "th"} Grade`}
                </Button>
              ))}
            </div>
            {availableGradesToAdd.length === 0 && (
              <p className="text-center text-muted-foreground">All grade levels have been added.</p>
            )}
            <div className="flex justify-end">
              <Button variant="outline" onClick={() => setShowAddGradeDialog(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
