import { DomainError } from '@inrp2p/kernel';

/**
 * The market price of USDT in rupees, read from public Indian order books — the reference an automatic price of the
 * INRP2P exchange is bounded by (ADR 0025): a client buying is never asked more than the market's ask, a client selling is
 * never paid less than its bid, past what the pricing policy allows.
 *
 * Two independent exchanges' books, no keys, read as the strings they answer with — never through a float. A price is
 * published only when **both** answer and agree within `maxSpread`: a reference nobody can confirm is not a reference,
 * and with none fresh enough nothing is priced automatically. The global aggregators' "USDT in INR" is a different
 * market (dollar-rupee, without the Indian premium) and is deliberately not a source.
 */
export interface UsdtInrSource {
  readonly name: string;
  /** The book's best bid and ask, INR per USDT, in micro-rupees; or a thrown error. */
  read(): Promise<{ readonly bidMicro: bigint; readonly askMicro: bigint }>;
}

export interface UsdtInrReading {
  /** What the market pays for one USDT — the reference of a client selling. */
  readonly bidMicro: bigint;
  /** What the market asks for one USDT — the reference of a client buying. */
  readonly askMicro: bigint;
  /** The sources with what each said, for the record. */
  readonly source: string;
}

const getJson = async (fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<unknown> => {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`answered ${res.status}`);
  return res.json();
};

const DECIMAL = /^(0|[1-9]\d{0,8})(?:\.(\d{1,18}))?$/;

/** A decimal string as micro-rupees, digits past the sixth dropped (the books quote to two or four). */
export function rupeesMicro(v: unknown, what: string): bigint {
  const text = typeof v === 'string' ? v.trim() : '';
  const m = DECIMAL.exec(text);
  if (!m) throw new Error(`${what} is not a decimal price`);
  const micro = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').slice(0, 6).padEnd(6, '0'));
  if (micro <= 0n) throw new Error(`${what} is not a positive price`);
  return micro;
}

/** WazirX's 24-hour ticker and CoinDCX's ticker: two Indian books, both reachable without a key. */
export function marketUsdtInrSources(fetchImpl: typeof fetch = globalThis.fetch, timeoutMs = 8_000): UsdtInrSource[] {
  return [
    {
      name: 'wazirx',
      read: async () => {
        const j = (await getJson(fetchImpl, 'https://api.wazirx.com/sapi/v1/ticker/24hr?symbol=usdtinr', timeoutMs)) as { bidPrice?: unknown; askPrice?: unknown };
        return { bidMicro: rupeesMicro(j.bidPrice, 'wazirx bid'), askMicro: rupeesMicro(j.askPrice, 'wazirx ask') };
      },
    },
    {
      name: 'coindcx',
      read: async () => {
        const j = await getJson(fetchImpl, 'https://api.coindcx.com/exchange/ticker', timeoutMs);
        const row = Array.isArray(j) ? (j as { market?: unknown; bid?: unknown; ask?: unknown }[]).find((r) => r.market === 'USDTINR') : undefined;
        if (!row) throw new Error('coindcx has no USDTINR market');
        return { bidMicro: rupeesMicro(row.bid, 'coindcx bid'), askMicro: rupeesMicro(row.ask, 'coindcx ask') };
      },
    },
  ];
}

const shown = (micro: bigint): string => {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
};

/** Within `maxSpreadBps` basis points of each other: the highest is at most that much above the lowest. */
const agree = (values: readonly bigint[], maxSpreadBps: bigint): boolean => {
  const lo = values.reduce((a, b) => (b < a ? b : a));
  const hi = values.reduce((a, b) => (b > a ? b : a));
  return hi * 10_000n <= lo * (10_000n + maxSpreadBps);
};

/** The middle value, rounded towards the client's side: a bid down, an ask up. */
const median = (values: readonly bigint[], side: 'BID' | 'ASK'): bigint => {
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (s.length % 2 === 1) return s[(s.length - 1) / 2]!;
  const sum = s[s.length / 2 - 1]! + s[s.length / 2]!;
  return side === 'BID' ? sum / 2n : (sum + 1n) / 2n;
};

/**
 * The market's bid and ask from sources that agree. Every source must answer with a book that is not crossed (bid below
 * ask), and at least `minSources` must answer — a single book is not a confirmed price. Sources whose bids or asks are more
 * than `maxSpreadBps` apart are refused as a whole.
 */
export async function readUsdtInrReference(sources: readonly UsdtInrSource[], opts: { minSources?: number; maxSpreadBps?: bigint } = {}): Promise<UsdtInrReading> {
  const minSources = opts.minSources ?? 2;
  const maxSpreadBps = opts.maxSpreadBps ?? 200n;
  const answers = await Promise.all(
    sources.map(async (s) => {
      try {
        const book = await s.read();
        if (book.bidMicro > book.askMicro) throw new Error(`crossed book: bid ${shown(book.bidMicro)} above ask ${shown(book.askMicro)}`);
        return { name: s.name, ...book, error: null as string | null };
      } catch (e) {
        return { name: s.name, bidMicro: 0n, askMicro: 0n, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  const ok = answers.filter((a) => a.error === null);
  if (ok.length < minSources) {
    throw new DomainError('CHAIN_PROVIDER_ERROR', `only ${ok.length} of ${minSources} USDT/INR sources answered: ${answers.filter((a) => a.error).map((a) => `${a.name}: ${a.error}`).join('; ')}`, { transient: true });
  }
  const bids = ok.map((a) => a.bidMicro);
  const asks = ok.map((a) => a.askMicro);
  if (!agree(bids, maxSpreadBps) || !agree(asks, maxSpreadBps)) {
    throw new DomainError('INVALID_RATE', `USDT/INR sources disagree: ${ok.map((a) => `${a.name} ${shown(a.bidMicro)}/${shown(a.askMicro)}`).join(', ')}`);
  }
  return {
    bidMicro: median(bids, 'BID'),
    askMicro: median(asks, 'ASK'),
    source: `market: ${ok.map((a) => `${a.name} ${shown(a.bidMicro)}/${shown(a.askMicro)}`).join(', ')}`.slice(0, 200),
  };
}
