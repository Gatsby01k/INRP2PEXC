/**
 * Phase 5 manual smoke gate (TECH_DEBT TD-07). Verifies the real TRON adapters against real providers:
 * connectivity, canonical parsing, identical facts across two independent providers, finality handling, and the
 * decision the real `DualProviderChainVerifier` returns for one known transaction.
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
 *   INRP2P_SMOKE_TRON_PRIMARY_NAME / _SECONDARY_NAME, INRP2P_SMOKE_TRON_PRIMARY_KEY / _SECONDARY_KEY (API keys).
 */
import { Money, isTronAddress } from '@inrp2p/kernel';
import { DualProviderChainVerifier, type TronProvider, TronHttpProvider, sameTransfer } from '@inrp2p/adapters';

export interface SmokeConfig {
  readonly network: 'TRON';
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

const providerOf = (p: SmokeConfig['primary']): TronProvider =>
  new TronHttpProvider({ name: p.name, independenceGroup: p.group, baseUrl: p.baseUrl, ...(p.apiKey ? { apiKey: p.apiKey } : {}) });

/** Runs the gate. Every step is reported, including the ones that passed, so a failure has context. */
export async function runSmoke(config: SmokeConfig): Promise<{ ok: boolean; checks: SmokeCheck[] }> {
  const checks: SmokeCheck[] = [];
  const record = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    return ok;
  };
  const primary = providerOf(config.primary);
  const secondary = providerOf(config.secondary);
  const verifier = new DualProviderChainVerifier({ primary, secondary, tokenContract: config.tokenContract });

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

  // 2. Canonical parsing: both providers return the transfer, parsed into the same shape the domain reads.
  const seen: Record<string, Awaited<ReturnType<TronProvider['getTransfer']>>> = {};
  for (const p of [primary, secondary]) {
    try {
      const t = await p.getTransfer(config.txHash, config.logIndex);
      seen[p.name] = t;
      record(`${p.name}: transfer parsed`, t !== null, t ? `${t.amountMinor} minor, block ${t.blockNumber}, receipt ${t.receiptStatus}` : 'the provider does not know this transaction');
    } catch (e) {
      record(`${p.name}: transfer parsed`, false, (e as Error).message);
    }
  }

  const a = seen[config.primary.name];
  const b = seen[config.secondary.name];
  record('providers report identical facts', Boolean(a && b && sameTransfer(a, b)), a && b ? (sameTransfer(a, b) ? 'every field the domain reads matches' : 'the two providers disagree') : 'one of the providers did not return the transfer');

  // 3. The expected facts. A smoke test that does not know what it is looking at proves nothing.
  if (a) {
    record('contract', a.tokenContract === config.tokenContract, `${a.tokenContract}`);
    record('sender', a.fromAddress === config.expect.from, `${a.fromAddress}`);
    record('destination', a.toAddress === config.expect.to, `${a.toAddress}`);
    record('amount', a.amountMinor === config.expect.amountMinor, `${Money.ofMinor(a.amountMinor, 'USDT').toDecimalString()} USDT`);
    record('receipt', a.receiptStatus === 'SUCCESS', `${a.receiptStatus}`);
  }

  // 4. The real verifier's decision, exactly as the domain would see it.
  try {
    const receipt = await verifier.lookupTransfer('TRON', config.txHash, config.logIndex);
    if (!receipt) {
      record('verifier decision', false, 'the verifier does not know this transfer');
    } else {
      const final = receipt.blockNumber <= receipt.solidifiedBlock;
      record('verifier: solidified', final, `block ${receipt.blockNumber} ≤ solidified ${receipt.solidifiedBlock}`);
      record('verifier: quorum', receipt.agreedGroups.length >= 2, `agreedBy=[${receipt.agreedBy.join(', ')}] groups=[${receipt.agreedGroups.join(', ')}]`);
      record('verifier: facts', receipt.amountMinor === config.expect.amountMinor && receipt.toAddress === config.expect.to, `${Money.ofMinor(receipt.amountMinor, 'USDT').toDecimalString()} USDT to ${receipt.toAddress}`);
    }
  } catch (e) {
    record('verifier decision', false, (e as Error).message);
  }

  return { ok: checks.every((c) => c.ok), checks };
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
  const { ok, checks } = await runSmoke(config);
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`);
  console.log(`\n${ok ? 'TRON smoke gate PASSED' : 'TRON smoke gate FAILED'} (${checks.filter((c) => c.ok).length}/${checks.length} checks)`);
  process.exit(ok ? 0 : 1);
}
