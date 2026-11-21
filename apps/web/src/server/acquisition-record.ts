import type { AcquisitionEventKind, Db } from '@inrp2p/db';
import { type Attribution, type Segment, deviceOf, segmentCode } from './acquisition.ts';

/**
 * Writes what migration 0053 keeps about where traders come from. None of it ever stands between a person and a page: a
 * record that cannot be written is logged and dropped — the funnel loses one line, the visitor loses nothing.
 */

export interface VisitContext {
  /** ISO 3166-1 alpha-2 as the edge reported it, or nothing. */
  readonly country: string | null;
  readonly userAgent: string | null;
}

/** Where the request came from, as the edge said — the country only; the agent is reduced to a kind of device. */
export function visitContext(headers: Headers): VisitContext {
  const country = headers.get('x-vercel-ip-country')?.trim().toUpperCase() ?? null;
  return { country: country && /^[A-Z]{2}$/.test(country) && country !== 'XX' ? country : null, userAgent: headers.get('user-agent') };
}

/** The visitor's row, written once: its id and the first touch it arrived with. */
async function ensureVisitor(db: Db, a: Attribution, ctx: VisitContext): Promise<void> {
  const f = a.first;
  await db
    .insertInto('acquisition_visitor')
    .values({
      id: a.visitor,
      source: f.source,
      medium: f.medium,
      campaign: f.campaign,
      content: f.content,
      term: f.term,
      ref: f.ref,
      click_kind: f.click,
      click_id: f.click ? f.clickId : null,
      referrer_host: f.referrer,
      segment: segmentCode(a.segment),
      country: ctx.country,
      device: deviceOf(ctx.userAgent),
      first_at: new Date(f.at * 1000),
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
}

function logDropped(what: string, error: unknown): void {
  console.warn(JSON.stringify({ level: 'warn', event: 'acquisition.not_recorded', what, message: error instanceof Error ? error.message : String(error) }));
}

/** One thing a visitor did, with the touch they had at that moment. */
export async function recordAcquisitionEvent(
  db: Db,
  a: Attribution,
  event: { readonly kind: AcquisitionEventKind; readonly page: 'TRADERS' | 'BECOME_A_TRADER'; readonly segment?: Segment | null; readonly placement?: string | null },
  ctx: VisitContext,
): Promise<void> {
  try {
    await ensureVisitor(db, a, ctx);
    const l = a.last;
    await db
      .insertInto('acquisition_event')
      .values({
        visitor_id: a.visitor,
        kind: event.kind,
        page: event.page,
        segment: segmentCode(event.segment ?? a.segment),
        placement: event.placement && /^[a-z][a-z0-9_]{0,31}$/.test(event.placement) ? event.placement : null,
        source: l.source,
        medium: l.medium,
        campaign: l.campaign,
        content: l.content,
        term: l.term,
        ref: l.ref,
        referrer_host: l.referrer,
      })
      .execute();
  } catch (error) {
    logDropped(event.kind, error);
  }
}

/**
 * The visitor is now someone who signed in on the trader path: their id is tied to the sign-in identity, once. From here
 * the funnel reads the application, its review, the reserve and the deals from where they already are.
 */
export async function linkAcquisition(db: Db, a: Attribution, userId: string, ctx: VisitContext): Promise<void> {
  try {
    await ensureVisitor(db, a, ctx);
    await db.insertInto('acquisition_link').values({ visitor_id: a.visitor, user_id: userId }).onConflict((oc) => oc.columns(['visitor_id', 'user_id']).doNothing()).execute();
  } catch (error) {
    logDropped('LINK', error);
  }
}
