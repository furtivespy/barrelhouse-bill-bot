# Feature Map notes

Hand-written companion to the generated `INDEX.md`. One section per slash command.

- **Seed**: what state the command needs before it can do anything useful.
- **Reach**: how to run it with `bun run control execute <fixture>` against real temp SQLite stores (`settings.sqlite` and `drops.sqlite`). Anything `execute` cannot prove (real Discord rendering, Discord client-side permission hiding, real-time auto-close across container restarts) belongs in a PR's "For you to test".

`bun run control map --check` (and `tests/featureMap.test.js` during `bun test`) fail when a command has no section here, a section has no Seed or Reach line, or a `/command subcommand` reference names a subcommand that does not exist.

## /drop

Create and manage bourbon bottle drops, sign-ups, waitlists, pickups, CSV export, and manual/timed closes.

- Seed: `/drop create` needs no prior rows; `/drop close`, `/drop cancel`, `/drop list`, `/drop remove`, `/drop pickup`, and `/drop export` operate on an existing drop in the channel (or named via the optional `drop` autocomplete option). Non-create subcommands require `ManageMessages` (`actor: { mod: true }`).
- Reach: `bun run control execute scripts/control-fixtures/drop-lifecycle.js --contains "Drop closed"` exercises `/drop create`, pressing the **In** button (`drop:in:<id>`) for allocation + waitlist, `/drop list`, and `/drop close`. Real-time `DropCloser` timers across restarts and Discord's client-side `ManageMessages` visibility must be verified in Discord.

## /ping

Replies ephemerally with a Pong embed and an **Again** button that proves component routing (`ping:again`).

- Seed: none.
- Reach: `bun run control execute scripts/control-fixtures/ping.js --contains "Pong again!"`.

## /settings

Administrator command to view, override, or reset per-guild settings (`modRole`, `adminRole`, `systemNotice`) stored in `settings.sqlite`.

- Seed: none (`BunEnmap` seeds `default` automatically). Requires `Administrator` role (`actor: { admin: true }`) unless `QA_UNLOCK_ADMIN_COMMANDS=1`.
- Reach: `session.run("settings", { subcommand: "show" })`, then `subcommand: "set"` with `strings: { key: "modRole", value: "Staff" }`, then `subcommand: "get"` or `subcommand: "reset"`. Client-side Administrator hiding in Discord cannot be proved locally.

## /status

Replies ephemerally with bot package version, process uptime, and server count.

- Seed: none (reads `package.json` version, `process.uptime()`, and `client.guilds.cache.size`).
- Reach: `session.run("status")` and assert `--contains "Version:"`.
