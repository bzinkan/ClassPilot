import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Upload, Download, Edit, Trash2, FileSpreadsheet, GraduationCap, RefreshCw, Users, Loader2 } from "lucide-react";
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
  const classroomNotConnected = (classroomError as any)?.code === "NO_TOKENS";

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

  const allStudents = studentsData?.students || [];

  // Get available grades from students
  const availableGrades = Array.from(
    new Set(
      allStudents
        .map(s => normalizeGrade(s.gradeLevel))
        .filter((g): g is string => g !== null)
    )
  ).sort((a, b) => {
    const numA = parseInt(a);
    const numB = parseInt(b);
    return isNaN(numA) || isNaN(numB) ? a.localeCompare(b) : numA - numB;
  });

  // Filter students by selected grade
  const filteredStudents = selectedGrade
    ? allStudents.filter(s => normalizeGrade(s.gradeLevel) === selectedGrade)
    : allStudents;

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

      {/* Student Roster */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Current Student Roster</CardTitle>
              <CardDescription>
                {filteredStudents.length} student{filteredStudents.length !== 1 ? 's' : ''}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Grade Filter Tabs */}
          {availableGrades.length > 0 && (
            <Tabs value={selectedGrade} onValueChange={setSelectedGrade}>
              <TabsList>
                <TabsTrigger value="" data-testid="tab-all-grades">
                  All Grades
                </TabsTrigger>
                {availableGrades.map((grade) => (
                  <TabsTrigger 
                    key={grade} 
                    value={grade}
                    data-testid={`tab-grade-${grade}`}
                  >
                    Grade {grade}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}

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
    </div>
  );
}
