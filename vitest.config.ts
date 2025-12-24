import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    // Run tests in these files
    include: ["server/__tests__/**/*.test.ts"],
    globals: true,
    // Setup file to mock database/env if needed
    setupFiles: ["./server/__tests__/testUtils.ts"],
    alias: {
      "@shared": path.resolve(__dirname, "./shared"),
      "@server": path.resolve(__dirname, "./server"),
    },
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "./shared"),
      "@server": path.resolve(__dirname, "./server"),
    },
  },
});