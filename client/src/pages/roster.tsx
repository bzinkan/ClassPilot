import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { ArrowLeft, Edit, Monitor } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Student } from "@shared/schema";

export default function RosterPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<Student | null>(null);

  // Edit form state
  const [editStudentName, setEditStudentName] = useState("");
  const [editGradeLevel, setEditGradeLevel] = useState("");

  // Fetch all registered devices/students
  const { data: students = [], isLoading } = useQuery<Student[]>({
    queryKey: ['/api/roster/students'],
  });

  // Group students by classroom location (classId)
  const studentsByClassroom = students.reduce((acc, student) => {
    const classroom = student.classId || "Unassigned";
    if (!acc[classroom]) {
      acc[classroom] = [];
    }
    acc[classroom].push(student);
    return acc;
  }, {} as Record<string, Student[]>);

  // Update student mutation
  const updateStudentMutation = useMutation({
    mutationFn: async (data: { deviceId: string; studentName?: string; gradeLevel?: string }) => {
      const response = await fetch(`/api/students/${data.deviceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          studentName: data.studentName || null,
          gradeLevel: data.gradeLevel || null,
        }),
      });
      if (!response.ok) throw new Error("Failed to update device");
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/roster/students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      toast({
        title: "Device updated",
        description: "Student information has been updated successfully",
      });
      setShowEditDialog(false);
      setSelectedDevice(null);
      setEditStudentName("");
      setEditGradeLevel("");
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Update failed",
        description: error.message,
      });
    },
  });

  const openEditDialog = (device: Student) => {
    setSelectedDevice(device);
    setEditStudentName(device.studentName || "");
    setEditGradeLevel(device.gradeLevel || "");
    setShowEditDialog(true);
  };

  const handleUpdateDevice = () => {
    if (!selectedDevice) return;

    updateStudentMutation.mutate({
      deviceId: selectedDevice.deviceId,
      studentName: editStudentName.trim() || undefined,
      gradeLevel: editGradeLevel.trim() || undefined,
    });
  };

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
                  Manage registered devices and assign student information
                </p>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        {isLoading ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground">Loading devices...</p>
          </div>
        ) : students.length === 0 ? (
          <div className="text-center py-12">
            <Monitor className="h-16 w-16 mx-auto mb-4 text-muted-foreground/50" />
            <h3 className="text-lg font-semibold mb-2">No devices registered</h3>
            <p className="text-muted-foreground">
              Devices will appear here once they register with the Chrome Extension
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {Object.entries(studentsByClassroom).map(([classroom, devices]) => (
              <Card key={classroom} data-testid={`card-classroom-${classroom}`}>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-2">
                    <span>{classroom}</span>
                    <span className="text-sm font-normal text-muted-foreground">
                      {devices.length} {devices.length === 1 ? 'device' : 'devices'}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Device ID</TableHead>
                        <TableHead>Device Name</TableHead>
                        <TableHead>Student Name</TableHead>
                        <TableHead>Grade Level</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {devices.map((device) => (
                        <TableRow key={device.deviceId} data-testid={`row-device-${device.deviceId}`}>
                          <TableCell className="font-mono text-sm">{device.deviceId}</TableCell>
                          <TableCell>{device.deviceName || '-'}</TableCell>
                          <TableCell>
                            {device.studentName ? (
                              device.studentName
                            ) : (
                              <span className="text-muted-foreground italic">Not assigned</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {device.gradeLevel || <span className="text-muted-foreground">-</span>}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEditDialog(device)}
                              data-testid={`button-edit-${device.deviceId}`}
                            >
                              <Edit className="h-4 w-4 mr-2" />
                              Edit
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>

      {/* Edit Device Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent data-testid="dialog-edit-device">
          <DialogHeader>
            <DialogTitle>Edit Device Information</DialogTitle>
            <DialogDescription>
              Assign or update student name and grade level for this device
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="device-id-display">Device ID</Label>
              <Input
                id="device-id-display"
                value={selectedDevice?.deviceId || ''}
                disabled
                className="font-mono text-sm"
                data-testid="input-device-id-display"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="device-name-display">Device Name</Label>
              <Input
                id="device-name-display"
                value={selectedDevice?.deviceName || 'N/A'}
                disabled
                data-testid="input-device-name-display"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-student-name">Student Name</Label>
              <Input
                id="edit-student-name"
                placeholder="Enter student name"
                value={editStudentName}
                onChange={(e) => setEditStudentName(e.target.value)}
                data-testid="input-edit-student-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-grade-level">Grade Level</Label>
              <Input
                id="edit-grade-level"
                placeholder="e.g., 9 or 10th Grade"
                value={editGradeLevel}
                onChange={(e) => setEditGradeLevel(e.target.value)}
                data-testid="input-edit-grade-level"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowEditDialog(false)}
              data-testid="button-cancel-edit"
            >
              Cancel
            </Button>
            <Button
              onClick={handleUpdateDevice}
              disabled={updateStudentMutation.isPending}
              data-testid="button-save-edit"
            >
              {updateStudentMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
