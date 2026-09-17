# INRP2P Exchange

**USDT ↔ INR OTC Exchange for India.**

A new product built from zero: clients request or receive a firm rate, accept it, fund their leg and track settlement; the exchange desk runs rates, quotes, trades, INR payout capacity, USDT treasury, settlement legs and margin from one system — replacing Telegram + calculator + spreadsheets + blockchain explorer + bank apps.

## Status
**Phase 0 accepted** (tag `phase-0-accepted`). **Phase 1 — Foundation** implemented, awaiting review: see [`docs/PHASE_1_REPORT.md`](docs/PHASE_1_REPORT.md) and [`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md).

## Development

```bash
pnpm install --frozen-lockfile
pnpm run lint && pnpm run typecheck && pnpm run test:unit
pnpm --filter @inrp2p/web build
pnpm run test:integration   # Testcontainers postgres:18.6 (or TEST_DATABASE_URL)
```

## Documents
| Document | Contents |
|---|---|
| [PRODUCT](docs/PRODUCT.md) | Scope, users, surfaces, price concepts, non-negotiables |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Modular monolith, stack, modules, command pipeline, jobs, adapters |
| [DOMAIN_MODEL](docs/DOMAIN_MODEL.md) | ERD, entities, exception types |
| [STATE_MACHINES](docs/STATE_MACHINES.md) | Request, Quote, Trade, SettlementLeg, CryptoTransfer, Reservation, Exception, Adjustment, RouteObligation, RouteSettlement, DepositAddress, AcceptanceChallenge |
| [FINANCIAL_INVARIANTS](docs/FINANCIAL_INVARIANTS.md) | Precision, rounding, formulas, invariants + enforcement, ledger posting rules, P&L |
| [SECURITY](docs/SECURITY.md) | Threat model, auth, RBAC matrix, data protection, audit |
| [UX_FLOWS](docs/UX_FLOWS.md) | Tokens, navigation, flows, component inventory, wireframes, responsive rules |
| [IMPLEMENTATION_PLAN](docs/IMPLEMENTATION_PLAN.md) | Phases with exit criteria, plan challenge, launch checklist |
| [DECISIONS](docs/DECISIONS.md) | Resolved decisions, defaults and gates |

Sources of truth: [`docs/source/MASTER_PROMPT.md`](docs/source/MASTER_PROMPT.md) (business/financial) and [`docs/source/DESIGN_SYSTEM_BRIEF.md`](docs/source/DESIGN_SYSTEM_BRIEF.md) (visual/interaction). Brand mark: [`brand/inrp2p-mark.png`](brand/inrp2p-mark.png) — used as supplied, never redrawn.
