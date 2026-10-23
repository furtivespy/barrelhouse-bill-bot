# `/data` volume for Will's server

The container mounts a host directory at `/data`. That directory holds:

* `config.json` — Discord token, application id, and optional guild/user ids
* `settings.sqlite` — per-server `/settings` overrides (created at runtime)

## Setup

1. Copy this sample to the host path you will mount (do **not** commit real secrets):

   ```
   cp data/config.json.example /path/to/bill-data/config.json
   ```

2. Replace every `REPLACE_ME_*` placeholder. JSON cannot have comments; those strings are the markers.

   | Key | Placeholder | What to put |
   | --- | --- | --- |
   | `token` | `REPLACE_ME_DISCORD_BOT_TOKEN` | Discord bot token |
   | `clientId` | `REPLACE_ME_DISCORD_APPLICATION_ID` | Discord application id |
   | `devGuildId` | `REPLACE_ME_WILL_SERVER_GUILD_ID` | Will's Discord **server** (guild) id, or `""` for global command registration |
   | `botOwnerId` | `REPLACE_ME_WILL_DISCORD_USER_ID` | Will's Discord **user** id, or `""` to use the application owner |

3. No **channel** ids are required for `/ping`, `/status`, or `/settings`. Leave them out until a later feature needs a drop/announcement channel.

4. Run with that host path mounted at `/data` (see the root README). `BOT_CONFIG` defaults to `/data/config.json` in the image.
