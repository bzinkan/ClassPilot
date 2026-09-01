import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../..");

function read(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8").replace(/\r\n?/g, "\n");
}

describe("2.8.1 restricted sign-in release documentation", () => {
  it("pins every active release instruction to the versioned 2.8.1 artifact", () => {
    const readme = read("extension/README.md");
    const compliance = read("extension/COMPLIANCE.md");
    const deployment = read("DEPLOYMENT.md");

    for (const source of [readme, compliance, deployment]) {
      expect(source).toContain("ClassPilot-v2.8.1.zip");
    }
    expect(readme).toContain("Existing 2.7.9 and 2.8.0");
    expect(deployment).toContain("Existing 2.7.9 and 2.8.0 archives are obsolete");
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
