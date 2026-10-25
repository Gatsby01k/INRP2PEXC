# ADR 0022 — Network fees in USDT: deal addresses as GasFree accounts

Status: **Accepted** — owner, 2026-10-25 ("neither I nor the platform spends anything; participants fund the network in
USDT, without TRX"). Supersedes the TRX deposits of ADR 0017/0020 for new P2P deals; closes TD-32.

## 1. Context

Every USDT transfer out of a P2P escrow needs TRON energy. Until now it was bought by **burning TRX** that the deal's
trader had deposited in advance (ADR 0020's network deposit), and the platform burned its own TRX to sweep its fees and
to carry its own deals. The owner's constraints:

- **Neither the owner nor the platform pays for anyone's network, ever — not even as a float to be repaid.** The platform
  holds no TRX and prepays nothing.
- **No participant needs TRX.** A desk and a client deal in USDT only.
- Escrow, custody, ledger and settlement keep their invariants; nothing is hidden, subsidised or charged twice.

Renting energy from a provider (Netts, TronZap — the first draft of this ADR) is cheaper per transfer, but providers bill a
prepaid TRX balance (TronZap's accepts TRX only): someone has to fund it before the first transfer. With the platform
funding nothing, one mechanism fits: **GasFree**, TRON's own relayer (gasfree.io; used by TronLink and Tether's WDK), where
a transfer's network is paid **in USDT, out of the account it leaves**, and nobody prepays anything.

### 1.1 GasFree, as verified on mainnet (2026-10-25)

- A **GasFree account** is a contract address the `GasFreeController` (`TFFAMQLZybALaLb4uxHA9RBE7pxhUAjF3U`, an upgradable
  proxy) derives with CREATE2 from an owner address. USDT sent to it is controlled by the owner's key through TIP-712
  **`PermitTransfer`** signatures (token, service provider, owner, receiver, value, maxFee, deadline, version, nonce).
- A service provider submits a signed permit; the controller moves `value` to the receiver and its fee to the provider —
  two USDT transfers in one transaction, from the account's own USDT (seen on chain). The fee is **set on chain per
  token**: `tokenFees(USDT) = 1.5 USDT` per transfer and `activateFees(USDT) = 1.5 USDT` once, on the account's first
  transfer. The permit's `maxFee` bounds it: the controller refuses a fee above it (`ExceedMaxFee`).
- One permit per owner is pending at a time; its `nonce` is the controller's `nonces(owner)`; after `deadline` it can never
  execute (`ExpiredSignature`).
- The owner **cannot** move the USDT without a service provider today: the controller's direct `transfer` is switched off
  (`transferPermission = 0`; a simulated call reverts). GasFree's admin can upgrade the controller.

The address derivation and the permit digest are computed locally (`adapters/gasfree.ts`) and held by the tests to the
controller's own views on mainnet (`getGasFreeAddress`, `getMessageHashForTransfer`) — byte for byte.

| one desk deal | network | who pays | TRX needed |
|---|---|---|---|
| before: burned from the trader's deposit + the platform's sweep | ≈ 2.5 + 2.1 USDT, in TRX | trader + platform | trader and platform |
| **GasFree**: payout (with activation) + sweep | **4.5 USDT**, in USDT, from the deal | the deal | nobody |

## 2. Decision

### 2.1 Deal addresses are GasFree accounts
Under `network_fee_policy.resource_mode = GASFREE`, a new P2P deal's escrow address — the client's deposit address of a
sale, the desk's delivery address of a buy — is the GasFree account of a fresh HD key (`m/44'/195'/0'/0/{i}`, the same
index sequence as before). `deposit_address.address` is the GasFree account (what the client is shown and the scanner
watches); `deposit_address.owner_address` is the key's own address (what signs). The web app derives both from the
account's public key, as before; nothing is asked of GasFree to issue an address.

The mode decides only what new deals are priced and issued on; what an address is decides how it is spent. An address
issued as a plain HD address keeps burning TRX (ADR 0017) until it is empty; a GasFree account only ever sends by permit.
Trader reserve addresses are unchanged (TD-41).

### 2.2 What a deal carries: its network in USDT, exactly (FI-100)
GasFree's fee is a fixed amount set on chain, read by the worker every ten minutes (`gasfree_fee_reading`). A quote
carries the network of the deal's own path at the fees in force — **activation + payout transfer + sweep transfer**
(4.5 USDT today) — as `network_fee_base_minor`:

- a **desk's deal** in the desk's own USDT side, beside its fee (`route_base = base ± fee ± network`, IX125); the client's
  amounts never change;
- **INRP2P's own deal** out of its margin (the client's price already pays it).

The allowance sits in the escrow with the deal's USDT. It is never prepaid, never pooled and never anyone else's.

### 2.3 Every transfer pays its own network, from the address it leaves (FI-101)
Each send from a GasFree account carries a fixed USDT cap — activation + one transfer at the quote's fees — which is its
permit's `maxFee`. What the controller charges, on chain in the same transaction, is the send's network: never above it.

- **Payout** (to the desk on a sale, to the client on a buy) and **sweep** of INRP2P's fee: paid by the deal's allowance.
- **Return of a desk's escrow** (a buy cancelled): the escrow goes back less that return's network — the desk funded it.
- **Refund of a client's USDT** (a sale cancelled after the deposit, or USDT sent in excess): the refund goes back less its
  own network (activation + one transfer, 3 USDT today), stated in the deal's terms before the client sends anything.
  Who was at fault is settled by the existing means (disputes, the desk's Security Reserve), never by anyone prepaying a
  network.
- **A fee that rose after the quote** stops the send at its cap (the controller refuses the permit); a person may raise
  the cap, and the difference comes out of what the address holds beyond the payee's amount — INRP2P's fee on a payout or
  sweep, the refunded USDT on a refund — booked as such. **A fee that fell** leaves the difference in the escrow, swept
  with INRP2P's fee and booked as unused allowance. Both are visible lines, never netted away.

### 2.4 Permits: signed once, proved dead before another (FI-102)
A permit is committed (`gasfree_permit`: nonce, deadline, cap, digest, signature) **before** it is submitted; only then is
it sent to GasFree, and a retry sends the same permit. A second permit for the same send is signed only once the first is
provably dead: its deadline is behind the solidified head of every configured TRON provider **and** the controller's
solidified `nonces(owner)` still equals its nonce (it never executed). A permit whose nonce was consumed is followed to
its transaction; one the chain cannot place opens a case for a person (`gasfree_permit.resolve`). The database refuses a
second live permit for a send or an owner, a cap above the send's (IX131), and any change to a decided permit (IX132).

A send is settled only from the chain: the transaction GasFree names is read like any transfer (FI-24) — the USDT to the
payee by its own log, the network by the controller's transfer to the provider in the same transaction.

### 2.5 Books (FI-103)
- Escrow out: the payee's amount as before; the network as `EXPENSE:NETWORK_FEES_USDT` out of the escrow's wallet, at the
  permit's confirmation (posting key `gasfree:{permit}:fee`).
- The deal's allowance is a liability from completion (`LIAB:NETWORK_ALLOWANCE`), released into
  `REVENUE:NETWORK_RECOVERED` for what its transfers cost and `REVENUE:NETWORK_UNUSED` for what they did not
  (`network:{trade}:settle`). On a desk's deal cost and recovery net to zero; nothing is netted silently.

### 2.6 The switch (FI-104)
Migration 0041 adds all of this and leaves `BURN`: production keeps working as at 40 and nothing has to be configured for
the release. A person switches to `GASFREE` on the Network page; the setter refuses until the worker has read GasFree's
fees from the controller within the hour (which needs the worker's GasFree credentials). `BURN` is never refused; deals
already priced keep their terms and addresses.

### 2.7 Fewer transactions
Before: TRX top-up (activating the address), USDT transfer, TRX top-up for the sweep, sweep, TRX reclaim — five. Now: the
payout and the sweep — two, one permit each. No TRX ever reaches a deal address.

## 3. Consequences
- Nobody prepays: no TRX deposit for desks, no float for the platform. A desk's deal costs 4.5 USDT of network today
  (0.045% of 10,000 USDT), in USDT, at cost.
- **Custody trust (accepted by the owner).** While a deal is open its USDT sits in a GasFree account: it moves only through
  a GasFree service provider (owner-direct transfers are off) and GasFree's admin can upgrade the controller. Exposure is
  the USDT of open deals, for as long as they are open. If GasFree stops answering, deals wait; nothing can be sent
  elsewhere — a permit pays only the receiver it names, and only once.
- The provider is never trusted with what happened: addresses and digests are computed locally, outcomes read on chain.
- Error codes IX131–IX134 (0041); domain errors GASFREE_UNAVAILABLE, GASFREE_MISMATCH. Implementation: adapters
  `gasfree.ts` (`GasFreeApi`) and `testing/fake-gasfree.ts`, signer `signPermit`, onchain `gasfree.ts`, worker
  `gasfree_fee_refresh`. Secrets `GASFREE_API_KEY`, `GASFREE_API_SECRET` (developer.gasfree.io); `GASFREE_NETWORK`.
- Rejected: rented energy (needs a prepaid float); the network credit of the first draft (nothing is held for a refund any
  more); GasFree for trader reserves for now (TD-41).
