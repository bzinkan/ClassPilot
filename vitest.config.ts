import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "path";

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client", "src"),
      "@shared": path.resolve(__dirname, "shared"),
      "@server": path.resolve(__dirname, "server"),
    },
  },
  test: {
    environment: "node",
    include: ["server/__tests__/**/*.test.ts"],
    globals: true,
    setupFiles: ["./server/__tests__/setupEnv.ts"],
  },
});
