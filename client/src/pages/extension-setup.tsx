import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CheckCircle2, AlertCircle, Copy, ExternalLink } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function ExtensionSetup() {
  const [configureStatus, setConfigureStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const { toast } = useToast();
  
  const serverUrl = window.location.origin;
  const extensionId = 'YOUR_EXTENSION_ID'; // This would be replaced with actual extension ID

  const configureExtension = async () => {
    try {
      // Try to send message to extension to update server URL
      const chromeApi = (window as any).chrome;
      if (typeof chromeApi !== 'undefined' && chromeApi.runtime) {
        chromeApi.runtime.sendMessage(extensionId, {
          type: 'update-server-url',
          serverUrl: serverUrl
        }, (_response: any) => {
          if (chromeApi.runtime.lastError) {
            console.error('Extension message error:', chromeApi.runtime.lastError);
            setConfigureStatus('error');
            toast({
              title: "Configuration Failed",
              description: "Could not communicate with the extension. Please configure manually.",
              variant: "destructive",
            });
          } else {
            setConfigureStatus('success');
            toast({
              title: "Success!",
              description: "Extension configured with development server URL",
            });
          }
        });
      } else {
        setConfigureStatus('error');
        toast({
          title: "Extension Not Found",
          description: "Please install the Chrome Extension first",
          variant: "destructive",
        });
      }
    } catch (error) {
      setConfigureStatus('error');
      toast({
        title: "Configuration Error",
        description: "An error occurred while configuring the extension",
        variant: "destructive",
      });
    }
  };

  const copyServerUrl = () => {
    navigator.clipboard.writeText(serverUrl);
    toast({
      title: "Copied!",
      description: "Server URL copied to clipboard",
    });
  };

  return (
    <div className="container max-width max-w-4xl mx-auto p-6 space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Chrome Extension Setup</h1>
        <p className="text-muted-foreground">
          Configure the ClassPilot Chrome Extension to connect to this development server
        </p>
      </div>

      <Alert>
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          <strong>Development Mode:</strong> The extension needs to be configured to use your development server URL instead of the production URL.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>Current Development Server</CardTitle>
          <CardDescription>
            Use this URL to configure the extension
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-muted px-4 py-2 rounded-md text-sm font-mono">
              {serverUrl}
            </code>
            <Button
              variant="outline"
              size="icon"
              onClick={copyServerUrl}
              data-testid="button-copy-url"
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Option 1: Manual Configuration (Recommended)</CardTitle>
          <CardDescription>
            Follow these steps to manually configure the extension
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ol className="list-decimal list-inside space-y-3 text-sm">
            <li>
              Click on the ClassPilot extension icon in your browser toolbar
              <span className="text-muted-foreground ml-2">(🎓 icon)</span>
            </li>
            <li>
              Click on <strong>"Advanced Settings"</strong> at the bottom of the popup
            </li>
            <li>
              In the <strong>"Server URL"</strong> field, paste:
              <div className="mt-2 ml-6">
                <code className="bg-muted px-3 py-1 rounded text-xs">
                  {serverUrl}
                </code>
              </div>
            </li>
            <li>
              Click <strong>"Save Settings"</strong>
            </li>
            <li>
              Reload the extension or restart your browser
            </li>
          </ol>

          {configureStatus === 'success' && (
            <Alert className="bg-green-50 border-green-200">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <AlertDescription className="text-green-800">
                Extension successfully configured! Students should now appear online on the dashboard.
              </AlertDescription>
            </Alert>
          )}

          {configureStatus === 'error' && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                Automatic configuration failed. Please follow the manual steps above.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Verification</CardTitle>
          <CardDescription>
            How to verify the extension is working
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <h4 className="font-medium text-sm">✅ Extension is working when:</h4>
            <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground ml-4">
              <li>Extension popup shows "Status: Online" with a green dot</li>
              <li>Student tiles on the dashboard show as green (Online)</li>
              <li>Current URL is displayed accurately on student tiles</li>
              <li>Last update timestamp refreshes every 10 seconds</li>
            </ul>
          </div>
          
          <div className="space-y-2 pt-4">
            <h4 className="font-medium text-sm">❌ Troubleshooting:</h4>
            <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground ml-4">
              <li>If students show as "Offline" → Check server URL in extension settings</li>
              <li>If URL shows "chrome://extensions/" → Extension needs to navigate to a real website</li>
              <li>If status is "Idle" → Student hasn't been active for 30+ seconds</li>
              <li>Check browser console (F12) for any error messages</li>
            </ul>
          </div>

          <div className="pt-4">
            <Button
              variant="outline"
              className="w-full"
              onClick={() => window.open('/dashboard', '_blank')}
              data-testid="button-go-to-dashboard"
            >
              <ExternalLink className="h-4 w-4 mr-2" />
              Go to Dashboard to Test
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-orange-200 bg-orange-50 dark:bg-orange-950 dark:border-orange-800">
        <CardHeader>
          <CardTitle className="text-orange-900 dark:text-orange-100">
            For Production Deployment
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-orange-800 dark:text-orange-200">
          <p>
            When you publish this app to production, the extension will automatically use the production URL: <code className="bg-orange-100 dark:bg-orange-900 px-2 py-1 rounded">https://classpilot.replit.app</code>
          </p>
          <p className="text-xs text-orange-700 dark:text-orange-300">
            No manual configuration will be needed for production deployments through Google Workspace admin.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
