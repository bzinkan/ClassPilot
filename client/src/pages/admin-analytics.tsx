import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { apiRequest } from "@/lib/queryClient";
import { ArrowLeft, BarChart3, Users, Monitor, Clock, Globe, TrendingUp } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";

interface AnalyticsSummary {
  summary: {
    totalStudents: number;
    activeStudents: number;
    totalDevices: number;
    totalTeachers: number;
    totalBrowsingMinutes: number;
    period: string;
  };
  topWebsites: Array<{ domain: string; visits: number; minutes: number }>;
  hourlyActivity: Array<{ hour: number; count: number }>;
}

interface TeacherStats {
  teachers: Array<{
    id: string;
    name: string;
    email: string;
    sessionCount: number;
    totalSessionMinutes: number;
    groupCount: number;
  }>;
  period: string;
}

export default function AdminAnalytics() {
  const [, setLocation] = useLocation();
  const [summaryPeriod, setSummaryPeriod] = useState<string>("24h");
  const [teacherPeriod, setTeacherPeriod] = useState<string>("7d");

  const { data: summaryData, isLoading: summaryLoading } = useQuery<AnalyticsSummary>({
    queryKey: ["/api/admin/analytics/summary", summaryPeriod],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/analytics/summary?period=${summaryPeriod}`);
      return res.json();
    },
  });

  const { data: teacherData, isLoading: teacherLoading } = useQuery<TeacherStats>({
    queryKey: ["/api/admin/analytics/by-teacher", teacherPeriod],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/analytics/by-teacher?period=${teacherPeriod}`);
      return res.json();
    },
  });

  const formatMinutes = (minutes: number) => {
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  };

  const maxHourlyCount = summaryData?.hourlyActivity
    ? Math.max(...summaryData.hourlyActivity.map(h => h.count), 1)
    : 1;

  return (
    <div className="container mx-auto p-6 max-w-6xl space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-lg bg-primary flex items-center justify-center">
            <BarChart3 className="h-6 w-6 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-3xl font-semibold">Usage Analytics</h1>
            <p className="text-muted-foreground">School-wide activity reports and statistics</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button
            variant="outline"
            onClick={() => setLocation("/admin")}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Admin
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Activity Summary</h2>
        <Select value={summaryPeriod} onValueChange={setSummaryPeriod}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="24h">Last 24 hours</SelectItem>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {summaryLoading ? (
        <div className="text-center py-8 text-muted-foreground">Loading analytics...</div>
      ) : summaryData ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-blue-100 dark:bg-blue-900 flex items-center justify-center">
                    <Users className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{summaryData.summary.activeStudents}</p>
                    <p className="text-sm text-muted-foreground">Active Students</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-2">of {summaryData.summary.totalStudents} total</p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-green-100 dark:bg-green-900 flex items-center justify-center">
                    <Monitor className="h-5 w-5 text-green-600 dark:text-green-400" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{summaryData.summary.totalDevices}</p>
                    <p className="text-sm text-muted-foreground">Devices</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-purple-100 dark:bg-purple-900 flex items-center justify-center">
                    <Clock className="h-5 w-5 text-purple-600 dark:text-purple-400" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{formatMinutes(summaryData.summary.totalBrowsingMinutes)}</p>
                    <p className="text-sm text-muted-foreground">Total Browsing</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-amber-100 dark:bg-amber-900 flex items-center justify-center">
                    <TrendingUp className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{summaryData.summary.totalTeachers}</p>
                    <p className="text-sm text-muted-foreground">Teachers</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Top Websites */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Globe className="h-5 w-5" />
                  Top Websites
                </CardTitle>
                <CardDescription>Most visited domains</CardDescription>
              </CardHeader>
              <CardContent>
                {summaryData.topWebsites.length === 0 ? (
                  <p className="text-muted-foreground text-center py-4">No website data available</p>
                ) : (
                  <div className="space-y-3">
                    {summaryData.topWebsites.map((site, idx) => (
                      <div key={site.domain} className="flex items-center gap-3">
                        <span className="text-sm text-muted-foreground w-6">{idx + 1}.</span>
                        <div className="flex-1">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-medium truncate max-w-[200px]">{site.domain}</span>
                            <span className="text-xs text-muted-foreground">{formatMinutes(site.minutes)}</span>
                          </div>
                          <div className="h-2 bg-muted rounded-full overflow-hidden">
                            <div
                              className="h-full bg-primary rounded-full"
                              style={{
                                width: `${(site.visits / summaryData.topWebsites[0].visits) * 100}%`
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Activity by Hour */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BarChart3 className="h-5 w-5" />
                  Activity by Hour
                </CardTitle>
                <CardDescription>Last 24 hours activity distribution</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-end gap-1 h-32">
                  {summaryData.hourlyActivity.map((hour) => (
                    <div key={hour.hour} className="flex-1 flex flex-col items-center">
                      <div
                        className="w-full bg-primary/80 rounded-t"
                        style={{
                          height: `${Math.max((hour.count / maxHourlyCount) * 100, 2)}%`,
                          minHeight: hour.count > 0 ? '4px' : '2px'
                        }}
                      />
                    </div>
                  ))}
                </div>
                <div className="flex justify-between mt-2 text-xs text-muted-foreground">
                  <span>12am</span>
                  <span>6am</span>
                  <span>12pm</span>
                  <span>6pm</span>
                  <span>11pm</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}

      {/* Teacher Activity */}
      <div className="flex items-center justify-between mt-8">
        <h2 className="text-xl font-semibold">Teacher Activity</h2>
        <Select value={teacherPeriod} onValueChange={setTeacherPeriod}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="pt-6">
          {teacherLoading ? (
            <div className="text-center py-8 text-muted-foreground">Loading teacher data...</div>
          ) : teacherData?.teachers && teacherData.teachers.length > 0 ? (
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">Teacher</th>
                    <th className="px-4 py-3 text-left font-medium">Sessions</th>
                    <th className="px-4 py-3 text-left font-medium">Session Time</th>
                    <th className="px-4 py-3 text-left font-medium">Groups</th>
                  </tr>
                </thead>
                <tbody>
                  {teacherData.teachers.map((teacher) => (
                    <tr key={teacher.id} className="border-t">
                      <td className="px-4 py-3">
                        <div className="font-medium">{teacher.name}</div>
                        <div className="text-xs text-muted-foreground">{teacher.email}</div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="secondary">{teacher.sessionCount}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        {formatMinutes(teacher.totalSessionMinutes)}
                      </td>
                      <td className="px-4 py-3">
                        {teacher.groupCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No teacher activity data available for this period.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
