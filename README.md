Barrelhouse Bill
================

A Discord bot that likes to drink bourbon. Built from the Stancy starter (Bun, discord.js v14, SQLite per-server settings, container deploy).

Right now the bot answers `/ping`, `/status`, and `/settings`. Group-drop commands come next.

## Local development

* Copy `config.json.sample` to `config.json` and fill in `token` and `clientId`
* Copy `.env.example` to `.env` and set `BOT_CONFIG` to the path of that config file
* Install [Bun](https://bun.sh) 1.4.3 (see `packageManager` in `package.json`)
* Install package dependencies: `bun install`
* Run the bot: `bun run start`
* Run tests: `bun test`

`bunfig.toml` sets `install.minimumReleaseAge = 172800` (48 hours). `bun install` and `bun update` skip npm versions published more recently than that.

Required config keys: `token`, `clientId`, `environment`.

Every process env var the code reads is listed in `.env.example`.

Optional:

* `bugsnagKey` (config) — when set, `error` logs are reported to Bugsnag. When unset, blank, or the placeholder `abc123`, the logger stays on the console only.
* `defaultSettings` — per-server defaults (`modRole`, `adminRole`, `systemNotice`) merged with guild overrides stored in SQLite
* `botOwnerId` — Discord user id treated as Bot Owner for permission checks. If unset, the Discord application owner (fetched on `clientReady`) is used.
* `BILL_DATA_DIR` (env) — local directory for SQLite files (defaults to `./data`). In a container this is always `/data`.
* `DEV_GUILD_ID` (env) or `devGuildId` (config) — register slash commands to this guild instead of globally. Instant updates while developing. If neither is set, commands register globally (and development logs a warning). There is no hardcoded fallback guild.
* `OTEL_EXPORTER_OTLP_ENDPOINT` (env) — optional OpenTelemetry. Tracing is off unless this endpoint is set.
* `OTEL_SERVICE_NAME` (env) — defaults to `barrelhouse-bill-bot`.
* `OTEL_EXPORTER_OTLP_HEADERS` (env) — comma-separated `key=value` headers for the exporter (for Honeycomb: `x-honeycomb-team=YOUR_API_KEY` and endpoint `https://api.honeycomb.io/v1/traces`).
* `OTEL_DEBUG_SPANS` (env) — set to `true` to also print spans to the console.

## Adding a command or event

Adding a `.js` file under `src/commands/slash` or `src/events` (including subfolders) is the only step to add a feature. The loaders auto-discover files, instantiate the **default-exported** class, and log each load. The project is ES modules (`package.json` `"type": "module"`); use `import`/`export`, not `require`/`module.exports`.

* Slash commands extend `src/base/SlashCommand.js`, set `this.data` (`SlashCommandBuilder`), and implement `execute`. Optional hooks: `autocomplete`, `button`, `selectMenu`, `modal`.
* Events extend `src/base/Event.js`, set `eventType` from `src/base/EventTypes.js` (Discord names such as `clientReady`), and implement `run(...)`. The ready handler file is still `src/events/ready.js`; it binds `Events.ClientReady` (`clientReady`).

Buttons, select menus, and modals are routed to the command whose name is the `customId` prefix before `:`. Example: `ping:again` is handled by `/ping`. `/ping` includes a sample **Again** button that proves this path.

Slash commands declare `permLevel` (User, Moderator, Administrator, Server Owner, Bot Owner). The interaction router compares that to the member's highest matching level (mod/admin role names come from guild settings). A non-mod cannot run a Moderator command.

`/settings` (Administrator) views and sets those guild keys. Overrides are stored in `{dataDir}/settings.sqlite` so they survive a container restart. Runtime files under `data/` are gitignored; the sample config in `data/` is committed. SIGTERM/SIGINT close the SQLite handles (WAL checkpoint) before exit.

Coding agents: see `AGENTS.md` for layout, Linear project, and conventions.

## Deploy on Will's server

The image is **`gitea.willsullivan.dev/furtivespy/barrelhouse-bill-bot`**.

### 1. GitHub secrets (repo settings)

This repo cannot set registry credentials from a pull request. In **GitHub → barrelhouse-bill-bot → Settings → Secrets and variables → Actions**, add:

| Secret | Value |
| --- | --- |
| `REGISTRY_USERNAME` | Username for `gitea.willsullivan.dev` |
| `REGISTRY_TOKEN` | Token/password for that registry |

Without those two secrets, `test.yml` still runs on pull requests, but `build-push.yml` / `release.yml` cannot push the image.

### 2. Discord application

Create (or reuse) a Discord application, enable the bot, copy the **token** and **application id** (`clientId`). Invite the bot to Will's server with the `bot` and `applications.commands` scopes.

### 3. Data volume config

Copy the sample, then replace every `REPLACE_ME_*` placeholder (`token` and `clientId`). Optional guild and user ids are empty strings in the sample — leave them `""` or set real snowflakes. Do not put a `REPLACE_ME_*` string in `devGuildId`; Discord will reject it and slash commands will not register.

```
cp data/config.json.example /path/to/bill-data/config.json
```

Required: `token`, `clientId`, `environment` (`production` on the server).

Optional guild / user ids (empty strings in the sample):

* `devGuildId` — Will's Discord **server** id, if you want slash commands to appear immediately. Leave it `""` to register globally (can take up to an hour).
* `botOwnerId` — Will's Discord **user** id (optional; otherwise the application owner is used).

No channel ids are required for `/ping` / `/status` / `/settings`.

### 4. Run the container

After secrets are in GitHub and a build has pushed `:latest` (merge to `main`, or **Actions → Build and Push Docker Image → Run workflow**):

```
docker run -d --name barrelhouse-bill-bot \
  --restart unless-stopped \
  -v /path/to/bill-data:/data \
  -e BOT_CONFIG=/data/config.json \
  gitea.willsullivan.dev/furtivespy/barrelhouse-bill-bot:latest
```

Or from this repo, with `data/config.json` filled in:

```
docker compose up -d
```

`docker-compose.yml` bind-mounts `./data` at `/data`. The image already sets `IS_IN_CONTAINER=true` and `BOT_CONFIG=/data/config.json`, so SQLite settings land on that volume.

Confirm `/ping` answers in Discord. If commands are missing, set `devGuildId` / `DEV_GUILD_ID` to the server id and restart (guild registration is instant).

### GitHub Actions

* `test.yml` — `bun test` **and** a no-push Docker image build on every push and pull request
* `build-push.yml` — build and push a commit-SHA tag on push to `main` (also `workflow_dispatch`)
* `release.yml` — on merge to `main`, semver-tag and push `vX.Y.Z` + `latest`

The image expects:

* Volume mounted at `/data` (config **and** SQLite settings)
* `BOT_CONFIG` (defaults to `/data/config.json` in the image)
* `IS_IN_CONTAINER=true` (set in the image)
* Optional `DEV_GUILD_ID`
* Optional `bugsnagKey` in that config file
* Optional `OTEL_EXPORTER_OTLP_ENDPOINT` (and the other `OTEL_*` vars above)

## What the bot does so far

* `/ping` - replies with Pong and an **Again** button (proves component routing)
* `/status` - uptime, package version, and server count
* `/settings` - administrators view or set `modRole`, `adminRole`, and `systemNotice` per server

## Dependencies

Every package in `package.json` is imported. None were removed.

Held back (update would be brand-new or would force a risky rewrite):

* **Bun 1.4.3** (not 1.4.4) — same pin in `packageManager`, the `oven/bun` image, and `setup-bun`.
* **dotenv ^18.0.8** (not 18.0.9) — 18.0.9 was published less than 48 hours before the starter-bot review; the cooldown should keep it out of the lockfile.
* **chalk 4.1.2** — still CommonJS; chalk 5 is ESM-native. This project is ES modules (`"type": "module"`), so chalk 4 still `import`s.
* **K-Phoen/semver-release-action@master** — already a floating `master` pin on the release workflow.

`moment` is in maintenance mode but is used by the logger for timestamps; it is kept rather than rewritten to `Date`. `dotenv` is still called from `src/bot.js` (`config({ quiet: true })`) even though Bun also auto-loads `.env`. `@discordjs/rest`, `@opentelemetry/api`, `@opentelemetry/resources`, and `@opentelemetry/sdk-trace` are direct dependencies because the bot `import`s them. Tracing loads OpenTelemetry with a dynamic `import()` inside `startTracing()`.
