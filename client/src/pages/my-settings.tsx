import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ArrowLeft, User, Settings as SettingsIcon, Save } from "lucide-react";
import type { TeacherSettings, FlightPath } from "@shared/schema";

const teacherSettingsSchema = z.object({
  maxTabsPerStudent: z.string().optional(),
  allowedDomains: z.string(),
  blockedDomains: z.string(),
  defaultFlightPathId: z.string().optional(),
});

type TeacherSettingsForm = z.infer<typeof teacherSettingsSchema>;

export default function MySettings() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const { data: teacherSettings, isLoading } = useQuery<TeacherSettings | null>({
    queryKey: ['/api/teacher/settings'],
  });

  const { data: flightPaths = [] } = useQuery<FlightPath[]>({
    queryKey: ['/api/flight-paths'],
  });

  const form = useForm<TeacherSettingsForm>({
    resolver: zodResolver(teacherSettingsSchema),
    defaultValues: {
      maxTabsPerStudent: "",
      allowedDomains: "",
      blockedDomains: "",
      defaultFlightPathId: "",
    },
  });

  useEffect(() => {
    if (teacherSettings) {
      form.reset({
        maxTabsPerStudent: teacherSettings.maxTabsPerStudent || "",
        allowedDomains: teacherSettings.allowedDomains?.join(", ") || "",
        blockedDomains: teacherSettings.blockedDomains?.join(", ") || "",
        defaultFlightPathId: teacherSettings.defaultFlightPathId || "",
      });
    }
  }, [teacherSettings, form]);

  const updateSettingsMutation = useMutation({
    mutationFn: async (data: TeacherSettingsForm) => {
      const payload = {
        maxTabsPerStudent: data.maxTabsPerStudent || null,
        allowedDomains: data.allowedDomains
          ? data.allowedDomains.split(",").map(d => d.trim()).filter(Boolean)
          : [],
        blockedDomains: data.blockedDomains
          ? data.blockedDomains.split(",").map(d => d.trim()).filter(Boolean)
          : [],
        defaultFlightPathId: data.defaultFlightPathId || null,
      };

      const response = await fetch('/api/teacher/settings', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        throw new Error('Failed to save settings');
      }

      return await response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/teacher/settings'] });
      toast({
        title: "Settings saved",
        description: "Your personal settings have been updated successfully.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to save settings",
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: TeacherSettingsForm) => {
    updateSettingsMutation.mutate(data);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto"></div>
          <p className="mt-4 text-muted-foreground">Loading settings...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b bg-card">
        <div className="max-w-5xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button
                data-testid="button-back"
                variant="ghost"
                size="icon"
                onClick={() => setLocation("/dashboard")}
              >
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <div className="flex items-center gap-3">
                <div className="p-2 bg-primary/10 rounded-lg">
                  <User className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold">My Settings</h1>
                  <p className="text-sm text-muted-foreground">Customize your personal teaching preferences</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <Card data-testid="card-classroom-controls">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <SettingsIcon className="h-5 w-5 text-primary" />
                  <CardTitle>Classroom Controls</CardTitle>
                </div>
                <CardDescription>
                  Configure default settings for your classroom. These settings apply to all your students.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <FormField
                  control={form.control}
                  name="maxTabsPerStudent"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Maximum Tabs Per Student</FormLabel>
                      <FormControl>
                        <Input
                          data-testid="input-max-tabs"
                          type="number"
                          placeholder="Leave empty for no limit"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        Limit the number of browser tabs students can have open. Leave empty to allow unlimited tabs.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="defaultFlightPathId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Default Flight Path</FormLabel>
                      <Select
                        value={field.value || ""}
                        onValueChange={field.onChange}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-default-flight-path">
                            <SelectValue placeholder="No default Flight Path" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="">No default Flight Path</SelectItem>
                          {flightPaths.map((fp) => (
                            <SelectItem key={fp.id} value={fp.id}>
                              {fp.flightPathName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        Automatically apply this Flight Path to students when they join your class.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="allowedDomains"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Allowed Domains</FormLabel>
                      <FormControl>
                        <Textarea
                          data-testid="textarea-allowed-domains"
                          placeholder="example.com, google.com, education.org"
                          className="min-h-[100px] font-mono text-sm"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        Comma-separated list of domains students are allowed to visit. These domains are in addition to school-wide allowed domains.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="blockedDomains"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Blocked Domains</FormLabel>
                      <FormControl>
                        <Textarea
                          data-testid="textarea-blocked-domains"
                          placeholder="facebook.com, twitter.com, instagram.com"
                          className="min-h-[100px] font-mono text-sm"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        Comma-separated list of domains to block for your students. These domains are in addition to school-wide blocked domains.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            <div className="flex justify-end gap-3">
              <Button
                data-testid="button-cancel"
                type="button"
                variant="outline"
                onClick={() => setLocation("/dashboard")}
              >
                Cancel
              </Button>
              <Button
                data-testid="button-save"
                type="submit"
                disabled={updateSettingsMutation.isPending}
              >
                <Save className="h-4 w-4 mr-2" />
                {updateSettingsMutation.isPending ? "Saving..." : "Save Settings"}
              </Button>
            </div>
          </form>
        </Form>
      </div>
    </div>
  );
}
