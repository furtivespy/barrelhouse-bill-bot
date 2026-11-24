#!/usr/bin/env bun

// Single local verification gate: matches the required CI checks (`lint` and `test`).
// Runs Biome lint, then `bun test` under both UTC and America/New_York so
// timezone-sensitive drop close-time logic is verified identically on Windows and Linux.

import { spawnSync } from "node:child_process";

const STEPS = [
  { label: "lint", command: ["bun", "run", "lint"], env: {} },
  { label: "test (UTC)", command: ["bun", "test"], env: { TZ: "UTC" } },
  { label: "test (America/New_York)", command: ["bun", "test"], env: { TZ: "America/New_York" } },
];

for (const step of STEPS) {
  console.log(`\n==> ${step.label}`);
  const result = spawnSync(step.command[0], step.command.slice(1), {
    stdio: "inherit",
    env: { ...process.env, ...step.env },
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
