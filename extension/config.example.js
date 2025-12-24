// Example Sentry config for the extension service worker.
// Copy to config.js and fill in the DSN for local development.

globalThis.SENTRY_DSN_EXTENSION = "";
globalThis.SENTRY_ENV = "development";
globalThis.SENTRY_DEV_MODE = false;
// Optional: override the default server URL at build/package time.
// Set this to your deployed dashboard URL if you are not using managed policies.
// globalThis.CLASSPILOT_SERVER_URL = "https://your-app.example.com";
