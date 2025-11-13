import { Switch, Route, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import NotFound from "@/pages/not-found";
import Login from "@/pages/login";
import Dashboard from "@/pages/dashboard";
import Settings from "@/pages/settings";
import MySettings from "@/pages/my-settings";
import Admin from "@/pages/admin";
import AdminClasses from "@/pages/admin-classes";
import Roster from "@/pages/roster";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Login} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/roster" component={Roster} />
      <Route path="/settings" component={Settings} />
      <Route path="/my-settings" component={MySettings} />
      <Route path="/admin" component={Admin} />
      <Route path="/admin/classes" component={AdminClasses} />
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
