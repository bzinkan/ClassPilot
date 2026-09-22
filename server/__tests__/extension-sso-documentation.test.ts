import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../..");

function read(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8").replace(/\r\n?/g, "\n");
}

describe("2.9.3 release documentation and preserved sign-in guarantees", () => {
  it("pins every active release instruction to the versioned 2.9.3 artifact", () => {
    const readme = read("extension/README.md");
    const compliance = read("extension/COMPLIANCE.md");
    const deployment = read("DEPLOYMENT.md");

    for (const source of [readme, compliance, deployment]) {
      expect(source).toContain("ClassPilot-v2.9.3.zip");
      expect(source).not.toContain("ClassPilot-v2.9.0.zip");
      expect(source).not.toContain("ClassPilot-v2.8.9.zip");
      expect(source).not.toContain("ClassPilot-v2.8.8.zip");
      expect(source).not.toContain("ClassPilot-v2.8.4.zip");
      expect(source).not.toContain("ClassPilot-v2.8.3.zip");
      expect(source).not.toContain("ClassPilot-v2.8.2.zip");
    }
    expect(readme).toContain("Earlier archives do not");
    expect(deployment).toContain("An earlier archive is not releasable as 2.9.3.");
    expect(deployment).toContain("afterHoursSafetyOnlyV1");
    expect(deployment).toContain("schoolWebsiteBlockEnforcementV1");
  });

  it("requires the paired migration and explicit rollout while keeping Live View UI disabled", () => {
    for (const path of ["DEPLOYMENT.md", "extension/README.md", "extension/COMPLIANCE.md", "CLASSPILOT_2_8_9_RELEASE.md", "CLASSPILOT_2_9_0_RELEASE.md", "CLASSPILOT_2_9_1_RELEASE.md"]) {
      const source = read(path);
      expect(source).toContain("classpilot-scheduled-classroom-20260915");
      expect(source).toContain("CLASSPILOT_SCHEDULED_CLASSROOM_MODE=off");
      expect(source).toContain("scheduledClassroomV1");
      expect(source).toContain("scopedAuthorityChecksV1");
      expect(source).toContain("Live View remains backend-only");
      expect(source).toMatch(/teacher Live View UI stays disabled/);
    }
    for (const path of ["CLASSPILOT_2_8_9_RELEASE.md", "CLASSPILOT_2_9_0_RELEASE.md", "CLASSPILOT_2_9_1_RELEASE.md"]) {
      const candidate = read(path);
      expect(candidate).toContain("This candidate update does not tag, package, upload, publish or activate the rollout.");
      expect(candidate).toMatch(/Recheck the\s+live Store version immediately before any future upload/);
    }
  });

  it("documents the 2.9.0 startup recovery correction as a correction only", () => {
    const candidate = read("CLASSPILOT_2_9_0_RELEASE.md");
    const readme = read("extension/README.md");

    expect(candidate).toContain("npm run test:extension:red-on-old");
    expect(candidate).toContain("remains unconfirmed");
    expect(candidate).toContain("Submit with deferred publishing");
    expect(candidate).toContain("ClassPilot-v2.9.0.zip");
    for (const source of [candidate, readme]) {
      expect(source).toContain("authGateDiagnosticsV1");
      for (const cause of ["reconciled", "stalled", "superseded_joined", "policy_churn"]) {
        expect(source).toContain(`\`${cause}\``);
      }
      expect(source).toMatch(/9 seconds/);
      expect(source).toMatch(/chrome\.alarms[\s\S]*30 seconds/);
      expect(source).toMatch(/no (new )?Chrome permission/i);
      expect(source).toMatch(/managed-policy key/);
      // Manual reload is the fallback; it must never be described as seamless.
      expect(source).toMatch(/not seamless replacement/);
    }
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
