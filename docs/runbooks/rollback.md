# Rollback

Status: written from the workflows, **not yet rehearsed**. Do one dry run before relying on it.

## How production gets a version

`release.yml` runs on every merged PR with a `patch`, `minor`, or `major` label. It tags the merge `vX.Y.Z`, builds the image once with `/app/GIT_SHA` baked in, and pushes `gitea.willsullivan.dev/furtivespy/barrelhouse-bill-bot:vX.Y.Z` and `:latest`.

## Roll back a bad release

Pick one.

**A. Revert (normal path).** Revert the PR on `main` through a normal PR with a `patch` label. The release workflow builds a new `vX.Y.Z` and `:latest` image. Use this when the bad change is understood.

**B. Re-point `latest` (fastest).** Retag the last good image as `latest`:

```sh
IMAGE=gitea.willsullivan.dev/furtivespy/barrelhouse-bill-bot
docker pull $IMAGE:vX.Y.Z      # last good tag
docker tag  $IMAGE:vX.Y.Z $IMAGE:latest
docker push $IMAGE:latest
```

Then pull and restart the container on the host (`docker compose pull && docker compose up -d`, or wait for the host's image poller). Follow up with option A so `main` matches what is running; otherwise the next merge ships the bad change again.

## Confirm it worked

This bot has no public HTTP `/health` endpoint yet. Confirm the running version on the host and in Discord:

```sh
docker exec barrelhouse-bill-bot cat /app/GIT_SHA
```

Then run `/ping` and `/status` in Discord to confirm the bot is connected and responding.

## What rollback does not undo

Data. A SQLite schema or scope migration in `settings.sqlite` or `drops.sqlite` is not reversed by running older code. Migrations preserve old records as backups ([ADR 0001](../adr/0001-data-scope-changes-need-migration.md)); restore from those or from a volume snapshot, not from the image.

## Not covered yet

Feature flags are not used. Automated backups and a tested restore are out of scope for now (rung 9 remains `unknown` in the autopilot audit).
