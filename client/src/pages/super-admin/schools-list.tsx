import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Building2, Plus, Users, GraduationCap, Shield } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface School {
  id: string;
  name: string;
  domain: string;
  status: string;
  maxLicenses: number;
  teacherCount: number;
  studentCount: number;
  adminCount: number;
  createdAt: string;
  trialEndsAt: string | null;
}

export default function SchoolsList() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const { data, isLoading } = useQuery<{ success: boolean; schools: School[] }>({
    queryKey: ['/api/super-admin/schools'],
  });

  const schools = data?.schools || [];

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive"> = {
      trial: "secondary",
      active: "default",
      suspended: "destructive",
    };
    return <Badge variant={variants[status] || "default"}>{status}</Badge>;
  };

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading schools...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold">Schools Management</h1>
            <p className="text-muted-foreground mt-2">
              Manage all schools and their configurations
            </p>
          </div>
          <Button
            onClick={() => setLocation("/super-admin/schools/new")}
            data-testid="button-create-school"
          >
            <Plus className="w-4 h-4 mr-2" />
            Create School
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {schools.map((school) => (
            <Card
              key={school.id}
              className="cursor-pointer hover-elevate active-elevate-2"
              onClick={() => setLocation(`/super-admin/schools/${school.id}`)}
              data-testid={`card-school-${school.id}`}
            >
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                <CardTitle className="text-lg font-semibold">
                  {school.name}
                </CardTitle>
                {getStatusBadge(school.status)}
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="flex items-center text-sm text-muted-foreground">
                    <Building2 className="w-4 h-4 mr-2" />
                    {school.domain}
                  </div>
                  <div className="grid grid-cols-3 gap-2 mt-4">
                    <div className="text-center">
                      <div className="flex items-center justify-center mb-1">
                        <Shield className="w-4 h-4 text-primary" />
                      </div>
                      <p className="text-2xl font-bold">{school.adminCount}</p>
                      <p className="text-xs text-muted-foreground">Admins</p>
                    </div>
                    <div className="text-center">
                      <div className="flex items-center justify-center mb-1">
                        <Users className="w-4 h-4 text-primary" />
                      </div>
                      <p className="text-2xl font-bold">{school.teacherCount}</p>
                      <p className="text-xs text-muted-foreground">Teachers</p>
                    </div>
                    <div className="text-center">
                      <div className="flex items-center justify-center mb-1">
                        <GraduationCap className="w-4 h-4 text-primary" />
                      </div>
                      <p className="text-2xl font-bold">{school.studentCount}</p>
                      <p className="text-xs text-muted-foreground">Students</p>
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground mt-4">
                    Max Licenses: {school.maxLicenses}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {schools.length === 0 && (
          <Card className="p-12 text-center">
            <Building2 className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
            <p className="text-lg font-semibold mb-2">No schools yet</p>
            <p className="text-muted-foreground mb-4">
              Create your first school to get started
            </p>
            <Button onClick={() => setLocation("/super-admin/schools/new")}>
              <Plus className="w-4 h-4 mr-2" />
              Create School
            </Button>
          </Card>
        )}
      </div>
    </div>
  );
}
