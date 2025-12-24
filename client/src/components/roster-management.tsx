import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Device, Student, Settings } from "@shared/schema";

type RosterFormData = {
  deviceId: string;
  deviceName: string;
  studentName: string;
  classId: string;
  gradeLevel: string;
};

type RosterStudentUpdate = {
  studentName?: string;
  deviceName?: string | null;
  classId?: string;
  gradeLevel?: string | null;
};

export function RosterManagement() {
  const { toast } = useToast();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null);
  const [formData, setFormData] = useState<RosterFormData>({
    deviceId: "",
    deviceName: "",
    studentName: "",
    classId: "",
    gradeLevel: "",
  });

  // Fetch all persisted students from database (not status map)
  const { data: students = [], isLoading } = useQuery<Student[]>({
    queryKey: ['/api/roster/students'],
  });

  const { data: devices = [] } = useQuery<Device[]>({
    queryKey: ['/api/roster/devices'],
  });

  // Fetch settings to get available grade levels
  const { data: settings } = useQuery<Settings>({
    queryKey: ['/api/settings'],
  });

  const availableGrades = settings?.gradeLevels || ['6', '7', '8', '9', '10', '11', '12'];
  const deviceById = new Map(devices.map((device) => [device.deviceId, device]));

  // Add student mutation
  const addStudentMutation = useMutation({
    mutationFn: async (data: RosterFormData) => {
      return await apiRequest("POST", "/api/roster/student", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/roster/students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      toast({
        title: "Student added",
        description: "Student has been added to the roster successfully",
      });
      setShowAddDialog(false);
      resetForm();
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to add student",
        description: error.message || "An error occurred",
      });
    },
  });

  // Edit student mutation
  const editStudentMutation = useMutation({
    mutationFn: async ({ deviceId, updates }: { deviceId: string; updates: RosterStudentUpdate }) => {
      return await apiRequest("PATCH", `/api/students/${deviceId}`, updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/roster/students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      toast({
        title: "Student updated",
        description: "Student information has been updated successfully",
      });
      setShowEditDialog(false);
      setSelectedStudent(null);
      resetForm();
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to update student",
        description: error.message || "An error occurred",
      });
    },
  });

  // Delete student mutation
  const deleteStudentMutation = useMutation({
    mutationFn: async (deviceId: string) => {
      return await apiRequest("DELETE", `/api/students/${deviceId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/roster/students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      toast({
        title: "Student removed",
        description: "Student has been removed from the roster successfully",
      });
      setShowDeleteDialog(false);
      setSelectedStudent(null);
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to remove student",
        description: error.message || "An error occurred",
      });
    },
  });

  const resetForm = () => {
    setFormData({
      deviceId: "",
      deviceName: "",
      studentName: "",
      classId: "",
      gradeLevel: "",
    });
  };

  const handleAdd = () => {
    if (!formData.studentName || !formData.deviceId) {
      toast({
        variant: "destructive",
        title: "Validation error",
        description: "Student name and device ID are required",
      });
      return;
    }
    addStudentMutation.mutate(formData);
  };

  const handleEdit = (student: Student) => {
    const deviceId = student.deviceId ?? "";
    const device = deviceId ? deviceById.get(deviceId) : undefined;
    setSelectedStudent(student);
    setFormData({
      deviceId,
      deviceName: device?.deviceName || "",
      studentName: student.studentName,
      classId: device?.classId || "",
      gradeLevel: student.gradeLevel || "",
    });
    setShowEditDialog(true);
  };

  const handleSaveEdit = () => {
    if (!selectedStudent) return;
    
    if (!selectedStudent.deviceId) {
      toast({
        variant: "destructive",
        title: "Missing device ID",
        description: "This student does not have a device assigned.",
      });
      return;
    }
    const selectedDevice = deviceById.get(selectedStudent.deviceId);
    const currentDeviceName = selectedDevice?.deviceName || "";
    const currentClassId = selectedDevice?.classId || "";
    const updates: RosterStudentUpdate = {};
    if (formData.studentName !== selectedStudent.studentName) {
      updates.studentName = formData.studentName;
    }
    if (formData.deviceName !== currentDeviceName) {
      updates.deviceName = formData.deviceName || null;
    }
    if (formData.classId !== currentClassId) {
      updates.classId = formData.classId;
    }
    if (formData.gradeLevel !== (selectedStudent.gradeLevel || "")) {
      updates.gradeLevel = formData.gradeLevel || null;
    }
    
    if (Object.keys(updates).length === 0) {
      toast({
        title: "No changes",
        description: "No changes were made",
      });
      setShowEditDialog(false);
      return;
    }
    
    editStudentMutation.mutate({ deviceId: selectedStudent.deviceId, updates });
  };

  const handleDelete = (student: Student) => {
    setSelectedStudent(student);
    setShowDeleteDialog(true);
  };

  const confirmDelete = () => {
    if (!selectedStudent) return;
    if (!selectedStudent.deviceId) {
      toast({
        variant: "destructive",
        title: "Missing device ID",
        description: "This student does not have a device assigned.",
      });
      return;
    }
    deleteStudentMutation.mutate(selectedStudent.deviceId);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5" />
              Roster Management
            </CardTitle>
            <CardDescription>
              Manage student roster - add, edit, or remove students
            </CardDescription>
          </div>
          <Button
            onClick={() => {
              resetForm();
              setShowAddDialog(true);
            }}
            data-testid="button-add-student"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Student
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="text-center py-8 text-muted-foreground">Loading roster...</div>
        ) : students.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No students in roster. Add students manually or upload a CSV file.
          </div>
        ) : (
          <div className="border rounded-lg">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Student Name</TableHead>
                  <TableHead>Device ID</TableHead>
                  <TableHead>Device Name</TableHead>
                  <TableHead>Class ID</TableHead>
                  <TableHead>Grade Level</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {students.map((student) => (
                  <TableRow key={student.deviceId} data-testid={`row-student-${student.deviceId}`}>
                    <TableCell className="font-medium">{student.studentName}</TableCell>
                    <TableCell className="font-mono text-sm">{student.deviceId ?? "—"}</TableCell>
                    <TableCell>{student.deviceId ? deviceById.get(student.deviceId)?.deviceName || "—" : "—"}</TableCell>
                    <TableCell>{student.deviceId ? deviceById.get(student.deviceId)?.classId || "—" : "—"}</TableCell>
                    <TableCell>{student.gradeLevel || "—"}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleEdit(student)}
                          data-testid={`button-edit-${student.deviceId}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleDelete(student)}
                          data-testid={`button-delete-${student.deviceId}`}
                        >
                          <Trash2 className="h-4 w-4" />
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

      {/* Add Student Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Student</DialogTitle>
            <DialogDescription>
              Add a new student to the roster manually
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="add-student-name">Student Name *</Label>
              <Input
                id="add-student-name"
                data-testid="input-add-student-name"
                value={formData.studentName}
                onChange={(e) => setFormData({ ...formData, studentName: e.target.value })}
                placeholder="John Doe"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-device-id">Device ID *</Label>
              <Input
                id="add-device-id"
                data-testid="input-add-device-id"
                value={formData.deviceId}
                onChange={(e) => setFormData({ ...formData, deviceId: e.target.value })}
                placeholder="device-001"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-device-name">Device Name (Optional)</Label>
              <Input
                id="add-device-name"
                data-testid="input-add-device-name"
                value={formData.deviceName}
                onChange={(e) => setFormData({ ...formData, deviceName: e.target.value })}
                placeholder="6th chromebook 1"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-class-id">Class ID</Label>
              <Input
                id="add-class-id"
                data-testid="input-add-class-id"
                value={formData.classId}
                onChange={(e) => setFormData({ ...formData, classId: e.target.value })}
                placeholder="class-101"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-grade-level">Grade Level</Label>
              <Select
                value={formData.gradeLevel}
                onValueChange={(value) => setFormData({ ...formData, gradeLevel: value })}
              >
                <SelectTrigger id="add-grade-level" data-testid="select-add-grade-level">
                  <SelectValue placeholder="Select grade" />
                </SelectTrigger>
                <SelectContent>
                  {availableGrades.map((grade) => (
                    <SelectItem key={grade} value={grade}>
                      Grade {grade}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleAdd}
              disabled={addStudentMutation.isPending}
              data-testid="button-confirm-add"
            >
              {addStudentMutation.isPending ? "Adding..." : "Add Student"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Student Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Student</DialogTitle>
            <DialogDescription>
              Update student information
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-student-name">Student Name *</Label>
              <Input
                id="edit-student-name"
                data-testid="input-edit-student-name"
                value={formData.studentName}
                onChange={(e) => setFormData({ ...formData, studentName: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Device ID (Read-only)</Label>
              <Input
                value={formData.deviceId}
                disabled
                className="bg-muted font-mono text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-device-name">Device Name (Optional)</Label>
              <Input
                id="edit-device-name"
                data-testid="input-edit-device-name"
                value={formData.deviceName}
                onChange={(e) => setFormData({ ...formData, deviceName: e.target.value })}
                placeholder="6th chromebook 1"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-class-id">Class ID</Label>
              <Input
                id="edit-class-id"
                data-testid="input-edit-class-id"
                value={formData.classId}
                onChange={(e) => setFormData({ ...formData, classId: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-grade-level">Grade Level</Label>
              <Select
                value={formData.gradeLevel}
                onValueChange={(value) => setFormData({ ...formData, gradeLevel: value })}
              >
                <SelectTrigger id="edit-grade-level" data-testid="select-edit-grade-level">
                  <SelectValue placeholder="Select grade" />
                </SelectTrigger>
                <SelectContent>
                  {availableGrades.map((grade) => (
                    <SelectItem key={grade} value={grade}>
                      Grade {grade}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveEdit}
              disabled={editStudentMutation.isPending}
              data-testid="button-confirm-edit"
            >
              {editStudentMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Student</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove "{selectedStudent?.studentName}" from the roster? 
              This will delete the student device and all associated activity data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteStudentMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={deleteStudentMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-roster"
            >
              {deleteStudentMutation.isPending ? "Removing..." : "Remove Student"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
