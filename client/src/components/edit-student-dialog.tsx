import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
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
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const editStudentSchema = z.object({
  studentName: z.string().min(1, "Name is required"),
  studentEmail: z.string().email("Invalid email format"),
  gradeLevel: z.string().optional(),
});

type EditStudentForm = z.infer<typeof editStudentSchema>;

interface Student {
  id: string;
  studentName: string;
  studentEmail: string;
  gradeLevel: string | null;
}

interface EditStudentDialogProps {
  student: Student;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function EditStudentDialog({ 
  student, 
  open, 
  onOpenChange,
  onSuccess,
}: EditStudentDialogProps) {
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
      toast({
        title: "Student updated",
        description: "Student information has been updated successfully.",
      });
      onOpenChange(false);
      form.reset();
      onSuccess?.();
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
