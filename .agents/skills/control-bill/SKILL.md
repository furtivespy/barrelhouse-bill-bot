---
name: control-bill
description:
  Verify a change to Barrelhouse Bill yourself before asking a human. Use when
  you changed a slash command, button handler, drop store, or settings logic and
  need to run it locally or check machine state and Feature Map sync.
---

# control-bill

Use `bun run control <command>` for every local check of the bot's behavior. Add
`--json` to any command for machine-readable output. Exit 0 means success, 1
means a check failed, 2 means the call was wrong.

Start with `bun run control doctor`. If it fails, fix that first: a stale
`node_modules` makes local results untrustworthy.

## Commands

```sh
bun run control doctor
bun run control map
bun run control map drop
bun run control map --check
bun run control map --write
bun run control execute scripts/control-fixtures/ping.js --contains "Pong again!"
bun run control execute scripts/control-fixtures/drop-lifecycle.js --contains "Drop closed"
```

| You need to... | Run |
| --- | --- |
| Check Bun pin, `node_modules`, git hooks, Node, and `.env` | `bun run control doctor` |
| Find what a slash command does, needs, and what tests cover it | `bun run control map <command>` |
| Verify a slash command or button flow against real SQLite | `bun run control execute <fixture.js> [--contains <text>]` |
| Check the Feature Map is in sync with `src/commands/slash/` | `bun run control map --check` |

## Run a slash command or button flow

1. Run `bun run control map <command>` to read the generated entry plus the
   hand-written **Seed** and **Reach** notes.
2. Copy the closest file in `scripts/control-fixtures/` and adapt it. A fixture
   default-exports `async (ctx) => { ... }`:
   - `const session = await ctx.session()` creates a fresh temp directory with
     real `settings.sqlite` and `drops.sqlite` stores and a fake Discord guild
     and channel.
   - `await session.run("drop", { subcommand: "create", strings: {...}, integers: {...} })`
     routes through `src/handlers/interactionRouter.js` (including permission checks).
   - `await session.button("drop:in:<id>", { userId: "user-2", actor: { mod: false, admin: false } })`
     exercises button routing and post edits.
   - `await session.autocomplete("drop", { focusedName: "drop", focusedValue: "Blanton" })`
     exercises autocomplete.
3. Run `bun run control execute scripts/control-fixtures/<name>.js --contains "<expected>"`.
   `execute` exits 1 if any command logged an error or `--contains` did not match.

## Proof

Before opening or merging a PR that changes behavior:

1. Run `bun run verify` (Biome lint + `bun test` in `UTC` and `America/New_York`).
2. Run `bun run control doctor`.
3. Run `bun run control execute` on a fixture covering your change (with `--contains`).
4. Cite the exact commands and results in the PR's **Testing** section, and list
   what `execute` cannot prove under **For you to test**.

## What `execute` cannot prove

It uses a fake Discord interaction and channel with temp SQLite files. It cannot
prove real Discord embed rendering, Discord's client-side permission hiding
(`defaultMemberPermissions`), real button clicks in the Discord client, real-time
`DropCloser` timers across container restarts, or live Discord/Bugsnag/OTel
network calls. List those under "For you to test" instead of claiming them verified.

## Keep the map current

When you add, rename, or remove a slash command or subcommand:

1. Update `docs/feature-map/notes.md` (a `## /command` section with `- Seed:` and
   `- Reach:` lines).
2. Run `bun run control map --write`, then `bun run control map --check`.

`tests/featureMap.test.js` runs inside `bun test`, so CI catches a skipped update.
