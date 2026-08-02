# SCF Build proposal: Quay — non-custodial Stellar checkout

**Status note, read first:** Quay is **pre-production and currently testnet-only**.
The live demo referenced throughout this document runs against Stellar testnet
with a reference anchor sandbox, not a licensed anchor, and moves no real money.
As of this writing the deployed API has an active outage (see
["Current state," below](#3-current-state) for the specifics, sourced from this
repo's own live status page) — this document names that plainly rather than
paper over it, and fixing it is a condition of submission, not a footnote. Every
number in the "Traction" section is either a real, checkable fact from this
repo's own CI/status artifacts, or is explicitly labeled as not yet available.
Nothing here is a production revenue or user-count claim.

---

## 1. Problem

A Stellar-based merchant checkout has an easy 20% and a hard 80%. The easy part
— generate a payment request, watch the ledger, mark an invoice paid — is
commodity, and several open-source and hosted tools already do it well. The
hard part is the leg that makes any of that useful to a real merchant: getting
the money back out as local currency, reliably, through a real anchor, with the
FX risk, KYC, and reconciliation that implies. Most "Stellar checkout" projects
stop at the easy part and call the rest someone else's problem. Quay treats the
off-ramp as the actual product.

## 2. The wedge

Quay is **the inbound counterpart to the Stellar Disbursement Platform**. SDP
solves outbound: an organization holds funds and needs to pay many people in
local currency, reliably, at scale. Quay solves the inverse: a merchant needs
to *receive* value from many payers and turn it into local currency, reliably,
without ever holding custody of what arrives. Both problems only have a real
answer through the same piece of infrastructure — Stellar's anchor network
(SEP-6/SEP-24/SEP-38) — because that's the only place a stablecoin balance and
a bank rail meet under a compliance umbrella neither a wallet nor a DEX can
provide on its own. A DEX path payment looks like it could substitute for an
anchor here; it can't (see the liquidity data in the risk register below) — the
anchor is not a workaround, it's the only door.

Concretely, Quay is a non-custodial payment-link checkout: a seller creates a
link, a buyer pays USDC straight to the seller's own Stellar wallet (nothing is
custodied in between), a backend watcher confirms settlement on-chain, and the
seller separately triggers a seller-initiated cash-out through an anchor
adapter. The domain is built behind three ports (`RailPort`, `WatcherPort`,
`OffRampPort`) specifically so the anchor integration can go from a reference
sandbox to a production anchor relationship without touching the payment
domain or the settlement watcher — see
[`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) for the actual package graph.

## 3. Current state

- **Live demo:** [dashboard](https://quay-web.vercel.app) ·
  [API](https://quay-api.onrender.com/health). Cash-out runs a real
  SEP-10 → SEP-38 → SEP-6 flow against `testanchor.stellar.org` (the public
  Stellar testnet reference anchor sandbox) — not a licensed anchor, and no
  real money moves.
- **Known issue at time of writing:** [`docs/STATUS.md`](./STATUS.md) (regenerated
  every 5 minutes by this repo's own uptime workflow) currently shows the API
  and the synthetic create-link check both down, with 0% uptime over the
  visible window and `This operation was aborted` as the last error. The web
  dashboard itself is up. This is a real, current gap — a live URL with a
  broken core flow is explicitly treated as unacceptable in this project's own
  maintainer notes, and it will be fixed and re-verified against `docs/STATUS.md`
  before this proposal is actually submitted to SCF, not left for reviewers to
  discover.
- **Milestone structure** (this repo tracks work against six milestones on
  GitHub; issue/PR counts below are real, pulled directly from the repo at
  time of writing, not estimates):

  | Milestone | Question it answers | Open | Closed |
  |---|---|---|---|
  | M1 - Off-ramp depth | Can a seller actually get local currency, from a real anchor, reliably? | 10 | 0 |
  | M2 - Multi-tenant platform | Can someone who is not us run this without trusting us? | 8 | 1 |
  | M3 - Settlement correctness | Does every on-chain payment land in the right state, exactly once? | 5 | 1 |
  | M4 - Merchant surface | Can a merchant integrate in an afternoon? | 7 | 1 |
  | M5 - Distribution & grant | Can a stranger install it, and can a committee fund it? | 6 | 2 |
  | M6 - Ops & rigor | Do we know when it breaks, and can we prove it works? | 10 | 5 |

  M6 is the furthest along by design — a broken or unmonitored demo is worse
  than no demo, so operational rigor (CI typecheck/test/build, a domain-boundary
  lint that fails the build if the payment domain imports a chain SDK, a
  nightly anchor-health probe, 5-minute uptime/synthetic checks) was
  front-loaded rather than deferred to "later."
- **Architecture is ports-and-adapters on purpose:** the domain
  (`packages/core`) has zero dependency on `@stellar/stellar-sdk` or any chain
  I/O — enforced in CI, not just by convention — specifically so the anchor
  integration named in this proposal's budget (§5) is an adapter swap, not a
  rewrite.

## 4. Milestones

Dates below are relative to a grant start date, not fixed calendar dates —
this repo's own GitHub milestones (table above) currently carry no due dates,
and this proposal isn't going to invent false precision about a schedule
nobody has committed to yet. Each milestone maps directly onto the backlog
already tracked in this repo (linked issues, not new scope invented for this
document).

| Milestone | Target window | Acceptance criteria |
|---|---|---|
| **M3 - Settlement correctness** (close remaining) | Month 1 | Every open M3 issue closed; a seeded backlog of concurrent payments settles exactly once with no duplicate or dropped state transitions, verified by an automated test, not manual spot-checking. |
| **M1 - Off-ramp depth** | Months 1-3 | `OffRampPort` returns a discriminated union distinguishing SEP-6 (`fields`) from SEP-24 (`interactive`) initiation (roadmap item 1 in `MAINTAINER.md`); the off-ramp telemetry table (anchor, corridor, quoted rate, quoted-at, settled-at, effective rate, status) is live and passively populated by every off-ramp job — the mechanism the Traction section below depends on. |
| **M2 - Multi-tenant platform** | Months 2-4 | Wallet-native auth ships: a seller connects a Stellar wallet and signs a SEP-10-style challenge; that address is both identity and payout destination. `/links` and `/webhooks` are scoped per authenticated seller. The current single-hardcoded-demo-seller limitation (documented in the README today) is gone. |
| **M4 - Merchant surface** | Months 3-5 | An embeddable checkout widget (a single script tag opening the hosted checkout in a modal, keyed by link ID) ships and is documented, so integrating Quay doesn't require standing up the dashboard. |
| **LINK SEP-24 production adapter** (M1, continued) | Months 4-6 | `TestAnchorOffRamp`'s shape is forked against a real anchor's (targeting LINK / ngnc.online) production SEP-24 endpoints, using the interactive arm from milestone M1 above. This item explicitly depends on the anchor actually agreeing to onboard and pay out — approached with live telemetry and checkout volume in hand, not a cold ask (see §6, anchor-dependency risk). |
| **M5 - Distribution & grant** (remaining) + **M6 - Ops & rigor** (remaining) | Throughout, closing out by Month 6 | Every M5/M6 issue closed; the live demo has sustained uptime with no recurrence of the outage disclosed in §3; this document itself is superseded by a post-grant report with real settlement-latency and cash-out-volume numbers instead of "not yet available."

## 5. Budget

**Requesting $48,000 total.** This targets whichever current SCF Build tier
that amount maps to — SCF's own tier names/bands should be confirmed against
the live program guidelines at actual submission time rather than asserted
here as fixed facts about an external program this document doesn't control.
The breakdown below is a specific, justified allocation, not a lump sum, and
each line should be treated as an estimate to be firmed up with real
contractor/vendor quotes before funds are drawn — not a number invented to hit
a round total.

| Bucket | Amount | Justification |
|---|---|---|
| **Engineering** | $30,000 | The bulk of the milestone work in §4: the `OffRampPort` union, the telemetry table, wallet-native auth + multi-tenancy, and the embeddable widget. Budgeted as ~6 months of a single senior contractor at a part-time allocation (roughly 20 hrs/week) plus code review time — consistent with this project's actual current team size (see the commit history and `MAINTAINER.md`'s own "us"), not a hire this grant would need to go find from scratch. |
| **Anchor integration** | $8,000 | Specifically the LINK SEP-24 production adapter (§4) and the relationship work around it: adapter development against a real anchor's SEP endpoints, integration testing, and the operational cost of the back-and-forth an actual anchor onboarding process requires (this is explicitly *not* the same bucket as general engineering, because it's gated on a third party's timeline and process, not just development time). |
| **Security review** | $6,000 | A scoped external review of the custody boundary (does `seller_initiated` mode ever actually touch seller funds — it shouldn't, and an outside reviewer should confirm that, not just this team), the settlement idempotency guarantees (cursor + processed-tx ledger + domain transition guard — three layers deep specifically because a duplicate settlement is a real-money bug, not a cosmetic one), and secret handling (`DEFAULT_SELLER_SECRET`, anchor tokens, webhook signing secrets). Not a smart-contract audit - there is no on-chain contract in this architecture by design (see `docs/ARCHITECTURE.md`) - so this is scoped to the actual custody and settlement code, not padded to look like a bigger line item. |
| **Infrastructure & ops** | $4,000 | Hosting for the grant period: the API already runs on Render's Starter plan (a real, current cost of $7/mo - the free tier spins down after 15 minutes idle, which would silently kill the settlement watcher, so it's not an option regardless of budget), the web app on Vercel, Turso for the database (currently within its free tier's limits at this project's actual traffic - see `MAINTAINER.md`'s own capacity math), plus headroom for a paid tier if usage from this grant's milestones outgrows it, and the uptime/anchor-health monitoring already running in CI. |
| **Total** | **$48,000** | |

## 6. Traction

**Honest baseline: there is no production traction yet, and this section says
so rather than implying otherwise.** Quay has not processed a real payment for
a real merchant. The reasons this section exists at all, rather than being
omitted, are (a) SCF asks for it, and (b) the mechanism to answer it honestly
in the future is itself a funded deliverable (§4, M1: the telemetry table).

What's real today:
- A working, live (if currently interrupted - §3) testnet demo covering the
  full loop: link creation → SEP-7 payment → on-chain settlement detection →
  webhook → SEP-10/38/6 cash-out quote against a reference anchor.
- Real, automated operational proof, not a claim: this repo's CI enforces
  typecheck/test/build and a domain-boundary lint on every change; a nightly
  workflow probes the anchor integration against the live testnet sandbox; a
  5-minute synthetic check exercises the actual create-link flow end to end
  and publishes the result to `docs/STATUS.md` (the same file that surfaced
  the current outage disclosed in §3 - the fact that this document can cite a
  real, current failure is itself evidence the monitoring is real, not
  decorative).

What's explicitly **not yet available**, and won't be claimed as if it were:
- Links created, payments settled, or cash-outs completed by anyone other
  than this project's own testing. There is no live merchant using this today.
- Measured settlement latency or effective anchor spread. The telemetry table
  that would produce these numbers (issue 3.8, funded under M1 in §4) does not
  exist yet - once it ships, every off-ramp job passively writes
  `(anchor, corridor, quoted_rate, quoted_at, settled_at, effective_rate, status)`,
  and this document would be revised (or superseded by a follow-up report)
  with real numbers instead of this paragraph.

## 7. Risk register

| Risk | Detail | Mitigation |
|---|---|---|
| **Anchor dependency** | The only anchor integration that exists today is against `testanchor.stellar.org`, a public *reference sandbox*, not a production anchor with a real compliance and payout relationship. The entire off-ramp thesis depends on a real anchor (targeting LINK/ngnc.online) actually agreeing to onboard and pay out. | The `OffRampPort` seam exists specifically so this is an adapter swap, not a rewrite, once a relationship exists. §4/§5 budget the anchor-integration work as its own line, gated on the relationship, not assumed. The plan is to approach the anchor with real telemetry and checkout volume already in hand (once M1's telemetry ships), not a cold pitch. |
| **NGNC / DEX liquidity is not a viable substitute for anchor settlement** | An on-chain path-payment alternative (buyer pays USDC, seller receives NGNC directly, no anchor call) was evaluated and measured against live mainnet Horizon path-finding. Results (recorded in `MAINTAINER.md`'s decision log): a ₦10,000 path implied a rate ~40%+ worse than the real market rate; a ₦50,000 path was over 100% worse; a ₦500,000 path had **no route at all**. The NGNC/USDC orderbook is effectively empty (one thin ask, near-zero bids), and the relevant anchor's `stellar.toml` no longer even lists an NGN asset. | This finding is exactly why the architecture stayed anchor-first rather than chasing a DEX shortcut - the analysis is treated as evidence for the anchor-dependent design, not a problem to solve around. It's also the leverage described in the anchor-dependency mitigation above: this data becomes part of the case for why an anchor should want to market-make on this corridor. Path payments are explicitly parked, not abandoned, pending a real anchor relationship that would give a market-maker a reason to provide the depth that's missing today. |
| **Regulatory boundary on `inline` off-ramp mode** | The domain models two off-ramp modes: `seller_initiated` (current, live - the seller receives the stablecoin to a wallet they control and separately authorizes cash-out; custody never passes through Quay) and `inline` (value routed through the anchor mid-flight, seller receives local currency directly - not implemented, and deliberately so). `inline` is what merchants ultimately want, and it is also the mode that puts an operator in a money-transmission / custody posture. | `inline` stays unimplemented and is explicitly out of scope for any PR against this repo (see `CONTRIBUTING.md`) until a licensed anchor relationship and an actual compliance review exist. No grant milestone in §4 asks for `inline` mode. If a future milestone ever proposes it, it should come with its own legal review as a line item, not be smuggled in under general engineering. |
| **Single-maintainer/small-team bus factor** | The project's own maintainer notes (`MAINTAINER.md`) refer to the team as "us," singular-team language, not an organization with redundancy. | The engineering budget (§5) is sized to fund sustained contractor time specifically so milestone delivery doesn't depend on unpaid nights-and-weekends velocity. Architecture decisions (ports-and-adapters, enforced domain boundary, CI rigor) are also deliberately chosen to keep the codebase legible to a reviewer or a new contractor, not just to the original author. |

## 8. Use of funds and reporting

Funds are requested against the milestone table in §4, not released as a lump
sum up front. A progress update against real, checkable state (closed issues,
`docs/STATUS.md` uptime, and - once M1 ships - the telemetry table's actual
numbers) is a reasonable reporting cadence to propose to SCF; the exact
mechanics should follow whatever format SCF's Build track currently expects
at submission time.
