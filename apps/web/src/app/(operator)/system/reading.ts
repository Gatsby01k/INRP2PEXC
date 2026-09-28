import type { HealthCheck } from '@inrp2p/desk';
import { inr } from '../_desk/format.ts';

/** A health reading in the operator's units. Plain module: the page (server) and the table (client) both use it. */

export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min`;
  const hours = Math.floor(m / 60);
  const rest = m % 60;
  if (hours < 48) return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  return `${Math.floor(hours / 24)} d`;
}

export function reading(c: HealthCheck, value: number): string {
  if (c.unit === 'seconds') return duration(value);
  if (c.unit === 'inr') return inr(String(value));
  return String(value);
}
