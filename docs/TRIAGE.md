# Issue & PR Triage Process

This document defines the issue triage process, labeling rules, response SLAs, and stale issue handling policy for maintainers of Stellar Checkout.

---

## Triage SLAs

| Event | SLA Target | Responsible Party |
| --- | --- | --- |
| **New Issue Triage & Labeling** | Within **48 hours** | Maintainers |
| **First PR Review Feedback** | Within **48 hours** (business days) | Assigned CODEOWNER |
| **Stale Warning Trigger** | **14 days** of inactivity | Automated bot / Maintainers |
| **Stale Issue Closure** | **30 days** of total inactivity | Automated bot / Maintainers |

---

## Required Labels on Every Open Issue

No issue should remain untriaged or unlabelled. Every open issue must be assigned labels from each of the three core categories:

1. **`area:*`** — Location in the codebase (`area:core`, `area:stellar`, `area:offramp`, `area:api`, `area:web`, `area:auth`, `area:distribution`, `area:ops`)
2. **`type:*`** — Intent of the issue (`type:bug`, `type:feature`, `type:docs`, `type:test`, `type:refactor`, `type:perf`, `type:security`, `type:dx`, `type:ops`)
3. **`complexity:*`** — Estimated effort (`complexity:trivial` = 100 points, `complexity:medium` = 150, `complexity:high` = 200)

The authoritative definitions live in `LABEL_DEFS` in `.github/create-issues.js`
and are mirrored in [`.github/labels.yml`](../.github/labels.yml). The `area:*`
major maps one-to-one onto the backlog numbering in `ISSUES.md`.

Optionally add:
- **`good-first-issue`**: Genuinely self-contained, well-scoped tasks suitable for newcomers.
- **`help-wanted`**: Issues where community contribution is actively invited.
- **`Stellar Wave`**: Opts the issue into the Drips Wave Program.

---

## Stale Issue Policy

To maintain a clean and actionable issue backlog:

1. **14-Day Warning**: Issues without activity for 14 consecutive days receive the `stale` label along with a comment asking if the issue remains relevant or needs assistance.
2. **30-Day Closure**: If no further response or commit activity occurs within **30 days** of initial inactivity, the issue is closed as stale. Reopening is always welcome if the context becomes relevant again.

---

## PR Review & Merge Policy

1. **No Squashing Policy**:
   - Maintainers must **never squash** PR commits into a single blob commit upon merging.
   - Commit velocity and granular history provide legibility for auditability and code review (`MAINTAINER.md:120`).
   - Use standard merge commits or rebase-merge to preserve granular commit histories.
2. **Verification Gate**:
   - Every PR must pass `pnpm typecheck`, `pnpm test`, and `pnpm build` in CI before merge.
   - Off-ramp mode must remain `seller_initiated` (no switching to `inline`).
