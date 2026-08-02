# Contributing to Stellar Checkout

Thanks for your interest in contributing! Stellar Checkout is an open-source, non-custodial merchant checkout for the Stellar anchor network — the inbound counterpart to the Stellar Disbursement Platform. Please read this guide before opening a pull request.

---

## Code of Conduct

By participating you agree to uphold our [Code of Conduct](./CODE_OF_CONDUCT.md).

---

## First PR Walkthrough

Welcome! If you are looking for your first contribution:

1. **Find a starter issue**: browse the [`good-first-issue`](https://github.com/determined-001/Quay/issues?q=is%3Aissue+is%3Aopen+label%3Agood-first-issue) label. The newcomer-gated set is backlog items 1.6, 5.5, 7.4, 7.6, 8.5 and 8.7 — property-based money tests, SEP-7 builder tests, the FIXLOG regression index, README repositioning, dependency/secret scanning in CI, and uptime monitoring.
2. **Comment on the Issue**: Express interest so maintainers can assign it to you.
3. **Fork & Branch**: Fork the repo and create a descriptive branch from `main`:
   ```bash
   git checkout -b feature/issue-8.7-qr-copy-toast
   ```
4. **Make Granular Commits**: Write clean code and make regular, logical commits using conventional prefixes (`feat:`, `fix:`, `docs:`, `test:`). **Do not squash your commits** into a single blob — commit history and velocity are legible and valuable to reviewers (`MAINTAINER.md:120`).
5. **Verify Locally**: Run the local check suite (see below).
6. **Submit PR**: Open your Pull Request referencing the issue ID (e.g. `Closes #8.7`). Assigned maintainers will review within our **48-hour Review SLA**.

---

## Issue Label Taxonomy & Triage SLA

All issues carry labels from three required categories:
- **`area:*`**: `area:core`, `area:stellar`, `area:offramp`, `area:api`, `area:web`, `area:auth`, `area:distribution`, `area:ops`
- **`type:*`**: `type:bug`, `type:feature`, `type:docs`, `type:test`, `type:refactor`, `type:perf`, `type:security`, `type:dx`, `type:ops`
- **`complexity:*`**: `complexity:trivial` (100 points), `complexity:medium` (150), `complexity:high` (200)

The full set lives in [`.github/labels.yml`](.github/labels.yml) and is created
by `.github/create-issues.js` — that script is the authoritative source.

### SLAs & Codeowners
- **Triage Cadence**: Every new issue is triaged and labeled within **48 hours** (see [TRIAGE.md](docs/TRIAGE.md)).
- **Review SLA**: Assigned [.github/CODEOWNERS](.github/CODEOWNERS) provide initial PR feedback within **48 hours** (business days).
- **Stale Policy**: Issues inactive for 14 days receive a warning; closed after 30 days of inactivity.

---

## Project Layout

```
packages/
  core/      Domain brain — entities, status machine, money math, SEP-7 builder,
             the pure payment matcher, port interfaces, zod schemas.
  stellar/   Stellar adapter — SEP-7 rail + Horizon polling watcher.
  offramp/   Off-ramp adapter — MockAnchorOffRamp & TestAnchorOffRamp (seller_initiated).
apps/
  api/       Hono API + Drizzle (libSQL) + the ledger-watching worker.
  web/       Next.js seller dashboard + buyer checkout page + widget.js.
```

The domain (`packages/core`) never imports a chain SDK. New chain or anchor
behaviour belongs behind a port (`RailPort`, `WatcherPort`, `OffRampPort`), not
in the domain. Keep that boundary intact — CI enforces it (see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)), so a violation fails the build.

## Prerequisites

- Node 20+
- pnpm 9 (`packageManager` is pinned in `package.json`)

---

## Setup

```bash
pnpm install
cp .env.example .env
```

---

## Local Development

```bash
# API + ledger watcher  →  http://localhost:8787
pnpm --filter @checkout/api dev

# Web dashboard + checkout  →  http://localhost:3000
pnpm --filter @checkout/web dev
```

---

## Before You Open a PR

Run the full check suite from the repo root — this is exactly what CI runs:

```bash
pnpm typecheck                    # all packages
pnpm test                         # unit tests
pnpm build                        # builds the web app
pnpm docs:check-status-diagram    # docs/generated/status-diagram.mmd matches status.ts
pnpm docs:check-domain-boundary   # packages/core imports no chain SDK
```

All five must pass. If you change domain logic in `packages/core`, add or update
the corresponding unit tests (`packages/core/test/`). New behaviour in the API,
worker, or adapters should come with tests where practical. If you change
`LINK_STATUSES`/`TRANSITIONS` in `packages/core/src/domain/status.ts`, run
`pnpm docs:status-diagram` and update the pasted copy in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) to match.

---

## Pull Request Guidelines

- Branch from `main`; keep PRs focused on a single concern.
- Write a clear description of **what** changed and **why**. Link any related issue.
- **Do not squash commits**: Maintainers and contributors preserve granular commit history on merge. Commit velocity and history demonstrate development progression.
- Match the surrounding code style — comments explain intent, money is compared in integer stroops (never floats), and illegal status transitions must stay rejected.
- Do not flip the off-ramp from `seller_initiated` to `inline`. That mode has legal (money-transmission / custody) implications and is out of scope for a PR.

---

## Commit Messages

Use short, conventional-style prefixes where they fit (`feat:`, `fix:`, `docs:`, `chore:`, `test:`). Keep the subject line under ~72 characters.

---

## Reporting Security Issues

Do **not** open a public issue for security vulnerabilities. See [SECURITY.md](./SECURITY.md) for responsible disclosure.
