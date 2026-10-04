# INRP2P Exchange — Production hardening register

Working register for the production task of 2026-10-04 (source `main` at `d0cc778`). Branch
`claude/production-hardening`. Every item states what was found, what changed, how it is proved and what is still
outside the repository. A result is recorded only with the command, SHA and environment that produced it;
`NOT RUN` and `BLOCKED` stay visible until a real run replaces them.

## Readiness, kept apart

| Gate | Meaning | Status |
|---|---|---|
| 1. Code ready | fixes implemented, regressions covered, required checks green on the final SHA | in progress |
| 2. Staging verified | production-like environment, real adapters, notifications, both directions, recovery, monitoring, operator procedures | **NOT RUN** — no staging environment or provider credentials exist in this workspace |
| 3. Production prepared | domains, secrets, custody, bank accounts, liquidity, staff access, monitoring, backups; external conditions closed by their owners | **BLOCKED** — owner/infrastructure inputs (§ External prerequisites) |

Fake-provider tests never close gate 2; CI never closes gate 3.

## Items

| ID | Pri | Kind | Title | Status |
|---|---|---|---|---|
| ADR-16 | P0 | owner decision | Counterparty-funded execution (`docs/adr/0016-…`) | recorded |
| A1 | P0 | confirmed defect | TRON receipt/history normalization | in progress |
| A2 | P0 | confirmed defect | History pagination and cursor safety | open |
| A3 | P0 | confirmed defect | Provider degradation, D-05 quorum, backfill (TD-06), real smoke (TD-07) | open |

(The table grows as stages are worked; each row has a section below.)

## ADR-16 — Counterparty-funded execution

- **Requirement.** Owner decision 2026-10-04: trades are executed entirely with trader (counterparty) liquidity and
  the client's own funds; the platform never advances its own USDT/INR.
- **Recorded.** `docs/adr/0016-counterparty-funded-execution.md` (before/after flows, journals, invariants FI-70…79,
  migration and mixed-version rollout), `docs/DECISIONS.md D-16`.
