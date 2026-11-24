import { describe, expect, test } from "bun:test";
import { assess, format, highRiskFiles } from "../scripts/pr-risk.js";

describe("pr-risk path rules", () => {
  test("returns null tier for routine command, util, test, and doc changes", () => {
    const result = assess([
      "src/util/dropPost.js",
      "tests/dropCreate.test.js",
      "README.md",
    ]);
    expect(result).toEqual({ tier: null, files: [] });
    expect(format(result)).toContain("No high-risk paths");
  });

  test("flags database, permission, container, workflow, and merge-gate paths as high", () => {
    const hits = highRiskFiles([
      "./src/db/drops.js",
      "src\\util\\permissions.js",
      "src/util/qaUnlock.js",
      "Dockerfile",
      "docker-compose.yml",
      ".github/workflows/release.yml",
      ".github/ship-pr.json",
      ".agents/skills/ship-pr/SKILL.md",
      "scripts/pr-risk.js",
      "docs/merge-policy.md",
      "docs/adr/0003-agent-defaults-to-no.md",
    ]);
    expect(hits).toHaveLength(11);
    const result = assess(["src/db/BunEnmap.js"]);
    expect(result.tier).toBe("high");
    expect(format(result)).toContain("high: a human merges");
  });
});
