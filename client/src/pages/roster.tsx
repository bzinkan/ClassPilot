import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { ArrowLeft, Edit, Monitor, Trash2, UserPlus, GraduationCap, Plus, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Device, Student, Settings } from "@shared/schema";

type DialogType = 
  | { type: 'add-student'; deviceId: string }
  | { type: 'edit-student'; student: Student }
  | { type: 'edit-device'; device: Device }
  | null;

type DeleteDialogType =
  | { type: 'delete-student'; studentId: string; studentName: string }
  | { type: 'delete-device'; deviceId: string; deviceName: string }
  | null;

export default function RosterPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [dialog, setDialog] = useState<DialogType>(null);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogType>(null);
  const [selectedGrade, setSelectedGrade] = useState<string>("All");
  const [showGradeDialog, setShowGradeDialog] = useState(false);
  const [newGrade, setNewGrade] = useState("");

  // Form state
  const [formData, setFormData] = useState({
    studentName: "",
    gradeLevel: "",
    deviceName: "",
    classId: "",
  });

  // Fetch devices, students, and settings in parallel
  const { data: devices = [], isLoading: devicesLoading } = useQuery<Device[]>({
    queryKey: ['/api/roster/devices'],
  });

  const { data: students = [], isLoading: studentsLoading } = useQuery<Student[]>({
    queryKey: ['/api/roster/students'],
  });

  const { data: settings } = useQuery<Settings>({
    queryKey: ['/api/settings'],
  });

  const isLoading = devicesLoading || studentsLoading;

  // Set initial grade when settings load
  useEffect(() => {
    if (settings?.gradeLevels && settings.gradeLevels.length > 0 && selectedGrade === "All") {
      // Keep "All" as default
    }
  }, [settings, selectedGrade]);

  // Filter students by selected grade
  const filteredStudents = selectedGrade === "All" 
    ? students 
    : students.filter(s => s.gradeLevel === selectedGrade);

  // Get devices that have students in the selected grade
  const deviceIdsWithFilteredStudents = new Set(filteredStudents.map(s => s.deviceId));
  const filteredDevices = selectedGrade === "All"
    ? devices
    : devices.filter(d => deviceIdsWithFilteredStudents.has(d.deviceId));

  // Group students by deviceId
  const studentsByDevice = filteredStudents.reduce((acc, student) => {
    if (!acc[student.deviceId]) {
      acc[student.deviceId] = [];
    }
    acc[student.deviceId].push(student);
    return acc;
  }, {} as Record<string, Student[]>);

  // Group devices by classroom
  const devicesByClassroom = filteredDevices.reduce((acc, device) => {
    const classroom = device.classId || "Unassigned";
    if (!acc[classroom]) {
      acc[classroom] = [];
    }
    acc[classroom].push(device);
    return acc;
  }, {} as Record<string, Device[]>);

  // Create student mutation
  const createStudentMutation = useMutation({
    mutationFn: async (data: { studentName: string; deviceId: string; gradeLevel?: string }) => {
      return apiRequest('POST', '/api/roster/student', {
        studentName: data.studentName,
        deviceId: data.deviceId,
        gradeLevel: data.gradeLevel || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/roster/students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      toast({
        title: "Student assigned",
        description: "Student has been assigned to the device successfully",
      });
      setDialog(null);
      resetForm();
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to assign student",
        description: error.message,
      });
    },
  });

  // Update student mutation
  const updateStudentMutation = useMutation({
    mutationFn: async (data: { studentId: string; studentName?: string; gradeLevel?: string }) => {
      return apiRequest('PATCH', `/api/students/${data.studentId}`, {
        studentName: data.studentName,
        gradeLevel: data.gradeLevel || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/roster/students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      toast({
        title: "Student updated",
        description: "Student information has been updated successfully",
      });
      setDialog(null);
      resetForm();
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Update failed",
        description: error.message,
      });
    },
  });

  // Update device mutation
  const updateDeviceMutation = useMutation({
    mutationFn: async (data: { deviceId: string; deviceName?: string; classId?: string }) => {
      return apiRequest('PATCH', `/api/devices/${data.deviceId}`, {
        deviceName: data.deviceName || null,
        classId: data.classId,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/roster/devices'] });
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      toast({
        title: "Device updated",
        description: "Device information has been updated successfully",
      });
      setDialog(null);
      resetForm();
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Update failed",
        description: error.message,
      });
    },
  });

  // Delete student mutation
  const deleteStudentMutation = useMutation({
    mutationFn: async (studentId: string) => {
      return apiRequest('DELETE', `/api/students/${studentId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/roster/students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      toast({
        title: "Student removed",
        description: "Student assignment has been removed successfully",
      });
      setDeleteDialog(null);
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Delete failed",
        description: error.message,
      });
    },
  });

  // Delete device mutation
  const deleteDeviceMutation = useMutation({
    mutationFn: async (deviceId: string) => {
      return apiRequest('DELETE', `/api/devices/${deviceId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/roster/devices'] });
      queryClient.invalidateQueries({ queryKey: ['/api/roster/students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      toast({
        title: "Device deleted",
        description: "Device and all assigned students have been removed successfully",
      });
      setDeleteDialog(null);
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Delete failed",
        description: error.message,
      });
    },
  });

  // Update grades mutation
  const updateGradesMutation = useMutation({
    mutationFn: async (gradeLevels: string[]) => {
      if (!settings) throw new Error("Settings not loaded");
      
      const payload = {
        schoolId: settings.schoolId,
        schoolName: settings.schoolName,
        wsSharedKey: settings.wsSharedKey,
        retentionHours: settings.retentionHours,
        blockedDomains: settings.blockedDomains || [],
        allowedDomains: settings.allowedDomains || [],
        ipAllowlist: settings.ipAllowlist || [],
        gradeLevels,
      };
      
      const res = await apiRequest('POST', '/api/settings', payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/settings'] });
      toast({
        title: "Success",
        description: "Grade levels updated successfully",
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

  const handleAddGrade = () => {
    if (!newGrade.trim()) {
      toast({
        variant: "destructive",
        title: "Invalid Grade",
        description: "Please enter a grade level",
      });
      return;
    }

    const currentGrades = settings?.gradeLevels || [];
    if (currentGrades.includes(newGrade.trim())) {
      toast({
        variant: "destructive",
        title: "Duplicate Grade",
        description: "This grade level already exists",
      });
      return;
    }

    const newGrades = [...currentGrades, newGrade.trim()];
    updateGradesMutation.mutate(newGrades);
    setNewGrade("");
  };

  const handleDeleteGrade = (grade: string) => {
    const currentGrades = settings?.gradeLevels || [];
    if (currentGrades.length <= 1) {
      toast({
        variant: "destructive",
        title: "Cannot Delete",
        description: "You must have at least one grade level",
      });
      return;
    }

    const newGrades = currentGrades.filter(g => g !== grade);
    updateGradesMutation.mutate(newGrades);
  };

  const resetForm = () => {
    setFormData({
      studentName: "",
      gradeLevel: "",
      deviceName: "",
      classId: "",
    });
  };

  const openAddStudentDialog = (deviceId: string) => {
    resetForm();
    setDialog({ type: 'add-student', deviceId });
  };

  const openEditStudentDialog = (student: Student) => {
    setFormData({
      studentName: student.studentName,
      gradeLevel: student.gradeLevel || "",
      deviceName: "",
      classId: "",
    });
    setDialog({ type: 'edit-student', student });
  };

  const openEditDeviceDialog = (device: Device) => {
    setFormData({
      studentName: "",
      gradeLevel: "",
      deviceName: device.deviceName || "",
      classId: device.classId || "",
    });
    setDialog({ type: 'edit-device', device });
  };

  const handleSave = () => {
    if (!dialog) return;

    if (dialog.type === 'add-student') {
      if (!formData.studentName.trim()) {
        toast({
          variant: "destructive",
          title: "Validation error",
          description: "Student name is required",
        });
        return;
      }

      createStudentMutation.mutate({
        deviceId: dialog.deviceId,
        studentName: formData.studentName.trim(),
        gradeLevel: formData.gradeLevel.trim() || undefined,
      });
    } else if (dialog.type === 'edit-student') {
      if (!formData.studentName.trim()) {
        toast({
          variant: "destructive",
          title: "Validation error",
          description: "Student name is required",
        });
        return;
      }

      updateStudentMutation.mutate({
        studentId: dialog.student.id,
        studentName: formData.studentName.trim(),
        gradeLevel: formData.gradeLevel.trim() || undefined,
      });
    } else if (dialog.type === 'edit-device') {
      if (!formData.classId.trim()) {
        toast({
          variant: "destructive",
          title: "Validation error",
          description: "Classroom is required",
        });
        return;
      }

      updateDeviceMutation.mutate({
        deviceId: dialog.device.deviceId,
        deviceName: formData.deviceName.trim() || undefined,
        classId: formData.classId.trim(),
      });
    }
  };

  const handleDelete = () => {
    if (!deleteDialog) return;

    if (deleteDialog.type === 'delete-student') {
      deleteStudentMutation.mutate(deleteDialog.studentId);
    } else if (deleteDialog.type === 'delete-device') {
      deleteDeviceMutation.mutate(deleteDialog.deviceId);
    }
  };

  const isPending = createStudentMutation.isPending || updateStudentMutation.isPending || 
                    updateDeviceMutation.isPending || deleteStudentMutation.isPending || 
                    deleteDeviceMutation.isPending;

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
                <h1 className="text-2xl font-bold">Device Roster</h1>
                <p className="text-sm text-muted-foreground">
                  Manage devices and assign students to shared Chromebooks
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowGradeDialog(true)}
              data-testid="button-manage-grades-roster"
            >
              <GraduationCap className="h-4 w-4 mr-2" />
              Manage Grades
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Grade Level Tabs */}
        {settings?.gradeLevels && settings.gradeLevels.length > 0 && (
          <Tabs value={selectedGrade} onValueChange={setSelectedGrade} className="mb-6">
            <TabsList className="flex-wrap h-auto">
              <TabsTrigger 
                value="All" 
                data-testid="tab-grade-all"
              >
                All Grades
              </TabsTrigger>
              {settings.gradeLevels.map((grade) => (
                <TabsTrigger 
                  key={grade} 
                  value={grade} 
                  data-testid={`tab-grade-${grade}`}
                >
                  {grade}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}

        {isLoading ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground">Loading devices and students...</p>
          </div>
        ) : filteredDevices.length === 0 ? (
          <div className="text-center py-12">
            <Monitor className="h-16 w-16 mx-auto mb-4 text-muted-foreground/50" />
            <h3 className="text-lg font-semibold mb-2">
              {selectedGrade === "All" ? "No devices registered" : `No students in ${selectedGrade}`}
            </h3>
            <p className="text-muted-foreground">
              {selectedGrade === "All" 
                ? "Devices will appear here once they register with the Chrome Extension"
                : `No students with grade level "${selectedGrade}" have been assigned to any devices`
              }
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {Object.entries(devicesByClassroom)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([classroom, classroomDevices]) => (
                <Card key={classroom} data-testid={`card-classroom-${classroom}`}>
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between gap-2">
                      <span>{classroom}</span>
                      <span className="text-sm font-normal text-muted-foreground">
                        {classroomDevices.length} {classroomDevices.length === 1 ? 'device' : 'devices'}
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    {classroomDevices.map((device) => {
                      const deviceStudents = studentsByDevice[device.deviceId] || [];
                      
                      return (
                        <div 
                          key={device.deviceId} 
                          className="border rounded-lg p-4 space-y-4"
                          data-testid={`device-container-${device.deviceId}`}
                        >
                          {/* Device Header */}
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1 space-y-2">
                              <div className="flex items-center gap-2">
                                <Monitor className="h-5 w-5 text-muted-foreground" />
                                <div>
                                  <div className="flex items-center gap-2">
                                    <span className="font-mono text-sm font-semibold" data-testid={`text-device-id-${device.deviceId}`}>
                                      {device.deviceId}
                                    </span>
                                    {device.deviceName && (
                                      <span className="text-sm text-muted-foreground" data-testid={`text-device-name-${device.deviceId}`}>
                                        ({device.deviceName})
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-sm text-muted-foreground">
                                    Classroom: {device.classId}
                                  </div>
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => openAddStudentDialog(device.deviceId)}
                                data-testid={`button-add-student-${device.deviceId}`}
                              >
                                <UserPlus className="h-4 w-4 mr-2" />
                                Assign Student
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => openEditDeviceDialog(device)}
                                data-testid={`button-edit-device-${device.deviceId}`}
                              >
                                <Edit className="h-4 w-4 mr-2" />
                                Edit Device
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setDeleteDialog({ 
                                  type: 'delete-device', 
                                  deviceId: device.deviceId, 
                                  deviceName: device.deviceName || device.deviceId 
                                })}
                                data-testid={`button-delete-device-${device.deviceId}`}
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                Delete Device
                              </Button>
                            </div>
                          </div>

                          {/* Students Table */}
                          {deviceStudents.length === 0 ? (
                            <div className="text-center py-6 text-muted-foreground border-t" data-testid={`text-no-students-${device.deviceId}`}>
                              <p className="text-sm">No students assigned to this device</p>
                            </div>
                          ) : (
                            <div className="border-t pt-4">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>Student Name</TableHead>
                                    <TableHead>Grade Level</TableHead>
                                    <TableHead className="text-right">Actions</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {deviceStudents.map((student) => (
                                    <TableRow 
                                      key={student.id} 
                                      data-testid={`row-student-${student.id}`}
                                    >
                                      <TableCell data-testid={`text-student-name-${student.id}`}>
                                        {student.studentName}
                                      </TableCell>
                                      <TableCell data-testid={`text-grade-level-${student.id}`}>
                                        {student.gradeLevel || <span className="text-muted-foreground">-</span>}
                                      </TableCell>
                                      <TableCell className="text-right">
                                        <div className="flex items-center justify-end gap-2">
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => openEditStudentDialog(student)}
                                            data-testid={`button-edit-student-${student.id}`}
                                          >
                                            <Edit className="h-4 w-4 mr-1" />
                                            Edit
                                          </Button>
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => setDeleteDialog({ 
                                              type: 'delete-student', 
                                              studentId: student.id, 
                                              studentName: student.studentName 
                                            })}
                                            data-testid={`button-delete-student-${student.id}`}
                                          >
                                            <Trash2 className="h-4 w-4 mr-1" />
                                            Remove
                                          </Button>
                                        </div>
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              ))}
          </div>
        )}
      </main>

      {/* Add/Edit Dialog */}
      <Dialog open={dialog !== null} onOpenChange={() => setDialog(null)}>
        <DialogContent data-testid={`dialog-${dialog?.type || 'closed'}`}>
          <DialogHeader>
            <DialogTitle>
              {dialog?.type === 'add-student' && 'Assign Student to Device'}
              {dialog?.type === 'edit-student' && 'Edit Student Information'}
              {dialog?.type === 'edit-device' && 'Edit Device Information'}
            </DialogTitle>
            <DialogDescription>
              {dialog?.type === 'add-student' && 'Add a student assignment to this shared Chromebook'}
              {dialog?.type === 'edit-student' && 'Update student name and grade level'}
              {dialog?.type === 'edit-device' && 'Update device name and classroom assignment'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {dialog?.type === 'add-student' && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="add-student-name">Student Name *</Label>
                  <Input
                    id="add-student-name"
                    placeholder="Enter student name"
                    value={formData.studentName}
                    onChange={(e) => setFormData({ ...formData, studentName: e.target.value })}
                    data-testid="input-student-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="add-grade-level">Grade Level</Label>
                  <Input
                    id="add-grade-level"
                    placeholder="e.g., 9 or 10th Grade"
                    value={formData.gradeLevel}
                    onChange={(e) => setFormData({ ...formData, gradeLevel: e.target.value })}
                    data-testid="input-grade-level"
                  />
                </div>
              </>
            )}

            {dialog?.type === 'edit-student' && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="edit-student-name">Student Name *</Label>
                  <Input
                    id="edit-student-name"
                    placeholder="Enter student name"
                    value={formData.studentName}
                    onChange={(e) => setFormData({ ...formData, studentName: e.target.value })}
                    data-testid="input-edit-student-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-grade-level">Grade Level</Label>
                  <Input
                    id="edit-grade-level"
                    placeholder="e.g., 9 or 10th Grade"
                    value={formData.gradeLevel}
                    onChange={(e) => setFormData({ ...formData, gradeLevel: e.target.value })}
                    data-testid="input-edit-grade-level"
                  />
                </div>
              </>
            )}

            {dialog?.type === 'edit-device' && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="device-id-display">Device ID</Label>
                  <Input
                    id="device-id-display"
                    value={dialog.device.deviceId}
                    disabled
                    className="font-mono text-sm"
                    data-testid="input-device-id-display"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-device-name">Device Name</Label>
                  <Input
                    id="edit-device-name"
                    placeholder="Optional friendly name"
                    value={formData.deviceName}
                    onChange={(e) => setFormData({ ...formData, deviceName: e.target.value })}
                    data-testid="input-edit-device-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-class-id">Classroom *</Label>
                  <Input
                    id="edit-class-id"
                    placeholder="e.g., Room 101 or Math Period 3"
                    value={formData.classId}
                    onChange={(e) => setFormData({ ...formData, classId: e.target.value })}
                    data-testid="input-edit-class-id"
                  />
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialog(null)}
              disabled={isPending}
              data-testid="button-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={isPending}
              data-testid="button-save"
            >
              {isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialog !== null} onOpenChange={() => setDeleteDialog(null)}>
        <AlertDialogContent data-testid="dialog-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteDialog?.type === 'delete-student' && 'Remove Student Assignment?'}
              {deleteDialog?.type === 'delete-device' && 'Delete Device?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteDialog?.type === 'delete-student' && (
                <>
                  Are you sure you want to remove <strong>{deleteDialog.studentName}</strong> from this device?
                  This action cannot be undone.
                </>
              )}
              {deleteDialog?.type === 'delete-device' && (
                <>
                  Are you sure you want to delete device <strong>{deleteDialog.deviceName}</strong>?
                  This will also remove all student assignments for this device. This action cannot be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending} data-testid="button-cancel-delete">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isPending}
              data-testid="button-confirm-delete"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Grade Management Dialog */}
      <Dialog open={showGradeDialog} onOpenChange={setShowGradeDialog}>
        <DialogContent data-testid="dialog-manage-grades-roster">
          <DialogHeader>
            <DialogTitle>Manage Grade Levels</DialogTitle>
            <DialogDescription>
              Add or remove grade levels that appear as filter tabs in the Roster
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* Current Grades */}
            <div className="space-y-2">
              <Label>Current Grade Levels</Label>
              <div className="flex flex-wrap gap-2">
                {settings?.gradeLevels?.map((grade) => (
                  <Badge key={grade} variant="secondary" className="text-sm px-3 py-1" data-testid={`badge-grade-${grade}`}>
                    {grade}
                    <button
                      onClick={() => handleDeleteGrade(grade)}
                      className="ml-2 hover:text-destructive"
                      data-testid={`button-delete-grade-${grade}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            </div>

            {/* Add New Grade */}
            <div className="space-y-2">
              <Label htmlFor="new-grade">Add New Grade Level</Label>
              <div className="flex gap-2">
                <Input
                  id="new-grade"
                  placeholder="e.g., 5th, K, Pre-K"
                  value={newGrade}
                  onChange={(e) => setNewGrade(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleAddGrade();
                    }
                  }}
                  data-testid="input-new-grade-roster"
                />
                <Button 
                  onClick={handleAddGrade} 
                  disabled={updateGradesMutation.isPending}
                  data-testid="button-add-grade-roster"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => {
                setShowGradeDialog(false);
                setNewGrade("");
              }}
              data-testid="button-close-grade-dialog-roster"
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
