# `/data` volume for Will's server

The container mounts a host directory at `/data`. That directory holds:

* `config.json` — Discord token, application id, and optional guild/user ids
* `settings.sqlite` — per-server `/settings` overrides (created at runtime)
* `drops.sqlite` — drop listings and sign-ups (created at runtime)

JSON cannot have comments. Required secrets use `REPLACE_ME_*` strings. Optional guild and user ids are empty strings (`""`) so an unedited copy registers commands globally and uses the Discord application owner. Do not put a placeholder in `devGuildId` — Discord will 400 and `/ping` will not register.

`drops.sqlite` is a relational store (not Enmap). It keeps `drops` (guild, channel, message, bottle name, optional tasting-note `description`, optional price / location / bottle limit / close time, status, creating mod) and `signups` (one row per user per drop, joined-at order, allocated/waitlist/removed, pickup `pending` / `picked_up` / `no_show`). Schema upgrades use `PRAGMA user_version`; do not recreate the file to add a column.

## Setup

1. Copy this sample to the host path you will mount (do **not** commit real secrets):

   ```
   cp data/config.json.example /path/to/bill-data/config.json
   ```

2. Fill in the marked fields:

   | Key | Sample value | What to put |
   | --- | --- | --- |
   | `token` | `REPLACE_ME_DISCORD_BOT_TOKEN` | Discord bot token (required) |
   | `clientId` | `REPLACE_ME_DISCORD_APPLICATION_ID` | Discord application id (required) |
   | `devGuildId` | `""` | **Will's Discord server (guild) id**, or leave `""` for global command registration |
   | `botOwnerId` | `""` | **Will's Discord user id**, or leave `""` to use the application owner |

3. No **channel** ids are required for `/ping`, `/status`, or `/settings`. Leave them out until a later feature needs a drop/announcement channel.

4. Run with that host path mounted at `/data` (see the root README). `BOT_CONFIG` defaults to `/data/config.json` in the image.
