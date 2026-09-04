import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../..");

function read(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8").replace(/\r\n?/g, "\n");
}

describe("2.8.4 restricted sign-in fix release documentation", () => {
  it("pins every active release instruction to the versioned 2.8.4 artifact", () => {
    const readme = read("extension/README.md");
    const compliance = read("extension/COMPLIANCE.md");
    const deployment = read("DEPLOYMENT.md");

    for (const source of [readme, compliance, deployment]) {
      expect(source).toContain("ClassPilot-v2.8.4.zip");
      expect(source).not.toContain("ClassPilot-v2.8.3.zip");
      expect(source).not.toContain("ClassPilot-v2.8.2.zip");
    }
    // 2.8.3 is now a superseded archive, not a releasable one, so it joins the
    // obsolete list rather than staying an active upload instruction.
    expect(readme).toContain("Existing 2.7.9, 2.8.0,");
    expect(readme).toContain("2.8.1, 2.8.2, and 2.8.3 archives do not contain");
    expect(deployment).toContain("Existing 2.7.9, 2.8.0, 2.8.1, 2.8.2, and 2.8.3 archives are obsolete");
    expect(deployment).toContain("A narrower 2.7.9, 2.8.0, 2.8.1, 2.8.2, or 2.8.3 archive is not releasable.");
  });

  it("documents the restricted sign-in fix as a correctness fix only", () => {
    const readme = read("extension/README.md");
    const compliance = read("extension/COMPLIANCE.md");

    expect(readme).toContain("Restricted sign-in acceptance fix (2.8.4)");
    for (const source of [readme, compliance]) {
      // The customer-visible symptom, not the internal auth-context mechanism.
      expect(source).toContain("rejected its own successful sign-in");
      expect(source).toMatch(/Waypoint or (a )?Flight Path/);
      expect(source).toContain("correctness fix");
      // 2.8.4 grants nothing new; the documentation must not read as a feature.
      expect(source).toContain("no additional data");
      expect(source).toMatch(/no Chrome permission/);
      expect(source).toMatch(/no managed-policy key/);
    }
  });

  it("documents the per-tab favicon scope of the open-tab snapshot", () => {
    const readme = read("extension/README.md");
    const compliance = read("extension/COMPLIANCE.md");

    expect(readme).toContain("Per-tab favicons in the open-tab snapshot (2.8.3)");
    // The 512-char filter applies to the open-tab snapshot only; the heartbeat's
    // active-tab favicon is still Chrome's raw value, so the privacy bullet must
    // scope the parenthetical to the snapshot rather than claim it for both.
    expect(readme).toContain("Favicon URL of the active tab, and of each open HTTP/HTTPS tab in the tab snapshot (https-only, limited to origin and path, and capped at 512 characters)");
    expect(readme).not.toContain("Favicon URL of the active tab and of each open HTTP/HTTPS tab (https-only");
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
