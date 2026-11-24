# Merge policy

How a pull request gets from "agent opened it" to "merged and running".

## Gates

Required on `main` (ruleset `protect main`): `lint` and `test`
(`.github/workflows/test.yml`). Together they are `bun run verify`.

An agent may merge a PR (`ship-pr --merge`, see
`.agents/skills/ship-pr/SKILL.md`) only when **all** of these hold:

1. `lint` and `test` (and `docker-build`, when present) are green.
2. The PR's **QA Status** block says `Verdict: PASS` and its `Head` equals the
   PR's current head SHA. A new commit makes an old PASS stale.
3. `For you to test` is `none`.
4. The risk tier is **low** or **medium** (below).
5. The PR has exactly one release label: `patch`, `minor`, or `major`.
   `release.yml` reads it to pick the next version tag; with no label there is
   no tag, so the image is not built or deployed. `major` is high risk, so an
   agent never merges it.

The Cursor QA review is not a GitHub check, so GitHub cannot require it. The
`ship-pr` loop enforces rules 2, 3, and 5 instead.

## Risk tiers

**High: a human merges.** Any of:

- touches `src/db/`;
- touches permission or QA-unlock code (`src/config.permissionLevels.js`,
  `src/util/permissions.js`, `src/util/qaUnlock.js`);
- touches `Dockerfile`, `docker-compose.yml`, or anything under `.github/workflows/`;
- touches the rules that decide merging, so an agent cannot loosen its own gate:
  `.github/ship-pr.json`, `.agents/skills/ship-pr/`, `scripts/pr-risk.js`,
  `docs/merge-policy.md`, or anything under `docs/adr/`;
- changes a slash-command contract: a command or option name, an option type,
  default member permissions, or `permLevel`;
- carries the `major` label;
- `User call-out` is not `none` (users need it explained, for example release
  notes or a changed behavior);
- falls under [ADR 0003](adr/0003-agent-defaults-to-no.md) and the task did not
  explicitly ask for it.

The path rules above are checked in code: `gh pr diff <n> --name-only | node scripts/pr-risk.js`
prints `high` when any changed file is on the list. The other rules need judgement.
Anyone may *propose* a change to these files in a PR; the point is that a person,
not the ship loop, merges it.

**Medium:** new or changed user-facing behavior that is not high (`minor`
label, a new command or subcommand, changed command output or embed layout).

**Low:** everything else (`patch`: fixes, refactors, tests, docs, dependency
bumps that are not a major version).

## Container test builds

Merging to `main` builds the image once, in `release.yml`, and tags it
`vX.Y.Z` and `latest`.

To test a branch image before merge, add the `container-testing` label to the PR.
`build-push.yml` builds `pr-<number>` and the head short SHA on every push while
the label is on. It never touches `latest`.

## After merge

`release.yml` tags `vX.Y.Z`, builds the image with `/app/GIT_SHA` set to the
merge commit, and pushes `vX.Y.Z` and `latest` to
`gitea.willsullivan.dev/furtivespy/barrelhouse-bill-bot`. This bot does not
expose a public HTTP `/health` endpoint yet; verify the running container via
`/status` in Discord or `docker exec barrelhouse-bill-bot cat /app/GIT_SHA` on
the host. See [the rollback runbook](runbooks/rollback.md).
