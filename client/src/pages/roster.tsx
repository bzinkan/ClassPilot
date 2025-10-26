import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { ArrowLeft, Upload } from "lucide-react";
import { RosterManagement } from "@/components/roster-management";

export default function Roster() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [csvFile, setCsvFile] = useState<File | null>(null);

  const uploadRosterMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("roster", file);
      const response = await fetch("/api/roster/upload", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!response.ok) throw new Error("Upload failed");
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/roster/students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      toast({
        title: "Roster uploaded",
        description: "Class roster has been uploaded successfully",
      });
      setCsvFile(null);
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Upload failed",
        description: error.message,
      });
    },
  });

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
    if (csvFile) {
      uploadRosterMutation.mutate(csvFile);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-background">
        <div className="max-w-7xl mx-auto px-6 py-4">
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
                Manage student roster and device assignments
              </p>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="space-y-6">
          {/* CSV Upload Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Upload className="h-5 w-5" />
                Bulk Upload
              </CardTitle>
              <CardDescription>
                Upload a CSV file with student names, device IDs, class IDs, and grade levels
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="border-2 border-dashed border-border rounded-lg p-8 text-center">
                <Upload className="h-12 w-12 mx-auto mb-3 text-muted-foreground/50" />
                <div className="space-y-2">
                  <Label htmlFor="roster-file" className="cursor-pointer">
                    <span className="text-primary hover:underline font-medium">
                      Choose CSV file
                    </span>{" "}
                    or drag and drop
                  </Label>
                  <input
                    id="roster-file"
                    type="file"
                    accept=".csv"
                    className="hidden"
                    onChange={handleFileChange}
                    data-testid="input-roster-file"
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
                    data-testid="button-upload-roster"
                  >
                    {uploadRosterMutation.isPending ? "Uploading..." : "Upload"}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Roster Management Table */}
          <RosterManagement />
        </div>
      </main>
    </div>
  );
}
