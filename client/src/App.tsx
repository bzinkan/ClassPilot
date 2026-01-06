import { Switch, Route, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import NotFound from "@/pages/not-found";
import LandingPage from "@/pages/landing";
import PricingPage from "@/pages/pricing";
import Login from "@/pages/login";
import Dashboard from "@/pages/dashboard";
import Settings from "@/pages/settings";
import MySettings from "@/pages/my-settings";
import Admin from "@/pages/admin";
import AdminClasses from "@/pages/admin-classes";
import StudentsPage from "@/pages/students";
import Roster from "@/pages/roster";
import SchoolsList from "@/pages/super-admin/schools-list";
import CreateSchool from "@/pages/super-admin/create-school";
import SchoolDetail from "@/pages/super-admin/school-detail";
import PrivacyPage from "@/pages/privacy";
import TermsPage from "@/pages/terms";

function Router() {
  return (
    <Switch>
      <Route path="/" component={LandingPage} />
      <Route path="/pricing" component={PricingPage} />
      <Route path="/privacy" component={PrivacyPage} />
      <Route path="/terms" component={TermsPage} />
      <Route path="/login" component={Login} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/roster" component={Roster} />
      <Route path="/settings" component={Settings} />
      <Route path="/my-settings" component={MySettings} />
      <Route path="/admin" component={Admin} />
      <Route path="/admin/classes" component={AdminClasses} />
      <Route path="/students" component={StudentsPage} />
      <Route path="/super-admin/schools" component={SchoolsList} />
      <Route path="/super-admin/schools/new" component={CreateSchool} />
      <Route path="/super-admin/schools/:id" component={SchoolDetail} />
      <Route path="/class/:classId">
        {(params) => <Dashboard />}
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
