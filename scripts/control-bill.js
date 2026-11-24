#!/usr/bin/env bun

// control-bill: one entry point for an agent (or human) to verify a change locally.
//
//   bun run control doctor
//   bun run control map [command] [--check | --write]
//   bun run control execute <fixture.js> [--contains text]
//
// Add --json to any command for machine-readable output. Exit code 0 means the
// command succeeded; 1 means a check failed; 2 means it was called wrong.

import { parseArgs } from "node:util";
import { formatDoctor, runDoctor } from "./control/doctor.js";
import * as featureMap from "./control/featureMap.js";
import { allText, formatSummary, runFixtureFile } from "./control/execute.js";

const USAGE = `Usage: bun run control <command> [options] [--json]

Commands:
  doctor                      Check this machine can produce trustworthy results
  map [command]               Print the Feature Map (or one command's entry)
  map --check                 Fail when INDEX.md or notes.md drifted from the code
  map --write                 Regenerate docs/feature-map/INDEX.md
  execute <fixture.js>        Run a fixture through the real command & SQLite code
      --contains <text>       Fail unless a reply, embed, or post includes the text
`;

class UsageError extends Error {}

function parse(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean" },
      check: { type: "boolean" },
      write: { type: "boolean" },
      contains: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}

const handlers = {
  async doctor() {
    const report = runDoctor();
    return { ok: report.ok, data: report, text: formatDoctor(report) };
  },

  async map({ values, positionals }) {
    if (values.write) {
      const file = await featureMap.writeIndex();
      return { ok: true, data: { wrote: file }, text: `Wrote ${file}` };
    }
    if (values.check) {
      const problems = await featureMap.check();
      return {
        ok: problems.length === 0,
        data: { problems },
        text: problems.length
          ? problems.map((p) => `- ${p}`).join("\n")
          : "Feature Map is in sync.",
      };
    }
    const name = positionals[1];
    if (name) {
      const text = await featureMap.describeFeature(name);
      if (!text) {
        const commands = await featureMap.loadCommands();
        const known = commands.map((c) => c.name).join(", ");
        return {
          ok: false,
          data: { error: `No slash command "${name}"` },
          text: `No slash command "${name}". Known: ${known}`,
        };
      }
      return { ok: true, data: { command: name, text }, text };
    }
    const commands = await featureMap.loadCommands();
    return {
      ok: true,
      data: { commands },
      text: commands.map((c) => `/${c.name}  ${c.description}`).join("\n"),
    };
  },

  async execute({ values, positionals }) {
    const file = positionals[1];
    if (!file) {
      throw new UsageError(
        "execute needs a fixture file, e.g. scripts/control-fixtures/ping.js"
      );
    }
    const { results, returned } = await runFixtureFile(file);
    const problems = [];
    for (const result of results) {
      for (const entry of result.logged) {
        if (entry.level === "error") {
          problems.push(
            `${result.label} logged error: ${entry.message.split("\n")[0]}`
          );
        }
      }
    }
    if (values.contains && !allText(results).includes(values.contains)) {
      problems.push(`No reply or post contained ${JSON.stringify(values.contains)}`);
    }
    const text = [
      ...results.map(formatSummary),
      returned === undefined ? null : `fixture returned: ${JSON.stringify(returned)}`,
      problems.length
        ? `\nPROBLEMS\n${problems.map((p) => `- ${p}`).join("\n")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");
    return {
      ok: problems.length === 0,
      data: { results, returned, problems },
      text,
    };
  },
};

async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parse(argv);
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  const command = parsed.positionals[0];
  if (parsed.values.help || !command) {
    console.log(USAGE);
    return command || parsed.values.help ? 0 : 2;
  }
  const handler = handlers[command];
  if (!handler) {
    console.error(`Unknown command "${command}".\n\n${USAGE}`);
    return 2;
  }
  try {
    const result = await handler(parsed);
    if (parsed.values.json) {
      console.log(
        JSON.stringify({ command, ok: result.ok, ...result.data }, null, 2)
      );
    } else {
      console.log(result.text);
    }
    return result.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n\n${USAGE}`);
      return 2;
    }
    if (parsed.values.json) {
      console.log(
        JSON.stringify(
          { command, ok: false, error: err.message, stack: err.stack },
          null,
          2
        )
      );
    } else {
      console.error(err.stack || err.message);
    }
    return 1;
  }
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}

export { main };
