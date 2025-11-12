import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateStudentCaches } from "@/lib/cacheUtils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Upload, Users, Trash2, Edit, Download, Circle } from "lucide-react";
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
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Group } from "@shared/schema";

const GRADE_OPTIONS = ['K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];

interface Student {
  id: string;
  studentName: string;
  studentEmail: string;
  gradeLevel: string | null;
  classId?: string;
  className?: string;
  deviceId?: string;
  lastSeenAt?: string;
  isOnline?: boolean;
}

interface StudentsResponse {
  students: Student[];
}

function normalizeGrade(grade: string | null | undefined): string | null {
  if (!grade) return null;
  const trimmed = grade.trim();
  if (!trimmed) return null;
  return trimmed.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');
}

export default function AdminStudents() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [selectedGrade, setSelectedGrade] = useState<string>("");
  const [selectedClass, setSelectedClass] = useState<string>("");
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [bulkImportGrade, setBulkImportGrade] = useState<string>("");
  const [bulkImportClass, setBulkImportClass] = useState<string>("");
  const [importResults, setImportResults] = useState<any>(null);

  // Fetch students
  const { data: studentsData, isLoading } = useQuery<StudentsResponse>({
    queryKey: ["/api/admin/teacher-students"],
  });

  // Fetch classes for assignment
  const { data: allGroups = [] } = useQuery<Group[]>({
    queryKey: ["/api/teacher/groups"],
  });

  // Fetch active students (for online status)
  const { data: activeStudents = [] } = useQuery({
    queryKey: ["/api/admin/active-students"],
    refetchInterval: 10000, // Refresh every 10 seconds
  });

  const students = studentsData?.students || [];
  const adminClasses = allGroups.filter(g => g.groupType === 'admin_class');

  // Enrich students with online status and class info
  const enrichedStudents = students.map(student => {
    const activeStudent = activeStudents.find((a: any) => a.studentId === student.id);
    const studentClass = adminClasses.find(c => c.id === student.classId);
    
    return {
      ...student,
      isOnline: !!activeStudent,
      lastSeenAt: activeStudent?.lastSeenAt,
      className: studentClass?.name,
    };
  });

  // Get available grades
  const availableGrades = Array.from(
    new Set(students.map(s => normalizeGrade(s.gradeLevel)).filter((g): g is string => g !== null))
  ).sort((a, b) => {
    const numA = parseInt(a);
    const numB = parseInt(b);
    return isNaN(numA) || isNaN(numB) ? a.localeCompare(b) : numA - numB;
  });

  // Filter students
  const filteredStudents = enrichedStudents.filter(student => {
    if (selectedGrade && normalizeGrade(student.gradeLevel) !== selectedGrade) return false;
    if (selectedClass && student.classId !== selectedClass) return false;
    return true;
  });

  // CSV Import Mutation
  const bulkImportMutation = useMutation({
    mutationFn: async () => {
      if (!csvFile || !bulkImportGrade) {
        throw new Error("Please select a file and grade level");
      }

      const formData = new FormData();
      formData.append('file', csvFile);
      formData.append('gradeLevel', bulkImportGrade);
      if (bulkImportClass) {
        formData.append('classId', bulkImportClass);
      }

      const res = await fetch('/api/admin/bulk-import-students', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || 'Import failed');
      }

      return res.json();
    },
    onSuccess: (data) => {
      invalidateStudentCaches();
      setImportResults(data);
      setCsvFile(null);
      setBulkImportGrade("");
      setBulkImportClass("");
      toast({
        title: "Import Complete",
        description: `Imported ${data.created} students successfully`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Import Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Delete Student Mutation
  const deleteStudentMutation = useMutation({
    mutationFn: async (studentId: string) => {
      const res = await apiRequest("DELETE", `/api/admin/students/${studentId}`);
      return res.json();
    },
    onSuccess: () => {
      invalidateStudentCaches();
      toast({
        title: "Student Deleted",
        description: "Student has been removed successfully",
      });
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

  const handleBulkImport = () => {
    bulkImportMutation.mutate();
  };

  const downloadTemplate = () => {
    const csvContent = "First Name,Last Name,Email,Grade\nJohn,Doe,john.doe@school.edu,5\nJane,Smith,jane.smith@school.edu,5";
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'student-import-template.csv';
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const formatLastSeen = (lastSeenAt?: string) => {
    if (!lastSeenAt) return 'Never';
    const date = new Date(lastSeenAt);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 items-center justify-between px-4">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setLocation("/admin")}
              data-testid="button-back"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-lg font-semibold">Student Management</h1>
              <p className="text-sm text-muted-foreground">
                Import, view, and manage all students
              </p>
            </div>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <div className="container py-6 px-4 max-w-7xl mx-auto space-y-6">
        {/* CSV Import Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5" />
              Bulk Import Students
            </CardTitle>
            <CardDescription>
              Upload CSV or Excel files to import multiple students at once
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="bulk-import-grade">Grade Level *</Label>
                <Select value={bulkImportGrade} onValueChange={setBulkImportGrade}>
                  <SelectTrigger id="bulk-import-grade" data-testid="select-bulk-import-grade">
                    <SelectValue placeholder="Select grade" />
                  </SelectTrigger>
                  <SelectContent>
                    {GRADE_OPTIONS.map((grade) => (
                      <SelectItem key={grade} value={grade}>
                        {grade === 'K' ? 'Kindergarten' : `Grade ${grade}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="bulk-import-class">Assign to Class (Optional)</Label>
                <Select value={bulkImportClass} onValueChange={setBulkImportClass}>
                  <SelectTrigger id="bulk-import-class" data-testid="select-bulk-import-class">
                    <SelectValue placeholder="No class" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">No class</SelectItem>
                    {adminClasses.map((cls) => (
                      <SelectItem key={cls.id} value={cls.id}>
                        {cls.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                onClick={handleBulkImport}
                disabled={!csvFile || !bulkImportGrade || bulkImportMutation.isPending}
                data-testid="button-bulk-import"
              >
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

            {importResults && (
              <div className="p-4 border rounded-lg bg-muted/30 space-y-2">
                <p className="font-medium">Import Results:</p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge variant="default">{importResults.created || 0} Created</Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{importResults.updated || 0} Updated</Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{importResults.assigned || 0} Assigned</Badge>
                  </div>
                  {importResults.errors && importResults.errors.length > 0 && (
                    <div className="flex items-center gap-2">
                      <Badge variant="destructive">{importResults.errors.length} Errors</Badge>
                    </div>
                  )}
                </div>
                {importResults.errors && importResults.errors.length > 0 && (
                  <div className="mt-2 space-y-1">
                    <p className="text-sm font-medium text-destructive">Errors:</p>
                    {importResults.errors.slice(0, 5).map((error: string, idx: number) => (
                      <p key={idx} className="text-xs text-muted-foreground">{error}</p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Student List */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Users className="h-5 w-5" />
                  Students
                </CardTitle>
                <CardDescription>
                  {filteredStudents.length} student{filteredStudents.length !== 1 ? 's' : ''} 
                  {selectedGrade && ` in Grade ${selectedGrade}`}
                  {selectedClass && ` in ${adminClasses.find(c => c.id === selectedClass)?.name}`}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Filters */}
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="flex-1">
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
              </div>
              <div className="w-full sm:w-64">
                <Select value={selectedClass} onValueChange={setSelectedClass}>
                  <SelectTrigger data-testid="select-filter-class">
                    <SelectValue placeholder="All classes" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">All classes</SelectItem>
                    {adminClasses.map((cls) => (
                      <SelectItem key={cls.id} value={cls.id}>
                        {cls.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Students Table */}
            {isLoading ? (
              <div className="text-center py-8 text-muted-foreground">
                Loading students...
              </div>
            ) : filteredStudents.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Users className="h-12 w-12 mx-auto mb-3 text-muted-foreground/30" />
                <p className="text-sm">
                  {selectedGrade || selectedClass 
                    ? "No students match your filters" 
                    : "No students yet. Import your first students using CSV above."}
                </p>
              </div>
            ) : (
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Status</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Grade</TableHead>
                      <TableHead>Class</TableHead>
                      <TableHead>Last Seen</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredStudents.map((student) => (
                      <TableRow key={student.id} data-testid={`student-row-${student.id}`}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Circle 
                              className={`h-2.5 w-2.5 fill-current ${
                                student.isOnline ? 'text-green-500' : 'text-gray-300'
                              }`} 
                            />
                            <span className="text-xs text-muted-foreground">
                              {student.isOnline ? 'Online' : 'Offline'}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="font-medium">{student.studentName}</TableCell>
                        <TableCell className="text-muted-foreground">{student.studentEmail}</TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {student.gradeLevel ? `Grade ${student.gradeLevel}` : 'N/A'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {student.className ? (
                            <Badge variant="secondary">{student.className}</Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">Not assigned</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {formatLastSeen(student.lastSeenAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => deleteStudentMutation.mutate(student.id)}
                            disabled={deleteStudentMutation.isPending}
                            data-testid={`button-delete-${student.id}`}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
