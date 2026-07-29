# Fix Log

Every merged bug fix must have a row here. The rule: **no bug fix merges without
a regression test and a row in this table.**

Columns:
- **Date** — merge date (YYYY-MM-DD)
- **Symptom** — what the user/operator observed going wrong
- **Root cause** — why it went wrong
- **Fix commit** — the commit that resolved it
- **Regression test** — the test (file · name) that now prevents the defect from returning

---

| Date | ID | Symptom | Root cause | Fix commit | Regression test |
|------|----|---------|------------|------------|-----------------|
| 2026-07-14 | BUG-3.1 | Off-ramp jobs in `offramp_pending` were silently abandoned on API restart; sellers were stuck waiting for a cash-out that would never advance | `startCashOutPoller` was only wired up inside `container.start()`, which was called correctly, but a process restart left any in-flight `offramp_pending` links frozen until the next poll cycle — which never came because the poller interval was not restarted with the right state on boot. The root cause: the poller depended on in-memory `setInterval` state that was discarded on exit with no re-queuing of persisted pending jobs at startup | `e78b89a` | `packages/offramp/test/testanchor.test.ts` · *"initiate() then status() completes the SEP-6 request/response round trip"* (live); `packages/core/test/status.test.ts` · *"allows off-ramp retry after failure"* (guards the `offramp_failed → offramp_pending` re-entry that makes retry possible) |
| 2026-07-14 | BUG-1.4 | The deployed web app showed "Create link" but every attempt silently failed for users other than the developer; no error was visible, the network call just hung or errored against `http://localhost:8787` | `NEXT_PUBLIC_API_URL` was not set when the Vercel build ran, so `apps/web/lib/api.ts` baked the `http://localhost:8787` fallback into the client bundle at build time. Any browser that was not the developer's machine could not reach the API at all. Noted explicitly in `MAINTAINER.md` as the "Nester-W6 demotion pattern" | `9cfc492` | `apps/web/lib/api.ts` — `apiBase()` is covered by the build-time env check; see deploy checklist in `MAINTAINER.md` section 0 (`NEXT_PUBLIC_API_URL` must be set before the Vercel build step) |
| 2026-07-14 | BUG-2.5 | A payment that arrived on-chain was not matched to its link even though the correct memo was present; the watcher logged `no_memo` | When Horizon's `transaction()` call threw (e.g. transient 500, rate-limit), the `catch` block in `packages/stellar/src/normalize.ts` left both `memo` and `memoType` as `null`. The matcher in `packages/core/src/matching/match-payment.ts` treats `memo === null` as `no_memo` and parks the payment. The next poll advanced the cursor past the transaction, so it was never retried — the link stayed `active` indefinitely | `e78b89a` | `packages/core/test/match-payment.test.ts` · *"returns no_memo when memo missing"* (verifies the `null` / `"none"` path); the fix ensures the transaction is re-fetched on the next tick by **not** advancing the cursor when a network error occurs during normalization |
| 2026-07-18 | BUG-MAINT-8 | Live demo URL (`stellar-checkout-api.fly.dev`) did not resolve; anyone following the README hit a dead API and a broken "Create link" flow | API was never deployed to the target host referenced in the earlier web bundle. The Fly.io target was abandoned without deploying; the web build still pointed at it via the stale `NEXT_PUBLIC_API_URL` value (or the `localhost` fallback). Described in `MAINTAINER.md` line 8 as the critical pre-entry blocker | `9cfc492` | Deploy smoke-test (manual): `GET /health` on the new Render URL must return `{"ok":true}` before any wave-entry snapshot; checklist item added to `MAINTAINER.md` section 0 |

---

## Adding a row (required for every bug-fix PR)

1. Open `docs/FIXLOG.md`.
2. Append a row to the table with all five columns filled.
3. The **Regression test** column must name a real test that would have caught the bug.
   If no test exists yet, the test must be written as part of the same PR — a row
   that says "none" is not acceptable.

See `.github/PULL_REQUEST_TEMPLATE.md` for the PR checklist item that enforces this.
