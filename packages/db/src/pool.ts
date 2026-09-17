import pg from 'pg';

export type Int8Mode = 'bigint' | 'number';

export interface PoolOptions {
  connectionString: string;
  applicationName: string;
  /**
   * `bigint` (default) for financial access — BIGINT money columns must never become JS numbers.
   * `number` only for the Better Auth pool, whose int8 columns are epoch-millisecond counters.
   */
  int8?: Int8Mode;
  max?: number;
  statementTimeoutMs?: number;
}

const INT8_OID = 20;
const NUMERIC_OID = 1700;
const DATE_OID = 1082;

function typesFor(mode: Int8Mode): pg.CustomTypesConfig {
  return {
    getTypeParser(oid: number, format?: string) {
      if (oid === INT8_OID) {
        return mode === 'bigint' ? (v: string) => BigInt(v) : (v: string) => {
          const n = Number(v);
          if (!Number.isSafeInteger(n)) throw new RangeError(`int8 value ${v} is not a safe integer`);
          return n;
        };
      }
      // Calendar dates (e.g. IST business day) stay 'YYYY-MM-DD' strings: a JS Date would shift them by the process time zone.
      if (oid === DATE_OID) return (v: string) => v;
      // Numeric aggregates (e.g. balance views) are parsed exactly as bigint when integral.
      if (oid === NUMERIC_OID && mode === 'bigint') {
        return (v: string) => (/^-?\d+$/.test(v) ? BigInt(v) : v);
      }
      return pg.types.getTypeParser(oid, format as 'text');
    },
  };
}

export function createPool(opts: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    application_name: opts.applicationName,
    max: opts.max ?? 10,
    types: typesFor(opts.int8 ?? 'bigint'),
    ...(opts.statementTimeoutMs ? { statement_timeout: opts.statementTimeoutMs } : {}),
  });
  // Idle-client errors (e.g. server restart) must not crash the process; queries still fail loudly.
  pool.on('error', (err) => {
    process.emitWarning(`postgres pool "${opts.applicationName}" idle client error: ${err.message}`);
  });
  return pool;
}
