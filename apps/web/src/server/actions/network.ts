'use server';

import { revalidatePath } from 'next/cache';
import { DomainError } from '@inrp2p/kernel';
import { authorizeOperator } from '@inrp2p/identity';
import type { TrxTransferFacts } from '@inrp2p/adapters';
import { approveChainSend, decideNetworkWithdrawal, publishTrxRate, recordNetworkDeposit, setNetworkFeePolicy } from '@inrp2p/network';
import { approveRefundSend, cancelChainSend, raiseChainSendCap, unblockChainSend } from '@inrp2p/settlement';
import { recordCustodyHdAccount } from '@inrp2p/treasury';
import { HdWalletCustodyAdapter } from '@inrp2p/adapters';
import { custodyForWeb } from '../quotes.ts';
import { sendNetworkForWeb } from '../chain.ts';
import { type CommandResult, failure, runCommand } from '../command.ts';
import { operatorContext } from '../operator.ts';

/**
 * The desk's actions on the exchange's own rails (ADR 0017). Each one is a domain command that authorizes itself; the
 * chain is read here only for what someone hands in by hash, before the command, and the command decides from it.
 */
const done = <R>(out: CommandResult<R>, ...paths: string[]): CommandResult<R> => {
  if (out.ok) for (const p of paths.length ? paths : ['/network']) revalidatePath(p);
  return out;
};

export async function publishTrxRateAction(input: { usdtPerTrx: string; source: string; confirmLargeChange?: boolean }, key: string) {
  return done(await runCommand((ctx) => publishTrxRate(ctx.actor), input, { name: 'network.publish_trx_rate', idempotencyKey: key, financial: false }));
}

/** A TRX transfer into the budget wallet, read from the providers, credited to the trader whose wallet sent it — or to the platform, said explicitly. */
export async function recordNetworkDepositAction(input: { txHash: string; platform?: boolean; note?: string }, key: string) {
  let facts: TrxTransferFacts;
  try {
    const ctx = await operatorContext();
    await authorizeOperator(ctx.db, ctx.actor, 'network:manage');
    const read = await sendNetworkForWeb().trxTransfer(input.txHash.trim().toLowerCase().replace(/^0x/, ''));
    if (read.status !== 'FINAL') throw new DomainError('NETWORK_DEPOSIT_NOT_FOUND', read.status === 'NOT_A_TRX_TRANSFER' ? read.reason : 'the chain has not made this transaction final yet');
    facts = read.transfer;
  } catch (e) {
    return failure(e);
  }
  return done(await runCommand((ctx) => recordNetworkDeposit(ctx.actor, facts), input, { name: 'network_deposit.record', idempotencyKey: key }));
}

export async function approveChainSendAction(input: { sendId: string }, key: string) {
  return done(await runCommand((ctx) => approveChainSend(ctx.actor), input, { name: 'chain_send.approve', idempotencyKey: key }), '/network', '/', '/trades');
}

export async function cancelChainSendAction(input: { sendId: string; reason: string }, key: string) {
  return done(await runCommand((ctx) => cancelChainSend(ctx.actor), input, { name: 'chain_send.cancel', idempotencyKey: key }), '/network', '/');
}

export async function unblockChainSendAction(input: { sendId: string; reason: string }, key: string) {
  return done(await runCommand((ctx) => unblockChainSend(ctx.actor), input, { name: 'chain_send.unblock', idempotencyKey: key }));
}

/** A person lets one USDT transfer draw more TRX than was fixed for it, with the reason (the trade's hold rises if it must). */
export async function raiseChainSendCapAction(input: { sendId: string; cap: string; reason: string }, key: string) {
  return done(await runCommand((ctx) => raiseChainSendCap(ctx.actor), input, { name: 'chain_send.raise_network_cap', idempotencyKey: key }), '/network', '/');
}

export async function decideNetworkWithdrawalAction(input: { withdrawalId: string; approve: boolean; reason?: string }, key: string) {
  return done(await runCommand((ctx) => decideNetworkWithdrawal(ctx.actor), input, { name: 'network_withdrawal.decide', idempotencyKey: key }));
}

export async function setNetworkFeePolicyAction(input: { autoSendEnabled?: boolean; minNetMargin?: string; quoteEnergy?: number; reserveEnergy?: number; priceBufferBps?: number; topupBufferBps?: number; reason: string }, key: string) {
  return done(await runCommand((ctx) => setNetworkFeePolicy(ctx.actor), input, { name: 'settings.network_fees', idempotencyKey: key, financial: false }));
}

/** The second person a USDT refund needs: approving it sends it from the deal address (the signer makes the transfer). */
export async function approveRefundSendAction(input: { legId: string; bearer: 'TRADER' | 'PLATFORM'; toWalletId?: string | null; reason: string }, key: string) {
  return done(await runCommand((ctx) => approveRefundSend(ctx.actor), input, { name: 'refund_leg.approve_send', idempotencyKey: key }), '/network', '/');
}

/**
 * Registers the exchange's own HD wallet once (`custody:configure` ⧗): the account key the web app derives deal
 * addresses from (its own `INRP2P_CUSTODY_XPUB`, never typed), the budget wallet and the pool's record address that
 * `scripts/custody-seed.ts` printed. The worker refuses to sign with a seed that is not this wallet's.
 */
export async function recordCustodyHdAccountAction(input: { feeWalletAddress: string; depositPoolAddress: string; notes?: string | null }, key: string) {
  let adapter: HdWalletCustodyAdapter;
  try {
    const custody = custodyForWeb();
    if (!(custody instanceof HdWalletCustodyAdapter)) throw new DomainError('CUSTODY_MISCONFIGURED', 'the web app is not configured with an HD account: set INRP2P_CUSTODY_CAPABILITY=DERIVED and INRP2P_CUSTODY_XPUB, then redeploy');
    adapter = custody;
  } catch (e) {
    return failure(e);
  }
  return done(
    await runCommand((ctx) => recordCustodyHdAccount(ctx.actor, adapter), { accountXpub: adapter.account.xpub, ...input }, { name: 'custody.record_hd_account', idempotencyKey: key }),
    '/network', '/usdt',
  );
}
