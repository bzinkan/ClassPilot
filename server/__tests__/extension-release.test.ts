import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../..");

function readRepoFile(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function optionsAround(source: string, context: string) {
  const marker = `context: '${context}'`;
  const index = source.indexOf(marker);
  expect(index, `${context} options block should exist`).toBeGreaterThan(-1);
  return source.slice(Math.max(0, index - 200), index + 220);
}

describe("ClassPilot extension release package guards", () => {
  it("bumps the extension manifest to the pre-upload version", () => {
    const manifest = JSON.parse(readRepoFile("extension/manifest.json"));
    expect(manifest.version).toBe("2.5.7");
    expect(manifest.storage?.managed_schema).toBe("managed_schema.json");
  });

  it("uses a 10 second fallback delay for rate-limit retries", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    expect(serviceWorker).toContain("const API_RETRY_RATE_LIMIT_DELAY_MS = 10000;");
    expect(serviceWorker).toContain("const isRateLimited = response?.status === 429;");
    expect(serviceWorker).toContain(
      "const baseRetryDelayMs = isRateLimited ? API_RETRY_RATE_LIMIT_DELAY_MS : API_RETRY_BASE_DELAY_MS;"
    );
  });

  it("does not block user-facing actions behind the telemetry backoff gate", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    for (const context of [
      "student sign-out",
      "login roster",
      "student login",
      "poll response",
      "raise hand",
      "lower hand",
      "student message",
    ]) {
      expect(optionsAround(serviceWorker, context)).toContain("respectGlobalBackoff: false");
    }
  });

  it("keeps background telemetry respecting global backoff", () => {
    const serviceWorker = readRepoFile("extension/service-worker.js");
    for (const context of [
      "device heartbeat",
      "screenshot upload",
      "student registration",
      "device event",
      "student switched event",
    ]) {
      expect(optionsAround(serviceWorker, context)).not.toContain("respectGlobalBackoff: false");
    }
  });

  it("keeps the monitoring indicator tooltip reachable", () => {
    const contentScript = readRepoFile("extension/content.js");
    const indicatorCss = contentScript.match(/\.classpilot-monitoring-indicator\s*\{[\s\S]*?\}/)?.[0] || "";
    expect(indicatorCss).not.toContain("pointer-events: none");
  });

  it("documents the real heartbeat retention default and hosted privacy URL", () => {
    const compliance = readRepoFile("COPPA_FERPA_Compliance.md");
    const extensionCompliance = readRepoFile("extension/COMPLIANCE.md");
    expect(compliance).not.toContain("default 24 hours");
    expect(compliance).not.toContain("default: 24 hours");
    expect(compliance).toContain("default 30 days");
    expect(extensionCompliance).toContain("https://school-pilot.net/privacy");
  });
});
