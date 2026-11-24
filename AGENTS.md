# Agent Guidance

A Discord bot for bourbon bottle drops (Bun 1.4.5, discord.js v14, ES modules, SQLite per-server settings and drops). Agents open most PRs; the owner owns product decisions.

## Verify

`bun run verify` is the single local gate: Biome lint (`bun run lint`), `TZ=UTC bun test`, and `TZ=America/New_York bun test` (including Feature Map drift checks). CI runs the same checks as the `lint` and `test` jobs. Run it before you push. `bun run hooks:install` (once per clone) makes `git push` run the lint step first.

Beyond tests, `bun run control` lets you run and inspect your change locally (`doctor`, `map`, `execute`). Start with [.agents/skills/control-bill/SKILL.md](.agents/skills/control-bill/SKILL.md). Anything it cannot prove (real Discord rendering, clicks, permissions, timers across restarts, network services) goes under "For you to test" in the PR.

## Map

- Slash commands, what each needs, and how to run it: [docs/feature-map/INDEX.md](docs/feature-map/INDEX.md) and [notes.md](docs/feature-map/notes.md) (`bun run control map <command>`). Update `notes.md` and run `bun run control map --write` when you add, rename, or remove a command or subcommand.
- Shared primitives and the ADRs that constrain them (read before adding or changing a building block): [docs/primitives.md](docs/primitives.md)
- Merging, risk tiers, and the QA Status block: [docs/merge-policy.md](docs/merge-policy.md)
- Shipping a PR: [.agents/skills/ship-pr/SKILL.md](.agents/skills/ship-pr/SKILL.md)
- Filing friction (repo papercuts) in Linear: [.agents/skills/friction-log/SKILL.md](.agents/skills/friction-log/SKILL.md)
- Scheduled cleanup agents and their prompts: [docs/cleanup-automations.md](docs/cleanup-automations.md)
- Decisions to read before proposing big changes: [docs/adr/](docs/adr/)
- Rolling back a release: [docs/runbooks/rollback.md](docs/runbooks/rollback.md)

## Linear

This repo's Linear project is **Barrelhouse Bill** (team **Furtivespy**, key `FUR`).

- **Project name:** Barrelhouse Bill
- **Project ID:** `bd2a4f38-c401-42df-acf7-ece2c5e199b3`
- **URL:** https://linear.app/furtivespy/project/barrelhouse-bill-bf760c84cd92

When the user mentions Linear, issues, or project tracking for this codebase, scope work to the Barrelhouse Bill project unless they say otherwise. Every agent-filed issue uses Linear's priority field (`Urgent`, `High`, `Medium`, `Low`) and adds the `needs-decision` label whenever a human decision is required.

## Cleanup tickets

If your PR leaves something that should be removed later, file a `Cleanup:` issue before you finish, and link it in the PR's Cleanup section. Examples: a compatibility shim, an old code path kept during a rollout, old records preserved by a migration, or a temporary workaround. Nothing left behind? Write `none`.

Create it in Linear (team Furtivespy, project Barrelhouse Bill) from the **Cleanup** template, with label `cleanup`. Fill every section:

- **What to clean up:** one thing, naming the files.
- **Why it is safe:** what proves nothing depends on it.
- **Ready when:** a read-only check anyone can run that is true exactly when the cleanup is safe to do now, for example "`rg legacyFoo` finds no callers outside `src/util/legacyFoo.js`". If you cannot write one, say what you need to know and add `needs-decision`.
- **Door:** `two-way` or `one-way`. Deleting stored data is one-way: add `needs-decision`, because the weekly legacy reaper does not do those alone.

Use a priority; Low is the default. See [docs/cleanup-automations.md](docs/cleanup-automations.md) for what the weekly reaper will and will not do with these.

## Layout & Conventions

Entry point is `src/bot.js`. Adding a `.js` file under `src/commands/slash` or `src/events` (including subfolders) auto-loads it; command and event files `export default` the class.

- **Runtime:** Bun **1.4.5** (`packageManager` in `package.json`, `Dockerfile`, `.github/workflows/test.yml`). Do not switch to Node or npm without an explicit ask. `bunfig.toml` sets `install.minimumReleaseAge = 172800` (48 hours).
- **Config & env:** JSON config (`BOT_CONFIG` / `config.json.sample` / `data/config.json.example`), not `config.js`. Token, `clientId`, and `bugsnagKey` are config keys, not env vars. Optional `timezone` (IANA, default `America/New_York`) is the zone for offset-less `/drop create` close times. Every process env var is documented in `.env.example`.
- **Slash registration:** `DEV_GUILD_ID` (env) or `devGuildId` (config) registers guild-scoped commands; if neither is set, commands register globally. Never bake a guild id into source.
- **QA unlock:** `QA_UNLOCK_ADMIN_COMMANDS=1` (QA/dev only) registers admin slash commands without Discord Administrator `defaultMemberPermissions` and skips the runtime Administrator `permLevel` check. Leave unset in production.
- **Observability & shutdown:** Logger is console-only unless `bugsnagKey` is a real key (not blank / `abc123`). Tracing is off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set. SIGTERM/SIGINT stop `DropCloser`, close SQLite stores, then flush traces. Tracing must not install its own signal handlers.
- **Package/image identity:** `barrelhouse-bill-bot` (`gitea.willsullivan.dev/furtivespy/barrelhouse-bill-bot`).
- **Settings / SQLite & PR scope:** Follow [ADR 0001](docs/adr/0001-data-scope-changes-need-migration.md), [ADR 0002](docs/adr/0002-pr-scope-and-approved-design.md), and [ADR 0003](docs/adr/0003-agent-defaults-to-no.md). Keep unit tests runnable without a Discord token (`bun test`).
