# Primitives

The shared building blocks of this codebase and which decisions constrain them. Read the matching entry (and its `ADRs`) before changing a primitive; reuse an existing primitive instead of creating a parallel one. If a PR adds or reshapes a primitive, or adds/supersedes an ADR, update this file in the same PR.

Each entry lists its code roots and current ADRs (`none` when no ADR applies). ADRs live in [docs/adr/](adr/).

## Guild settings store

Per-server overrides (`modRole`, `adminRole`, `systemNotice`) merged over defaults and persisted in `{dataDir}/settings.sqlite`.

- Code: `src/db/BunEnmap.js`, `src/db/dataDir.js`, `src/util/settings.js`, `src/commands/slash/settings.js`
- ADRs: [0001](adr/0001-data-scope-changes-need-migration.md)
- Notes: `BILL_DATA_DIR` overrides `./data` locally; containers always use `/data`. `BunEnmap` deep-clones on write and skips unreadable rows instead of poisoning the cache.

## Drops & sign-ups store

Versioned SQLite store (`{dataDir}/drops.sqlite`) holding bottle drops, first-come allocations, waitlists, removals, pickup states, embed rendering, CSV export, and restart-safe auto-close timers.

- Code: `src/db/drops.js`, `src/util/dropPost.js`, `src/util/dropMod.js`, `src/util/dropCloser.js`, `src/util/timeZone.js`
- ADRs: [0001](adr/0001-data-scope-changes-need-migration.md), [0002](adr/0002-pr-scope-and-approved-design.md)
- Notes: `joinSignup` and `removeSignup` use SQLite transactions to prevent over-allocation or duplicate waitlist promotion under concurrent presses. `DropCloser` reschedules open timed drops on `clientReady` and stops all timers on shutdown.

## Slash commands & interaction router

Auto-discovered slash command classes (`export default`) plus unified routing for slash commands, autocomplete, buttons, select menus, and modals (`customId` prefix before `:`).

- Code: `src/commands/slash/`, `src/base/SlashCommand.js`, `src/handlers/discover.js`, `src/handlers/slashcommands.js`, `src/handlers/interactionRouter.js`, `src/events/interactionCreate.js`
- ADRs: [0002](adr/0002-pr-scope-and-approved-design.md), [0003](adr/0003-agent-defaults-to-no.md)
- Notes: Renaming a command or changing its options or `permLevel` is a high-risk contract change. The generated [Feature Map](feature-map/INDEX.md) lists every slash command, subcommand, and test file.

## Permissions & QA unlock

Permission ladder (`User`, `Moderator`, `Administrator`, `Server Owner`, `Bot Owner`) evaluated against guild settings, plus the dev/QA-only admin unlock flag.

- Code: `src/config.permissionLevels.js`, `src/util/permissions.js`, `src/util/qaUnlock.js`
- ADRs: [0003](adr/0003-agent-defaults-to-no.md)
- Notes: `QA_UNLOCK_ADMIN_COMMANDS=1` must remain off in production; changing permission evaluation or unlock behavior is high risk.

## Bot lifecycle, logging & tracing

Client boot, event auto-discovery, console/Bugsnag logger, optional OpenTelemetry tracing, and SIGTERM/SIGINT shutdown (stops `DropCloser`, checkpoints/closes SQLite stores, then flushes traces).

- Code: `src/bot.js`, `src/events/ready.js`, `src/handlers/events.js`, `src/base/Event.js`, `src/base/EventTypes.js`, `src/util/gracefulShutdown.js`, `src/util/logger.js`, `src/util/tracing.js`
- ADRs: [0003](adr/0003-agent-defaults-to-no.md)
- Notes: Tracing must never register its own signal handlers (`gracefulShutdown.js` owns SIGTERM/SIGINT).

## Release pipeline

PR checks (`lint`, `test`, `docker-build`), opt-in `container-testing` PR builds, and merge-to-`main` semver tagging + Docker image push to `gitea.willsullivan.dev/furtivespy/barrelhouse-bill-bot`.

- Code: `.github/workflows/`, `Dockerfile`, `docker-compose.yml`
- ADRs: [0003](adr/0003-agent-defaults-to-no.md)
- Notes: Changes to workflows, `Dockerfile`, `docker-compose.yml`, or `/data` layout are high risk and require human merge. See [merge-policy](merge-policy.md) and [rollback runbook](runbooks/rollback.md).

## Verification harness

Local control CLI (`bun run control`), Feature Map generator/drift check, and fake Discord interaction harness used by fixtures and tests.

- Code: `scripts/control-bill.js`, `scripts/control/`, `scripts/control-fixtures/`, `tests/helpers/memoryStore.js`
- ADRs: none
- Notes: Runs real command and SQLite store code without a Discord token; see [.agents/skills/control-bill/SKILL.md](../.agents/skills/control-bill/SKILL.md) for what it cannot prove.
