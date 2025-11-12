import { queryClient } from "@/lib/queryClient";

/**
 * Invalidates all student-related query caches across the application.
 * Use this helper whenever student data is created, updated, or deleted
 * to ensure all views (Dashboard, Roster, Admin) stay synchronized.
 */
export function invalidateStudentCaches() {
  queryClient.invalidateQueries({ queryKey: ["/api/roster/students"] });
  queryClient.invalidateQueries({ queryKey: ["/api/students"] });
  queryClient.invalidateQueries({ queryKey: ["/api/groups"], exact: false });
  queryClient.invalidateQueries({ queryKey: ["/api/admin/teacher-students"], exact: false });
  queryClient.invalidateQueries({ queryKey: ["/api/teacher/groups"], exact: false });
  queryClient.invalidateQueries({ queryKey: ["/api/admin/live-students"] });
}
