# 0001: Changing data scope needs an explicit migration path

Status: accepted
Date: 2026-11-24

## Decision

Do not move data between scopes (for example guild-scoped settings or drop rows to bot-wide records) without a written migration path. Do not delete old records unless the user explicitly approves it.

Migrations:

- keep old records as backups unless deletion is explicitly approved;
- never silently overwrite or delete scoped records with defaults;
- are idempotent: re-running one yields the same final state;
- define duplicate precedence before coding;
- stay out of normal command and autocomplete paths, which read only the final storage location;
- are tested with multiple source records, duplicate keys, and retained old rows.

## Why

Settings (`settings.sqlite`) and drops/sign-ups (`drops.sqlite`) live in SQLite files on a single `/data` volume, and redeploying an older container image does not undo a schema or scope migration. Overwriting or dropping rows is the one mistake a code rollback cannot reverse.

## Revisit if

- backups are automated and a restore has been tested, so old rows no longer need to stay in the live database;
- data moves to a store with point-in-time recovery.
