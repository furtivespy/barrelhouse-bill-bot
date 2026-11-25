## Intent

<!-- What this PR does, in one or two sentences. -->

## Why

<!-- Why this change is needed (problem, context, or user impact). -->

## Linear

<!-- e.g. FUR-123 -->

## Door

<!-- two-way (easy to revert) | one-way (data, contracts, security, releases) -->

## Cleanup

<!-- none | needed (FUR-123) | done. Does this PR leave something to remove later (a shim, an old code path, preserved old records)? If so, file a `Cleanup:` issue and link it here. See "Cleanup tickets" in AGENTS.md. -->

none

## Testing

<!-- Commands run and their results (`bun run verify`, `bun run control execute ...`), why any test expectation changed, and what you could not verify. -->

## System recap

<!-- Risk: low | medium | high. Touches: <primitive or area> (composes | extends | adds). Optional: 3-5 bullets of the change flow. -->

## QA Status

<!-- Maintained by QA Department (or workflow skip stamp for docs-only/non-runtime PRs): rewrite everything between the markers after every QA pass. A verdict is only valid while Head equals the PR's current head SHA. See docs/merge-policy.md. -->
<!-- qa-status:start -->
- **Verdict:** pending
- **Depth:** pending
- **Head:** -
- **Verified:** -
- **For you to test:** none
- **User call-out:** none
<!-- qa-status:end -->

## Checklist

- [ ] Tests added or updated for the behavior change (`bun run verify` passes)
- [ ] If slash commands/subcommands changed, updated `docs/feature-map/notes.md` and ran `bun run control map --write`
- [ ] PR has exactly one of: `major` | `minor` | `patch` (release tag workflow)
