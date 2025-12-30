import { createApp } from "./app";
import { initializeApp } from "./init";
import { setupVite, serveStatic, log } from "./vite";

(async () => {
  // Initialize default data
  try {
    await initializeApp();
  } catch (error) {
    console.error("Failed to initialize app:", error);
    throw error;
  }

  const { app, server } = await createApp();

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    console.log("[production] Setting up static file serving...");
    console.log("[production] import.meta.dirname:", import.meta.dirname);
    console.log("[production] Expected public path:", import.meta.dirname + "/public");
    serveStatic(app);
    console.log("[production] Static file serving configured successfully");
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  server.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    }
  );

  // Graceful shutdown handlers
  const gracefulShutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down gracefully...`);

    // Stop accepting new connections
    server.close(() => {
      console.log("HTTP server closed");
    });

    // Set timeout to force shutdown if graceful shutdown takes too long
    const forceShutdownTimeout = setTimeout(() => {
      console.error("Forced shutdown after timeout");
      process.exit(1);
    }, 30000); // 30 second timeout

    try {
      // TODO: Close WebSocket connections gracefully
      // TODO: Drain database connection pool if needed
      console.log("Cleanup complete");
      clearTimeout(forceShutdownTimeout);
      process.exit(0);
    } catch (error) {
      console.error("Error during shutdown:", error);
      clearTimeout(forceShutdownTimeout);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
})();
