# 0002: A PR does not add behavior beyond the approved design

Status: accepted
Date: 2026-11-24

## Decision

Do not add product behavior that the approved design (the Linear issue or design doc) does not describe. Get confirmation first.

Keep required storage migrations in their own PR, separate from optional UX or behavior changes.

## Why

The owner and QA review one cohesive change per PR. A storage migration bundled with optional behavior cannot be reviewed or rolled back cleanly on its own, and unrequested scope additions create product behavior nobody approved.

## Revisit if

- PRs are routinely small enough that QA review reliably separates and verifies bundled scope without a rule.
