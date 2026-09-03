import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../..");

function read(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8").replace(/\r\n?/g, "\n");
}

describe("2.8.3 per-tab favicon release documentation", () => {
  it("pins every active release instruction to the versioned 2.8.3 artifact", () => {
    const readme = read("extension/README.md");
    const compliance = read("extension/COMPLIANCE.md");
    const deployment = read("DEPLOYMENT.md");

    for (const source of [readme, compliance, deployment]) {
      expect(source).toContain("ClassPilot-v2.8.3.zip");
      expect(source).not.toContain("ClassPilot-v2.8.2.zip");
      expect(source).not.toContain("ClassPilot-v2.8.1.zip");
    }
    // 2.8.2 is now a superseded archive, not a releasable one, so it joins the
    // obsolete list rather than staying an active upload instruction.
    expect(readme).toContain("Existing 2.7.9, 2.8.0,");
    expect(readme).toContain("2.8.1, and 2.8.2 archives do not contain");
    expect(deployment).toContain("Existing 2.7.9, 2.8.0, 2.8.1, and 2.8.2 archives are obsolete");
    expect(deployment).toContain("A narrower 2.7.9, 2.8.0, 2.8.1, or 2.8.2 archive is not releasable.");
  });

  it("documents the per-tab favicon scope of the open-tab snapshot", () => {
    const readme = read("extension/README.md");
    const compliance = read("extension/COMPLIANCE.md");

    expect(readme).toContain("Per-tab favicons in the open-tab snapshot (2.8.3)");
    for (const source of [readme, compliance]) {
      expect(source).toContain("https-only, limited to origin and path, and capped at 512 characters");
      expect(source).toMatch(/not (persisted|stored) locally/);
      expect(source).toMatch(/no favicon/);
    }
  });

  it("documents the downscaled active-preview upload and its evidence exemption", () => {
    const readme = read("extension/README.md");
    const compliance = read("extension/COMPLIANCE.md");

    expect(readme).toContain("SCREENSHOT_THUMBNAIL_WIDTH");
    for (const source of [readme, compliance]) {
      expect(source).toMatch(/640\s?px/);
      expect(source).toMatch(/safety-evidence captures[\s\S]*capture resolution/);
      expect(source).toMatch(/no additional Chrome permission|adds no Chrome permission/);
    }
    // The width is explicitly provisional; do not let it harden into a
    // documented constant without a measurement behind it.
    expect(readme).toContain("starting point");
  });

  it("documents exact policy scope, privacy reduction, and independent processing lanes", () => {
    for (const source of [read("extension/README.md"), read("extension/COMPLIANCE.md")]) {
      expect(source).toContain("restrictionAuthPassThroughV1");
      expect(source).toMatch(/300-second authentication attempt|300-second attempt limit/);
      expect(source).toMatch(/exact-host matching|host matching is exact/i);
      expect(source).toMatch(/neutral\s+sign-in title/);
      expect(source).toMatch(/no favicon/);
      expect(source).toMatch(/query strings/);
      expect(source).toMatch(/no Chrome permission/);
      expect(source).toMatch(/no managed-policy schema/);
      expect(source).toMatch(/Heartbeat.*screenshot|heartbeat.*Screenshot/s);
    }
  });
});
