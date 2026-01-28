import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Building2 } from "lucide-react";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";

const createSchoolSchema = z.object({
  name: z.string().min(1, "School name is required"),
  domain: z.string().min(1, "Domain is required").regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Invalid domain format (e.g., school.org)"),
  status: z.enum(["trial", "active", "suspended"]),
  maxLicenses: z.number().min(1).default(100),
  firstAdminEmail: z.string().min(1, "Admin email is required").email("Invalid email address"),
  firstAdminName: z.string().min(1, "Admin name is required"),
  firstAdminPassword: z.string().min(6, "Password must be at least 6 characters").optional().or(z.literal("")),
  billingEmail: z.string().email("Invalid email").optional().or(z.literal("")),
  trialDays: z.number().min(1).default(30),
});

type CreateSchoolForm = z.infer<typeof createSchoolSchema>;

export default function CreateSchool() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const form = useForm<CreateSchoolForm>({
    resolver: zodResolver(createSchoolSchema),
    defaultValues: {
      name: "",
      domain: "",
      status: "trial",
      maxLicenses: 100,
      firstAdminEmail: "",
      firstAdminName: "",
      firstAdminPassword: "",
      billingEmail: "",
      trialDays: 30,
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: CreateSchoolForm) => {
      const result = await apiRequest("POST", "/api/super-admin/schools", data);
      return result;
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/schools'] });
      
      if (data.adminCreated) {
        toast({
          title: "School created successfully",
          description: data.message || `Admin account created for ${data.adminEmail}`,
          duration: 8000,
        });
      } else {
        toast({
          title: "School created successfully",
        });
      }
      
      setLocation("/super-admin/schools");
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to create school",
        description: error.message || "An error occurred",
      });
    },
  });

  const onSubmit = (data: CreateSchoolForm) => {
    createMutation.mutate(data);
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto p-6 max-w-2xl">
        <Button
          variant="ghost"
          onClick={() => setLocation("/super-admin/schools")}
          className="mb-4"
          data-testid="button-back"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Schools
        </Button>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-primary flex items-center justify-center">
                <Building2 className="h-6 w-6 text-primary-foreground" />
              </div>
              <div>
                <CardTitle>Create New School</CardTitle>
                <CardDescription>
                  Add a new school to the system
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>School Name</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="St. Francis de Sales School"
                          data-testid="input-name"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="domain"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Google Workspace Domain</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="sfds.net"
                          data-testid="input-domain"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="status"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Status</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-status">
                            <SelectValue placeholder="Select status" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="trial">Trial</SelectItem>
                          <SelectItem value="active">Active</SelectItem>
                          <SelectItem value="suspended">Suspended</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="maxLicenses"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Max Student Licenses</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          placeholder="100"
                          data-testid="input-maxLicenses"
                          {...field}
                          onChange={(e) => field.onChange(parseInt(e.target.value))}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="billingEmail"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Billing Email (optional)</FormLabel>
                      <FormControl>
                        <Input
                          type="email"
                          placeholder="Defaults to admin email if left blank"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="trialDays"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Trial Duration (days)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={1}
                          {...field}
                          onChange={(e) => field.onChange(parseInt(e.target.value))}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="pt-4 border-t">
                  <h3 className="font-semibold mb-4">First School Admin</h3>

                  <div className="space-y-4">
                    <FormField
                      control={form.control}
                      name="firstAdminEmail"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Admin Email</FormLabel>
                          <FormControl>
                            <Input
                              type="email"
                              placeholder="admin@sfds.net"
                              data-testid="input-firstAdminEmail"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="firstAdminName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Admin Name</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="John Doe"
                              data-testid="input-firstAdminName"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="firstAdminPassword"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Password (Optional)</FormLabel>
                          <FormControl>
                            <Input
                              type="password"
                              placeholder="Leave blank for Google OAuth only"
                              data-testid="input-firstAdminPassword"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                          <p className="text-sm text-muted-foreground">
                            If left blank, the admin can only sign in with Google. Add a password for email/password login as a fallback.
                          </p>
                        </FormItem>
                      )}
                    />
                  </div>
                </div>

                <div className="flex gap-3 pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setLocation("/super-admin/schools")}
                    data-testid="button-cancel"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={createMutation.isPending}
                    data-testid="button-submit"
                  >
                    {createMutation.isPending ? "Creating..." : "Create School"}
                  </Button>
                </div>
              </form>
            </Form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
