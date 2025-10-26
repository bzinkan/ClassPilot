import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { ArrowLeft, Plus, Users, Upload } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Roster, Student } from "@shared/schema";

export default function RosterPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [showNewClassDialog, setShowNewClassDialog] = useState(false);
  const [newClassName, setNewClassName] = useState("");
  const [selectedClass, setSelectedClass] = useState<Roster | null>(null);
  const [showAddStudentDialog, setShowAddStudentDialog] = useState(false);
  const [showBulkAddDialog, setShowBulkAddDialog] = useState(false);

  // Student form state
  const [studentName, setStudentName] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [gradeLevel, setGradeLevel] = useState("");

  // Bulk add state
  const [csvFile, setCsvFile] = useState<File | null>(null);

  // Fetch all rosters/classes
  const { data: rosters = [], isLoading: rostersLoading } = useQuery<Roster[]>({
    queryKey: ['/api/rosters'],
  });

  // Fetch all students to calculate counts
  const { data: students = [], isLoading: studentsLoading } = useQuery<Student[]>({
    queryKey: ['/api/roster/students'],
  });

  // Calculate student counts by classId
  const studentCountsByClass = students.reduce((acc, student) => {
    const classId = student.classId || "general";
    acc[classId] = (acc[classId] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Create new class mutation
  const createClassMutation = useMutation({
    mutationFn: async (data: { className: string; classId: string }) => {
      const response = await fetch("/api/rosters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!response.ok) throw new Error("Failed to create class");
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/rosters'] });
      toast({
        title: "Class created",
        description: "New class has been created successfully",
      });
      setShowNewClassDialog(false);
      setNewClassName("");
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to create class",
        description: error.message,
      });
    },
  });

  // Add single student mutation
  const addStudentMutation = useMutation({
    mutationFn: async (data: { studentName: string; deviceId: string; classId: string; gradeLevel?: string; deviceName?: string }) => {
      const response = await fetch("/api/roster/student", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!response.ok) throw new Error("Failed to add student");
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/roster/students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      toast({
        title: "Student added",
        description: "Student has been added to the roster",
      });
      setShowAddStudentDialog(false);
      setStudentName("");
      setDeviceId("");
      setDeviceName("");
      setGradeLevel("");
      setSelectedClass(null);
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to add student",
        description: error.message,
      });
    },
  });

  // Bulk upload mutation
  const uploadRosterMutation = useMutation({
    mutationFn: async ({ file, classId }: { file: File; classId: string }) => {
      // Parse CSV file
      const text = await file.text();
      const lines = text.split('\n').filter(line => line.trim());
      
      // Skip header row and parse student data
      const students = lines.slice(1).map(line => {
        const [studentName, deviceId, , gradeLevel, deviceName] = line.split(',').map(s => s.trim());
        return {
          studentName,
          deviceId,
          classId, // Use the selected class
          gradeLevel: gradeLevel || undefined,
          deviceName: deviceName || undefined,
        };
      }).filter(s => s.studentName && s.deviceId);

      const response = await fetch("/api/roster/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ students }),
      });
      if (!response.ok) throw new Error("Upload failed");
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/roster/students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/rosters'] });
      toast({
        title: "Roster uploaded",
        description: "Class roster has been uploaded successfully",
      });
      setShowBulkAddDialog(false);
      setCsvFile(null);
      setSelectedClass(null);
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Upload failed",
        description: error.message,
      });
    },
  });

  const handleCreateClass = () => {
    if (!newClassName.trim()) {
      toast({
        variant: "destructive",
        title: "Class name required",
        description: "Please enter a class name",
      });
      return;
    }

    const classId = newClassName.toLowerCase().replace(/\s+/g, '-');
    createClassMutation.mutate({ className: newClassName, classId });
  };

  const handleAddStudent = () => {
    if (!selectedClass) return;
    if (!studentName.trim() || !deviceId.trim()) {
      toast({
        variant: "destructive",
        title: "Missing information",
        description: "Student name and device ID are required",
      });
      return;
    }

    addStudentMutation.mutate({
      studentName,
      deviceId,
      classId: selectedClass.classId,
      gradeLevel: gradeLevel || undefined,
      deviceName: deviceName || undefined,
    });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type === "text/csv") {
      setCsvFile(file);
    } else {
      toast({
        variant: "destructive",
        title: "Invalid file",
        description: "Please select a CSV file",
      });
    }
  };

  const handleUploadRoster = () => {
    if (csvFile && selectedClass) {
      uploadRosterMutation.mutate({ file: csvFile, classId: selectedClass.classId });
    }
  };

  const openAddStudentDialog = (roster: Roster) => {
    setSelectedClass(roster);
    setShowAddStudentDialog(true);
  };

  const openBulkAddDialog = (roster: Roster) => {
    setSelectedClass(roster);
    setShowBulkAddDialog(true);
  };

  const isLoading = rostersLoading || studentsLoading;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-background">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setLocation("/dashboard")}
                data-testid="button-back"
              >
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <div>
                <h1 className="text-2xl font-bold">Class Roster</h1>
                <p className="text-sm text-muted-foreground">
                  Organize students by class or grade level
                </p>
              </div>
            </div>
            <Button
              onClick={() => setShowNewClassDialog(true)}
              data-testid="button-new-class"
            >
              <Plus className="h-4 w-4 mr-2" />
              New Class
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        {isLoading ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground">Loading classes...</p>
          </div>
        ) : rosters.length === 0 ? (
          <div className="text-center py-12">
            <Users className="h-16 w-16 mx-auto mb-4 text-muted-foreground/50" />
            <h3 className="text-lg font-semibold mb-2">No classes yet</h3>
            <p className="text-muted-foreground mb-4">
              Create your first class to start organizing students
            </p>
            <Button onClick={() => setShowNewClassDialog(true)} data-testid="button-create-first-class">
              <Plus className="h-4 w-4 mr-2" />
              Create Class
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {rosters.map((roster) => (
              <Card key={roster.id} className="hover-elevate" data-testid={`card-class-${roster.classId}`}>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center justify-between gap-2">
                    <span className="truncate">{roster.className}</span>
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <Users className="h-4 w-4" />
                      <span className="text-sm font-normal" data-testid={`text-student-count-${roster.classId}`}>
                        {studentCountsByClass[roster.classId] || 0}
                      </span>
                    </div>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => openAddStudentDialog(roster)}
                    data-testid={`button-add-student-${roster.classId}`}
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Add Student
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => openBulkAddDialog(roster)}
                    data-testid={`button-bulk-add-${roster.classId}`}
                  >
                    <Upload className="h-4 w-4 mr-2" />
                    Bulk Add
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>

      {/* New Class Dialog */}
      <Dialog open={showNewClassDialog} onOpenChange={setShowNewClassDialog}>
        <DialogContent data-testid="dialog-new-class">
          <DialogHeader>
            <DialogTitle>Create New Class</DialogTitle>
            <DialogDescription>
              Create a new class or grade level to organize students
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="class-name">Class Name</Label>
              <Input
                id="class-name"
                placeholder="e.g., Grade 6, Period 1, Room 101"
                value={newClassName}
                onChange={(e) => setNewClassName(e.target.value)}
                data-testid="input-class-name"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowNewClassDialog(false)}
              data-testid="button-cancel-new-class"
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateClass}
              disabled={createClassMutation.isPending}
              data-testid="button-create-class"
            >
              {createClassMutation.isPending ? "Creating..." : "Create Class"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Student Dialog */}
      <Dialog open={showAddStudentDialog} onOpenChange={setShowAddStudentDialog}>
        <DialogContent data-testid="dialog-add-student">
          <DialogHeader>
            <DialogTitle>Add Student to {selectedClass?.className}</DialogTitle>
            <DialogDescription>
              Add a new student to this class
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="student-name">Student Name</Label>
              <Input
                id="student-name"
                placeholder="John Doe"
                value={studentName}
                onChange={(e) => setStudentName(e.target.value)}
                data-testid="input-student-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="device-id">Device ID</Label>
              <Input
                id="device-id"
                placeholder="chromebook-123"
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
                data-testid="input-device-id"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="device-name">Device Name (optional)</Label>
              <Input
                id="device-name"
                placeholder="Chromebook 1"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                data-testid="input-device-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="grade-level">Grade Level (optional)</Label>
              <Input
                id="grade-level"
                placeholder="6"
                value={gradeLevel}
                onChange={(e) => setGradeLevel(e.target.value)}
                data-testid="input-grade-level"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowAddStudentDialog(false)}
              data-testid="button-cancel-add-student"
            >
              Cancel
            </Button>
            <Button
              onClick={handleAddStudent}
              disabled={addStudentMutation.isPending}
              data-testid="button-submit-add-student"
            >
              {addStudentMutation.isPending ? "Adding..." : "Add Student"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Add Dialog */}
      <Dialog open={showBulkAddDialog} onOpenChange={setShowBulkAddDialog}>
        <DialogContent data-testid="dialog-bulk-add">
          <DialogHeader>
            <DialogTitle>Bulk Add to {selectedClass?.className}</DialogTitle>
            <DialogDescription>
              Upload a CSV file with student information
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="border-2 border-dashed border-border rounded-lg p-8 text-center">
              <Upload className="h-12 w-12 mx-auto mb-3 text-muted-foreground/50" />
              <div className="space-y-2">
                <Label htmlFor="bulk-roster-file" className="cursor-pointer">
                  <span className="text-primary hover:underline font-medium">
                    Choose CSV file
                  </span>{" "}
                  or drag and drop
                </Label>
                <input
                  id="bulk-roster-file"
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={handleFileChange}
                  data-testid="input-bulk-roster-file"
                />
                <p className="text-xs text-muted-foreground">
                  CSV format: studentName, deviceId, classId, gradeLevel (optional), deviceName (optional)
                </p>
              </div>
            </div>
            {csvFile && (
              <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
                <span className="text-sm font-medium">{csvFile.name}</span>
                <Button
                  onClick={handleUploadRoster}
                  disabled={uploadRosterMutation.isPending}
                  data-testid="button-upload-bulk-roster"
                >
                  {uploadRosterMutation.isPending ? "Uploading..." : "Upload"}
                </Button>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowBulkAddDialog(false);
                setCsvFile(null);
              }}
              data-testid="button-cancel-bulk-add"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
