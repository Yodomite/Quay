## What

Describe what this PR changes.

## Why

The motivation / problem being solved. Link any related issue (e.g. `Closes #12`).

## How

Brief notes on the approach. If it touches a chain or anchor, confirm the change
stays behind a port and the domain (`packages/core`) imports no chain SDK.

## Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] `pnpm build` passes
- [ ] Added/updated tests for changed behaviour where practical
- [ ] Did not change the off-ramp from `seller_initiated` to `inline`
- [ ] Updated docs (README / API.md) if behaviour or endpoints changed

## Bug fix? (skip if not a bug fix)

- [ ] Added a regression test that would have caught this bug
- [ ] Added a row to `docs/FIXLOG.md` (date · symptom · root cause · fix commit · test name)
