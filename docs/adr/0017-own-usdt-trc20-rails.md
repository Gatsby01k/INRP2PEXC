# ADR 0017 — The exchange's own USDT TRC20 rails: per-deal HD addresses, a prefunded TRX budget, an exactly-once signer

Status: **Accepted** — owner task of 2026-10-12 ("make USDT TRC20 work end to end, with automatic per-deal addresses
and clear fees"). Builds on ADR 0016 (counterparty-funded execution) and changes none of it: every trade is still
funded by its client and its counterparty, and the platform advances no trading money. Migration `0037`, error codes
IX103–IX115 (and IX100 extended to the signer), schema version 37.

## 1. Context

Before this change a USDT payout was a person's job: an operator sent USDT from a custody provider's wallet and typed
the transaction hash back (`recordLegEvidence`). Deposit addresses came from a provider's pool imported by hand (D-02).
Nothing paid TRON's network fee: whoever sent the USDT paid it from their own TRX, outside the books. The owner asked
for three things at once:

1. the client sees, before accepting, exactly what it pays and receives, with the trader's reward, the platform's
   profit and the network cost inside the price — and an unprofitable trade is never accepted;
2. no platform money is advanced for fees: participants prefund them, a USDT fee does not buy TRX, and without real
   coverage a transfer is blocked; the fee budget is kept apart from trading money and the Security Reserve;
3. a real wallet behind `CustodyAdapter`: an address per deal, automatically; keys away from the web app, with backup
   and recovery; automatic, safe signing that never sends twice, keeps every existing check, and stays blocked when
   the outcome is unknown.

## 2. Decision

### 2.1 Price (FI-90)
A quote's **net margin** = gross margin − the trader's reward − the network fee of its transfer. The network fee is
the TRX one USDT transfer from a new deal address costs (activation 1.1 TRX + the top-up's bandwidth + `quote_energy`
× the chain's energy price + a bandwidth buffer, +10 % top-up buffer, +10 % price buffer), valued in INR at the
quote's own client rate and the published TRX price, rounded **up**. Both are inside the client rate — never added on
top — so the client pays and receives exactly the quoted amounts and the client screen says so. `quote.create`
refuses (`QUOTE_UNPROFITABLE`) a rate that leaves less than `min_net_margin`, and tells the dealer the break-even rate;
`quote_network_fee` freezes the fee, the TRX price, the snapshot, the funder and the reward — with the order and the
basis points it was counted at — with the quote (IX103: net = gross − reward − fee). The order starts with exactly that
reward, whatever the programme says by acceptance (IX113), so the price, the order, the ledger accrual and the desk's
profit are one figure. No quote is sent, and no trade accepted, while the chain's fees or the TRX price are
older than the policy allows (`NETWORK_FEES_UNKNOWN`).

### 2.2 Who pays the network: a prefunded TRX budget (FI-91)
TRX is not a trade currency, so it is not in the ledger: `network_budget_entry` is its own append-only book
(deposits, spends, withdrawals, adjustments) per **funder** — a trader's *network deposit*, or the platform budget
(`trader_id` null). It is never the Security Reserve, never trading money, never another funder's.

- A trader pays TRX into the **budget wallet** from its registered wallet; the sender attributes it (the D-17 rule,
  IX107), credited once per transaction, by the trader's claim or the desk's record.
- **Acceptance holds the worst case** of the trade's transfers from the funder: `reserve_energy` per transfer, two
  transfers for a SELL (pay the counterparty, or return the client's USDT), one for a BUY. Acceptance fails if the
  funder does not have it (`NETWORK_BUDGET_INSUFFICIENT`; IX108 re-checks at commit under the funder's advisory lock).
  Routing does not offer an order to a trader whose free TRX cannot cover it (`NETWORK_DEPOSIT_SHORT`).
- A transfer is fuelled by a **TRX top-up** from the budget wallet to the deal address, sized by the chain's own
  energy estimate; what the top-up and its fee burn is *spent* against the trade's hold.
- **Every USDT send has a fixed TRX cap** (FI-95): the network fee its quote priced, for a transfer the client's price
  pays for; one held transfer's cost, for a refund. The caps of a trade's sends fit in its hold, so a SELL's possible
  return keeps its share. Top-ups — retries and failed ones included — never draw past the cap: gas that rose or
  attempts that burned it block the send with a case. The funder's other TRX is never drawn automatically; a person
  with `network:manage` may raise one send's cap, with the reason, and the trade's hold rises with it if it must. A
  transfer the quote never priced (a second partial payout) is not planned until a person raises the trade's hold;
  the desk sees a `NETWORK_BUDGET_SHORT` case meanwhile.
- When the trade is over, the hold closes: the unspent rest is free again; what the funder spent for transfers it
  does not bear (the client's payout, priced in; a platform mistake) is **paid back in INR** at the trade's quoted TRX
  price and rate, rounded down, accrued with the trader's rewards (`network_fee:{trade}:reimburse`, Dr
  EXPENSE:NETWORK_FEES / Cr LIAB:TRADER_REWARD_PAYABLE) and paid like them — only out of realized margin (FI-82).
- A trader withdraws free TRX to its registered wallet (request, desk approval, signer send; the withdrawal's own fee
  is its).

Why a deposit and not "deduct the fee in USDT": USDT taken from the client buys no energy. The transfer needs TRX at
the sending address before it is signed, and that TRX must already exist somewhere; the participants put it there.

### 2.3 Addresses: the exchange's own HD wallet
BIP-39 (24 words) / BIP-32 / BIP-44 with TRON's coin type 195, through audited libraries (`@scure/bip39`,
`@scure/bip32`, `@noble/curves`, `@noble/hashes`): `m/44'/195'/0'/0/i` deal addresses, `i` from a database sequence that
never repeats (`custody_derivation_index_seq`); `m/44'/195'/1'/0/0` the budget wallet; `m/44'/195'/2'/0/0` the pool's
record address (receives nothing). The **web app holds only the account's extended public key**
(`INRP2P_CUSTODY_XPUB`): it issues an address per trade and can spend from none. The **seed lives only in the worker**,
envelope-sealed under a KMS key of its own (Decrypt only, only under the `custody-seed` context), opened once into
memory at start; the worker refuses to start with a seed that is not the recorded account's. Backup is the 24 words on
paper, twice; recovery is the same words in `scripts/custody-seed.ts recover` — or in any standard TRON wallet
(the paths are the standard ones). Golden vectors from TronWeb pin the derivation and the transaction encoding.

### 2.4 Sending exactly once
A transfer is a `chain_send` (one per payout leg, refund leg, route obligation, top-up, withdrawal). The signer builds
the TRON transaction locally (protobuf, TAPOS from a solidified block, a fee limit, a 10-minute expiration), signs it,
and **commits the attempt — txid and signed bytes — before broadcasting** it. From then on only the chain decides:

- broadcast is repeated with the *same* bytes (a duplicate is harmless);
- final success settles the leg, refund or route payment through the same code an operator's confirmation runs (one
  movement, one journal, FI-27), with every D-16 check: the payout's coverage by this trade's counterparty funds, DVP
  for a route payment, physical availability at the address, the two-person threshold (C1; the approver of a send
  counts as the second person);
- a new attempt is signed **only** after the old one is proven dead: failed on chain, or unknown to every provider
  with the solidified head past its expiration (+margin). One live attempt per send (unique index, IX104/IX105);
- anything else — providers that disagree, a provider down, a broadcast timeout — leaves the send `SENDING`; after
  30 minutes a `CHAIN_SEND_UNRESOLVED` case is opened. Nobody can cancel a send with a live attempt
  (`CHAIN_SEND_IN_FLIGHT`), and no manual evidence may be recorded for a signer's leg (IX111, IX112).
- A send short of TRX at the budget wallet is `BLOCKED` with a `NETWORK_BUDGET_SHORT` case until a person unblocks it.
- After the database changed underneath (a restore, a failover — FI-54) nothing is planned, approved, signed or
  broadcast, TRX as well as USDT, until a person has reconciled and a second has lifted the fence; a transaction signed
  before the change waits and is then broadcast as the same bytes (IX100 in the database, `PAYOUTS_HELD` in code).

USDT is paid **directly from the deal address** to its destination (client, counterparty, refund): no sweep, no
intermediate hop. The only extra transfer is the TRX top-up.

### 2.5 Refunds and cancellation
A SELL holds the return's TRX from acceptance, so a refund is always covered. A refund's fee is never the client's:
the approver (a second person, `refund:approve`) says who bears it — the trader whose side failed (its deposit, not
paid back) or the platform (paid back to the trader in INR, or from the platform budget on a desk route). Another
trade's money and the Security Reserve never pay a fee.

### 2.6 What each side sees
- **Client:** the price and the exact amount it receives ("nothing is deducted"), the network fee included in the
  rate, and its payout's transaction hash while it is on its way.
- **Trader:** its network deposit — free, held per open order, spent per order and by whom, paid back in INR —
  how to add TRX (address + QR) and withdraw.
- **Desk:** the Network page (funders' budgets, the budget wallet on chain vs the records, every send with its
  attempts, approvals, unblock/cancel, the fee policy and the signer switch, the TRX price, HD wallet registration);
  each trade's network block (fee in the price, actual cost, gross − reward − network) and refund "approve and
  send"; the quote builder's reward, network fee and net margin.

## 3. What the platform still pays, and why it cannot be zero

- **Trader-funded trades need no platform TRX at all.** The trader's deposit activates the budget wallet, pays every
  top-up and is paid back from the trade's own margin.
- **Desk routes** (an external provider, not a trader) have no participant who could prefund TRX: their trades hold
  the platform budget — 19.4 TRX for a BUY, 38.8 TRX for a SELL at an energy price of 100 sun. Without platform TRX no
  desk-route trade is accepted. Minimum: the largest number of desk-route trades open at once × 38.8 TRX.
- **Platform mistakes** are the platform's: their TRX comes from the trade's hold, and the INR paid back to the trader
  comes out of realized margin.
- **Infrastructure:** the worker (≈ $15–16/month, DEPLOYMENT §10), the custody KMS key ($1/month), TRON providers (a
  second, independent one is needed above the D-05 threshold).

## 4. Consequences
- A trade on the exchange's rails cannot be paid twice by the signer: a crash, a retry or a timeout leaves at most one
  live transaction per send, decided by the chain.
- Every quote is at least `min_net_margin` profitable after reward and network; small trades carry a fixed fee of
  roughly 18 TRX, so their spread must be wider (the builder shows by how much).
- The TRX price is published by a person (no oracle yet, TD-30); quotes stop after 72 hours without one.
- POOL custody (D-02) keeps working for addresses already issued; switching to DERIVED is configuration plus one
  registration, never a data migration.
