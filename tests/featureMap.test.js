import { describe, expect, test } from "bun:test";
import path from "node:path";
import { check, loadCommands } from "../scripts/control/featureMap.js";
import { runDoctor } from "../scripts/control/doctor.js";
import { allText, runFixtureFile } from "../scripts/control/execute.js";

const ROOT = path.resolve(import.meta.dir, "..");

describe("Feature Map", () => {
  test("INDEX.md and notes.md are in sync with src/commands/slash", async () => {
    const problems = await check();
    expect(problems).toEqual([]);
  });

  test("discovers all slash commands", async () => {
    const commands = await loadCommands({ refresh: true });
    expect(commands.map((c) => c.name)).toEqual(["drop", "ping", "settings", "status"]);
  });
});

describe("control-bill", () => {
  test("doctor succeeds with no error-level findings", () => {
    const report = runDoctor(ROOT);
    expect(report.ok).toBe(true);
  });

  test("executes ping and drop-lifecycle fixtures without logged errors", async () => {
    const ping = await runFixtureFile(path.join(ROOT, "scripts/control-fixtures/ping.js"));
    expect(allText(ping.results)).toContain("Pong again!");
    expect(ping.results.flatMap((r) => r.logged)).toEqual([]);

    const drop = await runFixtureFile(
      path.join(ROOT, "scripts/control-fixtures/drop-lifecycle.js")
    );
    expect(allText(drop.results)).toContain("Drop closed");
    expect(drop.returned).toEqual({
      dropStatus: "closed",
      signups: [
        { userId: "user-1", status: "allocated" },
        { userId: "user-2", status: "waitlist" },
      ],
    });
    expect(drop.results.flatMap((r) => r.logged)).toEqual([]);
  });
});
