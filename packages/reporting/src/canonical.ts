import { createHash } from 'node:crypto';

/**
 * Canonical bytes, so "the same receipt" is a question with an answer.
 *
 * A receipt's whole value is that it does not change. That needs one serialization, not one per run: object keys
 * in a fixed order, no incidental whitespace, and no number that a floating-point round-trip could move. Every
 * amount in a snapshot is already a decimal **string** for that reason (FINANCIAL_INVARIANTS §1.1); this refuses
 * a raw number outright rather than hashing one and finding out later.
 */
export type Canonical = string | boolean | null | readonly Canonical[] | { readonly [k: string]: Canonical };

export function canonicalJson(value: Canonical): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, Canonical>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * Refuses anything that cannot be serialized deterministically. A number is the interesting case: it is not
 * *wrong* so much as unrepeatable, and a receipt whose hash depends on how a runtime printed `0.1` is not
 * evidence of anything.
 */
export function assertCanonical(value: unknown, path = '$'): asserts value is Canonical {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') throw new Error(`receipt snapshot has a number at ${path}; amounts are decimal strings`);
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertCanonical(v, `${path}[${i}]`));
    return;
  }
  if (typeof value !== 'object') throw new Error(`receipt snapshot has an unserializable ${typeof value} at ${path}`);
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) throw new Error(`receipt snapshot has undefined at ${path}.${k}; omit the key or write null`);
    assertCanonical(v, `${path}.${k}`);
  }
}

export const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
