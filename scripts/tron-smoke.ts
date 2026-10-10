/**
 * Phase 5 manual smoke gate (TECH_DEBT TD-07). Verifies the real TRON adapters against real providers:
 * connectivity, canonical parsing of the receipt (log address, topics, data), the account-history window read the
 * scanner relies on (history without block numbers → receipts → the right log, read to completion), identical
 * facts across two independent providers, finality handling, and the decision the real `QuorumChainVerifier`
 * returns for one known transaction.
 *
 * It is **not** part of CI. It needs credentials and a live network, so it runs from `pnpm smoke:tron` or the
 * manual `tron-smoke` GitHub workflow. Nothing here writes to a database or to the repository, and no credential
 * is ever printed: only provider names, groups and the facts of the transaction under test.
 *
 * Required settings (all as environment variables — never commit them):
 *   INRP2P_SMOKE_TRON_PRIMARY_URL      e.g. https://api.trongrid.io  (or a Nile/Shasta endpoint)
 *   INRP2P_SMOKE_TRON_PRIMARY_GROUP    independence group of the primary, e.g. `trongrid`
 *   INRP2P_SMOKE_TRON_SECONDARY_URL    a genuinely different operator — that is the point of the gate
 *   INRP2P_SMOKE_TRON_SECONDARY_GROUP  independence group of the secondary, e.g. `self-hosted`
 *   INRP2P_SMOKE_USDT_CONTRACT         TRC20 contract of the network under test
 *   INRP2P_SMOKE_TX_HASH               a known transfer of that contract
 *   INRP2P_SMOKE_EXPECT_FROM / _TO     expected sender and destination (TRON base58)
 *   INRP2P_SMOKE_EXPECT_AMOUNT         expected amount in decimal USDT, e.g. `12.500000`
 * Optional: INRP2P_SMOKE_NETWORK (TRON), INRP2P_SMOKE_LOG_INDEX (0),
 *   INRP2P_SMOKE_TRON_PRIMARY_NAME / _SECONDARY_NAME, INRP2P_SMOKE_TRON_PRIMARY_KEY / _SECONDARY_KEY (API keys),
 *   INRP2P_SMOKE_ENVIRONMENT (label for the report, e.g. `nile-testnet`), INRP2P_SMOKE_REPORT_FILE (writes the
 *   report as JSON: environment, time, expected facts, finality, agreement groups, every check — never a secret).
 */
import { writeFileSync } from 'node:fs';
import { Money, isTronAddress } from '@inrp2p/kernel';
import { QuorumChainVerifier, type Trc20Transfer, type TronProvider, TronHttpProvider, sameTransfer } from '@inrp2p/adapters';

export interface SmokeConfig {
  readonly network: 'TRON';
  /** A label for the report; never an endpoint or a key. */
  readonly environment: string;
  readonly tokenContract: string;
  readonly txHash: string;
  readonly logIndex: number;
  readonly expect: { readonly from: string; readonly to: string; readonly amountMinor: bigint };
  readonly primary: { readonly name: string; readonly group: string; readonly baseUrl: string; readonly apiKey?: string };
  readonly secondary: { readonly name: string; readonly group: string; readonly baseUrl: string; readonly apiKey?: string };
}

export interface SmokeCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Parses and validates the settings. Returns the problems instead of throwing, so the report lists them all. */
export function smokeConfigFromEnv(env: NodeJS.ProcessEnv): { config: SmokeConfig } | { problems: string[] } {
  const problems: string[] = [];
  const need = (key: string): string => {
    const value = (env[key] ?? '').trim();
    if (!value) problems.push(`${key} is required`);
    return value;
  };
  const address = (key: string): string => {
    const value = need(key);
    if (value && !isTronAddress(value)) problems.push(`${key} is not a TRON address`);
    return value;
  };
  const endpoint = (key: string): string => {
    const value = need(key);
    if (value) {
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') problems.push(`${key} must be an http(s) URL`);
      } catch {
        problems.push(`${key} is not a URL`);
      }
    }
    return value;
  };

  const network = (env.INRP2P_SMOKE_NETWORK ?? 'TRON').trim().toUpperCase();
  if (network !== 'TRON') problems.push(`INRP2P_SMOKE_NETWORK ${network} is not supported (TRON only)`);

  const tokenContract = address('INRP2P_SMOKE_USDT_CONTRACT');
  const txHash = need('INRP2P_SMOKE_TX_HASH').toLowerCase().replace(/^0x/, '');
  if (txHash && !/^[0-9a-f]{64}$/.test(txHash)) problems.push('INRP2P_SMOKE_TX_HASH must be 64 hex characters');
  const rawLogIndex = (env.INRP2P_SMOKE_LOG_INDEX ?? '0').trim();
  if (!/^[0-9]+$/.test(rawLogIndex)) problems.push('INRP2P_SMOKE_LOG_INDEX must be a non-negative integer');
  const from = address('INRP2P_SMOKE_EXPECT_FROM');
  const to = address('INRP2P_SMOKE_EXPECT_TO');
  const rawAmount = need('INRP2P_SMOKE_EXPECT_AMOUNT');
  let amountMinor = 0n;
  if (rawAmount) {
    try {
      amountMinor = Money.parse(rawAmount, 'USDT').minor;
    } catch {
      problems.push('INRP2P_SMOKE_EXPECT_AMOUNT must be a decimal USDT amount, e.g. 12.500000');
    }
  }

  const primaryUrl = endpoint('INRP2P_SMOKE_TRON_PRIMARY_URL');
  const primaryGroup = need('INRP2P_SMOKE_TRON_PRIMARY_GROUP');
  const secondaryUrl = endpoint('INRP2P_SMOKE_TRON_SECONDARY_URL');
  const secondaryGroup = need('INRP2P_SMOKE_TRON_SECONDARY_GROUP');
  if (primaryGroup && secondaryGroup && primaryGroup.toLowerCase() === secondaryGroup.toLowerCase()) {
    problems.push('the two providers declare the same independence group: this gate exists to prove two independent sources (D-05)');
  }

  if (problems.length) return { problems };
  return {
    config: {
      network: 'TRON',
      environment: (env.INRP2P_SMOKE_ENVIRONMENT ?? 'unlabelled').trim().slice(0, 60) || 'unlabelled',
      tokenContract,
      txHash,
      logIndex: Number.parseInt(rawLogIndex, 10),
      expect: { from, to, amountMinor },
      primary: {
        name: (env.INRP2P_SMOKE_TRON_PRIMARY_NAME ?? 'smoke-primary').trim(),
        group: primaryGroup,
        baseUrl: primaryUrl,
        ...(env.INRP2P_SMOKE_TRON_PRIMARY_KEY ? { apiKey: env.INRP2P_SMOKE_TRON_PRIMARY_KEY } : {}),
      },
      secondary: {
        name: (env.INRP2P_SMOKE_TRON_SECONDARY_NAME ?? 'smoke-secondary').trim(),
        group: secondaryGroup,
        baseUrl: secondaryUrl,
        ...(env.INRP2P_SMOKE_TRON_SECONDARY_KEY ? { apiKey: env.INRP2P_SMOKE_TRON_SECONDARY_KEY } : {}),
      },
    },
  };
}

const providerOf = (p: SmokeConfig['primary'], fetchImpl?: typeof fetch): TronProvider =>
  new TronHttpProvider({ name: p.name, independenceGroup: p.group, baseUrl: p.baseUrl, ...(p.apiKey ? { apiKey: p.apiKey } : {}), ...(fetchImpl ? { fetchImpl } : {}) });

export interface SmokeReport {
  readonly ok: boolean;
  readonly environment: string;
  readonly network: 'TRON';
  readonly ranAt: string;
  readonly transaction: { readonly txHash: string; readonly logIndex: number };
  readonly expected: { readonly contract: string; readonly from: string; readonly to: string; readonly amount: string };
  readonly providers: readonly { readonly name: string; readonly group: string }[];
  readonly finality: { readonly blockNumber: string | null; readonly solidifiedBlock: string | null };
  readonly agreement: { readonly agreedBy: readonly string[]; readonly agreedGroups: readonly string[] };
  readonly checks: readonly SmokeCheck[];
}

/**
 * Runs the gate. Every step is reported, including the ones that passed, so a failure has context. `fetchImpl` is
 * for the dry run against a fake node only; the real gate always uses the network.
 */
export async function runSmoke(config: SmokeConfig, opts: { fetchImpl?: { primary?: typeof fetch; secondary?: typeof fetch } } = {}): Promise<SmokeReport> {
  const checks: SmokeCheck[] = [];
  const record = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    return ok;
  };
  const primary = providerOf(config.primary, opts.fetchImpl?.primary);
  const secondary = providerOf(config.secondary, opts.fetchImpl?.secondary);
  const verifier = new QuorumChainVerifier({ providers: [primary, secondary], tokenContract: config.tokenContract });
  let finality = { blockNumber: null as string | null, solidifiedBlock: null as string | null };
  let agreement = { agreedBy: [] as readonly string[], agreedGroups: [] as readonly string[] };

  record('independence groups', verifier.independenceGroups.length === 2, `groups=[${verifier.independenceGroups.join(', ')}] providers=[${verifier.providers.join(', ')}]`);

  // 1. Connectivity and finality: both providers answer, and the solidified head trails the head.
  for (const p of [primary, secondary]) {
    try {
      const head = await p.getLatestBlockNumber();
      const solidified = await p.getSolidifiedBlockNumber();
      record(`${p.name}: connectivity`, head > 0n, `head=${head}`);
      record(`${p.name}: finality line`, solidified > 0n && solidified <= head, `solidified=${solidified} (head−solidified=${head - solidified})`);
    } catch (e) {
      record(`${p.name}: connectivity`, false, (e as Error).message);
    }
  }

  // 2. Canonical receipt parsing: both providers return the transfer, parsed into the shape the domain reads.
  const seen: Record<string, Trc20Transfer | null> = {};
  for (const p of [primary, secondary]) {
    try {
      const t = await p.getTransfer(config.txHash, config.logIndex);
      seen[p.name] = t.status === 'FOUND' ? t.transfer : null;
      record(`${p.name}: receipt parsed`, t.status === 'FOUND', t.status === 'FOUND'
        ? `${t.transfer.amountMinor} minor, block ${t.transfer.blockNumber}, receipt ${t.transfer.receiptStatus}, contract ${t.transfer.tokenContract}`
        : t.status === 'TX_FAILED' ? `the transaction failed on chain (${t.result})` : 'the provider does not know this transaction');
    } catch (e) {
      seen[p.name] = null;
      record(`${p.name}: receipt parsed`, false, (e as Error).message);
    }
  }

  const a = seen[config.primary.name] ?? null;
  const b = seen[config.secondary.name] ?? null;
  record('providers report identical facts', Boolean(a && b && sameTransfer(a, b)), a && b ? (sameTransfer(a, b) ? 'every field the domain reads matches' : 'the two providers disagree') : 'one of the providers did not return the transfer');

  // 3. The expected facts. A smoke test that does not know what it is looking at proves nothing.
  if (a) {
    record('contract', a.tokenContract === config.tokenContract, `${a.tokenContract}`);
    record('sender', a.fromAddress === config.expect.from, `${a.fromAddress}`);
    record('destination', a.toAddress === config.expect.to, `${a.toAddress}`);
    record('amount', a.amountMinor === config.expect.amountMinor, `${Money.ofMinor(a.amountMinor, 'USDT').toDecimalString()} USDT`);
    record('receipt', a.receiptStatus === 'SUCCESS', `${a.receiptStatus}`);

    // 4. The scanner's own path: the destination's account history around the transaction's block, every page,
    // every receipt — the transfer must come back with its real log index and the window must be complete.
    for (const p of [primary, secondary]) {
      try {
        const w = await p.readIncomingTransfers({ address: config.expect.to, contract: config.tokenContract, sinceBlock: a.blockNumber, untilBlock: a.blockNumber });
        const hit = w.transfers.find((t) => t.txHash === a.txHash && t.logIndex === a.logIndex);
        record(`${p.name}: window read`, w.complete && Boolean(hit), `${w.complete ? 'complete' : `incomplete: ${w.incompleteReason}`}; ${w.transfers.length} transfer(s) in block ${a.blockNumber}, ${w.pages} page(s), ${w.requests} request(s)${hit ? '' : '; the transfer under test is missing'}`);
      } catch (e) {
        record(`${p.name}: window read`, false, (e as Error).message);
      }
    }
  }

  // 5. The real verifier's decision, exactly as the domain would see it.
  try {
    const v = await verifier.verifyTransfer('TRON', config.txHash, config.logIndex);
    if (v.status !== 'FOUND') {
      record('verifier decision', false, `${v.status}${'reason' in v ? `: ${v.reason}` : ''}`);
    } else {
      const receipt = v.receipt;
      finality = { blockNumber: receipt.blockNumber.toString(), solidifiedBlock: receipt.solidifiedBlock.toString() };
      agreement = { agreedBy: receipt.agreedBy, agreedGroups: receipt.agreedGroups };
      const final = receipt.blockNumber <= receipt.solidifiedBlock;
      record('verifier: solidified', final, `block ${receipt.blockNumber} ≤ solidified ${receipt.solidifiedBlock}`);
      record('verifier: quorum', receipt.agreedGroups.length >= 2 && !receipt.degraded, `agreedBy=[${receipt.agreedBy.join(', ')}] groups=[${receipt.agreedGroups.join(', ')}]${receipt.degraded ? ` unavailable=[${receipt.unavailable.join(', ')}]` : ''}`);
      record('verifier: facts', receipt.amountMinor === config.expect.amountMinor && receipt.toAddress === config.expect.to, `${Money.ofMinor(receipt.amountMinor, 'USDT').toDecimalString()} USDT to ${receipt.toAddress}`);
    }
  } catch (e) {
    record('verifier decision', false, (e as Error).message);
  }

  return {
    ok: checks.every((c) => c.ok),
    environment: config.environment,
    network: config.network,
    ranAt: new Date().toISOString(),
    transaction: { txHash: config.txHash, logIndex: config.logIndex },
    expected: { contract: config.tokenContract, from: config.expect.from, to: config.expect.to, amount: Money.ofMinor(config.expect.amountMinor, 'USDT').toDecimalString() },
    providers: [{ name: config.primary.name, group: config.primary.group }, { name: config.secondary.name, group: config.secondary.group }],
    finality,
    agreement,
    checks,
  };
}

if (import.meta.main) {
  const parsed = smokeConfigFromEnv(process.env);
  if ('problems' in parsed) {
    console.error('TRON smoke gate: configuration incomplete\n' + parsed.problems.map((p) => `  - ${p}`).join('\n'));
    console.error('\nSee the header of scripts/tron-smoke.ts for the full list of settings. Never commit credentials.');
    process.exit(2);
  }
  const { config } = parsed;
  console.log(`TRON smoke gate: ${config.primary.name} (${config.primary.group}) vs ${config.secondary.name} (${config.secondary.group}) on ${config.network}`);
  console.log(`transaction ${config.txHash}:${config.logIndex}\n`);
  const report = await runSmoke(config);
  for (const c of report.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`);
  console.log(`\n${report.ok ? 'TRON smoke gate PASSED' : 'TRON smoke gate FAILED'} (${report.checks.filter((c) => c.ok).length}/${report.checks.length} checks) — environment ${report.environment}, ${report.ranAt}`);
  const file = (process.env.INRP2P_SMOKE_REPORT_FILE ?? '').trim();
  if (file) {
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`report written to ${file}`);
  }
  process.exit(report.ok ? 0 : 1);
}
