/**
 * Why a TRON provider drops out of the worker's readings, answered against the real provider with the worker's own
 * settings — read only: nothing is written anywhere, nothing is sent on chain, and no URL, key or address of the
 * exchange is printed (only provider names, timings, HTTP statuses and error texts with any key cut out).
 *
 *   INRP2P_TRON_PRIMARY_URL=… INRP2P_TRON_PRIMARY_NAME=trongrid INRP2P_TRON_PRIMARY_GROUP=trongrid [INRP2P_TRON_PRIMARY_KEY=…]
 *   INRP2P_TRON_SECONDARY_URL=… INRP2P_TRON_SECONDARY_NAME=quicknode INRP2P_TRON_SECONDARY_GROUP=quicknode
 *   INRP2P_USDT_CONTRACT=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t  node scripts/tron-provider-probe.ts [rounds]
 *
 * For each configured provider it times every endpoint the worker calls (head, solidified head, balanceOf, account, the
 * TRC20 history index, a receipt) and then reads a balance `rounds` times (default 20) the way the worker does, counting
 * how often the solidified head moved under the read: the rule before this release (same block before and after, three
 * attempts) against the rule now (a forward move of up to two blocks, four attempts). The address read is the USDT
 * contract's own — public, and never one of the exchange's.
 *
 * Exit 0: every provider answered. Exit 1: a provider failed an endpoint the worker needs; the line says which and how.
 */
import { BALANCE_BRACKET_BLOCKS, TronHttpProvider } from '@inrp2p/adapters';
import { tronAddressToHex } from '@inrp2p/kernel';

interface Target {
  readonly name: string;
  readonly group: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
}

const redact = (text: string, t: Target): string => {
  let out = text;
  for (const secret of [t.baseUrl, t.apiKey, ...new URL(t.baseUrl).pathname.split('/').filter((x) => x.length >= 12)]) {
    if (secret) out = out.split(secret).join('…');
  }
  return out.slice(0, 300);
};

function targets(env: NodeJS.ProcessEnv): Target[] {
  const out: Target[] = [];
  for (const slot of ['PRIMARY', 'SECONDARY'] as const) {
    const baseUrl = env[`INRP2P_TRON_${slot}_URL`];
    if (!baseUrl) continue;
    out.push({
      name: env[`INRP2P_TRON_${slot}_NAME`] ?? `tron-${slot.toLowerCase()}`,
      group: env[`INRP2P_TRON_${slot}_GROUP`] ?? slot.toLowerCase(),
      baseUrl: baseUrl.replace(/\/+$/, ''),
      ...(env[`INRP2P_TRON_${slot}_KEY`] ? { apiKey: env[`INRP2P_TRON_${slot}_KEY`]! } : {}),
    });
  }
  return out;
}

async function raw(t: Target, path: string, body?: unknown): Promise<{ status: number; ms: number; json: unknown }> {
  const started = performance.now();
  const r = await fetch(`${t.baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(t.apiKey ? { 'TRON-PRO-API-KEY': t.apiKey } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text.slice(0, 120);
  }
  return { status: r.status, ms: Math.round(performance.now() - started), json };
}

const headOf = (j: unknown): bigint | null => {
  const n = (j as { block_header?: { raw_data?: { number?: unknown } } } | null)?.block_header?.raw_data?.number;
  return typeof n === 'number' ? BigInt(n) : null;
};

async function probe(t: Target, contract: string, rounds: number): Promise<boolean> {
  console.log(`\n== ${t.name} (group ${t.group})`);
  let ok = true;
  const owner = contract;
  const parameter = `${'0'.repeat(24)}${tronAddressToHex(owner).slice(2)}`;
  const endpoints: [string, string, unknown?][] = [
    ['head', '/wallet/getnowblock', {}],
    ['solidified head', '/walletsolidity/getnowblock', {}],
    ['balanceOf (solidified)', '/walletsolidity/triggerconstantcontract', { owner_address: owner, contract_address: contract, function_selector: 'balanceOf(address)', parameter, visible: true }],
    ['account (solidified)', '/walletsolidity/getaccount', { address: owner, visible: true }],
    ['TRC20 history index', `/v1/accounts/${contract}/transactions/trc20?only_to=true&limit=1&contract_address=${contract}`],
  ];
  for (const [label, path, body] of endpoints) {
    try {
      const r = await raw(t, path, body);
      const fine = r.status === 200 && r.json !== null && typeof r.json === 'object';
      if (!fine) ok = false;
      console.log(`${fine ? 'ok  ' : 'FAIL'} ${label.padEnd(24)} ${String(r.status).padEnd(4)} ${String(r.ms).padStart(5)} ms${fine ? '' : `  ${redact(JSON.stringify(r.json), t)}`}`);
    } catch (e) {
      ok = false;
      console.log(`FAIL ${label.padEnd(24)} unreachable: ${redact((e as Error).message, t)}`);
    }
  }

  // Balance reads as the worker makes them, and how the head moved under each.
  const drifts: bigint[] = [];
  const statuses = new Map<string, number>();
  let errors = 0;
  for (let i = 0; i < rounds; i++) {
    try {
      const b = await raw(t, '/walletsolidity/getnowblock', {});
      const [x, y] = await Promise.all([
        raw(t, '/walletsolidity/triggerconstantcontract', endpoints[2]![2]),
        raw(t, '/walletsolidity/getaccount', endpoints[3]![2]),
      ]);
      const a = await raw(t, '/walletsolidity/getnowblock', {});
      for (const r of [b, x, y, a]) if (r.status !== 200) statuses.set(String(r.status), (statuses.get(String(r.status)) ?? 0) + 1);
      const before = headOf(b.json);
      const after = headOf(a.json);
      if (before === null || after === null || x.status !== 200 || y.status !== 200) errors += 1;
      else drifts.push(after - before);
    } catch {
      errors += 1;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (statuses.size > 0) console.log(`non-200 answers during the balance reads: ${[...statuses].map(([k, v]) => `${k}×${v}`).join(', ')}${statuses.has('429') ? ' — rate limited: the plan\'s request quota or rate' : ''}`);
  const same = drifts.filter((d) => d === 0n).length;
  const bracket = drifts.filter((d) => d >= 0n && d <= BALANCE_BRACKET_BLOCKS).length;
  const back = drifts.filter((d) => d < 0n).length;
  console.log(`balance reads: ${drifts.length} bracketed, ${errors} failed outright; head unchanged ${same}, moved forward ≤${BALANCE_BRACKET_BLOCKS} ${bracket - same}, moved further ${drifts.length - bracket - back}, went back ${back}`);
  if (drifts.length > 0) {
    const failOld = (1 - same / drifts.length) ** 3;
    const failNew = (1 - bracket / drifts.length) ** 4;
    console.log(`a reading lost to a moving head: ${(failOld * 100).toFixed(2)} % before this release (same block, 3 attempts), ${(failNew * 100).toFixed(2)} % now (≤${BALANCE_BRACKET_BLOCKS} blocks forward, 4 attempts)`);
  }

  // And the provider as the worker uses it.
  const provider = new TronHttpProvider({ name: t.name, independenceGroup: t.group, baseUrl: t.baseUrl, ...(t.apiKey ? { apiKey: t.apiKey } : {}) });
  try {
    const started = performance.now();
    const reading = await provider.getSolidifiedBalance(owner, contract);
    console.log(`ok   worker balance read: block ${reading.solidifiedBlock}, ${Math.round(performance.now() - started)} ms`);
  } catch (e) {
    ok = false;
    console.log(`FAIL worker balance read: ${redact((e as Error).message, t)}`);
  }
  return ok;
}

const configured = targets(process.env);
const contract = process.env.INRP2P_USDT_CONTRACT ?? 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const rounds = Number.parseInt(process.argv[2] ?? '20', 10) || 20;
if (configured.length === 0) {
  console.error('set INRP2P_TRON_PRIMARY_URL (and INRP2P_TRON_SECONDARY_URL) as the worker has them');
  process.exit(2);
}
let allOk = true;
for (const t of configured) allOk = (await probe(t, contract, rounds)) && allOk;
process.exit(allOk ? 0 : 1);
