# ADR 0024 — Traders go live without a person in the loop, inside limits their own reserve sets

Status: **Accepted** — owner request of 2026-10-30: review onboarding, approvals, settlement details, the Security
Reserve, limits and risk end to end; simplify and automate whatever can be automated safely, to the level of the best
fintech and OTC platforms, with no bank partner and no paid API. Builds on ADR 0019 (P2P escrow), ADR 0020 (desks) and
ADR 0022 (GasFree). Migration `0044`, schema 44, error code IX138, FI-105–FI-107.

## 1. Context — what the review found

1. **Every trader waits for three decisions by a person** — verify the bank account, verify the wallet, approve — each
   behind an authenticator code. What the person can check is only what is on the screen: who holds an Indian account
   cannot be learnt without a bank (TD-33), and an address says nothing about who holds its key. The work grows with
   every trader and adds little a rule cannot.
2. **The wallet can be proven for nothing, and already is — unused.** A reserve deposit is credited only when it comes
   from the trader's registered wallet (IX102). USDT sent from an address proves its key is held; no person reading an
   address ever can.
3. **Limits are hand-set and blind to collateral.** A trader with a 500 USDT reserve takes a 10,000 USDT deal unless
   someone remembered to set a ceiling; raising a good trader's limits is a task for the desk.
4. **The reserve is locked only up to the requirement,** whatever is open: a trader with large deals open could take the
   rest of its reserve out.
5. **Where an approved trader is paid could be changed with a session alone.** `trader.propose_settlement_change` asked
   for no fresh code: a stolen session proposes a new bank account or wallet, and the only defence was a person reading
   the queue. Swapping the payee is the classic account-takeover move; nobody else on the account was told.

## 2. Decision

### 2.1 Applications reviewed by rule (`trader_program.auto_review`)
Off until the desk switches it on (Traders → Programme); switching it on reviews every application already waiting. The
review (`autoReviewTraderInTx`, system step `trader.auto_review`) runs on every event that may change its facts — an
application or a resubmitted detail, USDT from the trader's wallet credited to its reserve, a detail a person verified —
under the trader lock, and is idempotent: a redelivered event changes nothing.

| Detail | Verified by rule when | Otherwise (left for a person, the flag recorded) |
|---|---|---|
| Wallet | a confirmed USDT transfer **from it** was credited to this trader (its reserve), and it is on no other client's file and was never rejected | `WALLET_NOT_PROVEN`, `WALLET_ON_FILE_ELSEWHERE`, `WALLET_REJECTED_BEFORE` |
| Bank account | its holder is the applicant (`matchNames`, `MATCH` either way round: every word of one name is the other's, two whole words in common), it is on no other client's file and was never rejected | `BANK_NAME_MISMATCH`, `BANK_ON_FILE_ELSEWHERE`, `BANK_REJECTED_BEFORE` |
| Approval | both verified, the wallet proven (asked of a verified wallet too: a client adds its own wallets by typing them), the programme's reserve funded, and the desk never rejected this applicant | `RESERVE_SHORT`, `NO_DEFAULT_RESERVE`, `REJECTED_BEFORE` |

Approval by rule is the desk's approval (`approveTraderInTx`, shared): the programme's reserve, no reward override, no
ceilings, the applicant's authority to commit, `trader.approved` — audited `via: AUTO_REVIEW`. For the applicant the
last step reads plainly: *send your reserve from your registered wallet; you are approved the moment it lands*. A detail
the rules leave behind waits for a person, who sees why; verifying it is then all the rules wait for. A person may
approve, reject or verify anything at any time, as before.

### 2.2 Limits from the trader's own reserve and record (`trader_program.risk_policy`)
On from this release; null switches it off. A trader deals within multiples of its **free reserve** (balance less
withdrawals and applications on their way), at its level:

| Level | Reached with | One deal up to | Open deals together up to |
|---|---|---|---|
| New | approval | 2× | 4× |
| Proven | 10 completed deals and 7 days since approval | 5× | 15× |
| Trusted | 50 completed deals and 30 days | 10× | 30× |

A deal the trader failed in the last 30 days — a dispute INRP2P decided against it, or a client's escrow unwound because
it did not pay — holds it at New. "Open" is every offer still live, every order held, and every started order whose
trade has not finished, in the trader's own USDT (`trader_order.base_minor`). The limits are enforced where a deal is
made: routing (`DEAL_ABOVE_LIMIT`, `OPEN_ABOVE_LIMIT`), the trader accepting an offer, and a desk's own deal. The desk's
ceilings still apply on top; the lower wins.

**The reserve backing open deals is locked** (`backingFor`): while the trader is engaged, the larger of the requirement
and what its open deals need at its level — the largest deal ÷ `dealX`, everything open ÷ `openX`, rounded up — cannot
be withdrawn. Deposit more and the limits grow at once; complete deals and they grow by level; no person raises a limit.

### 2.3 A change of where an approved trader is paid
- **A fresh code** (`authorizeClientAdmin`, step-up): the authenticator; while the application is still under review —
  nothing settles through it yet — a sign-in by email code in the last ten minutes.
- **A hold** (`settlement_change_hold_hours`, 24 by default): the registered details keep settling every order until it
  ends. **Every member is told at once**, in the inbox and by email (`TRADER_SETTLEMENT_CHANGE`), and **any
  administrator can stop it** without a code (`trader.cancel_settlement_change`): the person who did not make it must be
  able to stop it at once.
- After the hold, with auto-review on, the trader sweep applies it by the same rules as an application's details (the
  bank holder the trader's own name, on no other file, never rejected; the wallet on no other file, never rejected) —
  between orders only (`ORDERS_OPEN`), and leaving to a person whatever a rule does not settle. The desk may still decide
  it at any time.

### 2.4 IX138
Whoever approves a trader — a person or the rules — its registered bank account and wallet are verified, the wallet sends
and receives, and its Security Reserve is set (`inrp2p_guard_trader_approval`); `approved_at` records when.

## 3. What stays with a person
Anything a rule flags; an applicant the desk rejected; disputes; reserve applications and holds (two people, TD-21);
pausing, ceilings, the required reserve; reserve withdrawals (the reserve address holds no key in the application — §5).

## 4. Consequences
- A clean trader goes from application to approved with no person: apply → send the reserve from the wallet → approved
  on finality. The desk's queue holds only what needs judgement, each item with its reason.
- Exposure is bounded by collateral automatically, for every trader and every desk, and grows by itself with track record.
- Changing where a trader is paid now needs what changing any destination needs (D-08), plus a hold and a broadcast.
- Prod has nothing to backfill except `approved_at` (from the last review of approved and paused traders).

## 5. Not in this change — the next steps
- **Reserve withdrawals without an operator.** Today: the trader asks, a person sends from custody, records the hash,
  confirms. With the reserve held at GasFree accounts of the HD signer (TD-41), a withdrawal within `available` to the
  registered wallet could be sent by the signer like an escrow return, its fee in USDT. It moves the reserve from a watched
  wallet to the signer's custody: the owner's decision.
- **TD-28** (a reserve deposit from an unregistered wallet): returnable automatically once the reserve is signer-held.
- **A wallet proven by signature** (TronLink `signMessageV2`) as an alternative to a transfer.
- **The Exchange for a trader-only client** is still opened by the desk, while anyone else opens it themselves (D-17).
