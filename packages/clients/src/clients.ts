import { sql } from 'kysely';
import { DomainError, Money, optionalText, requireOneOf, requireText, requireUuid } from '@inrp2p/kernel';
import type { ClientStatus, DirectionValue, Tx } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { type OperatorActor, actorLabel, operatorCommand } from '@inrp2p/identity';

export interface CreateClientPayload {
  readonly legalName: string;
  readonly displayName: string;
  readonly type: 'COMPANY' | 'INDIVIDUAL';
  readonly typicalDirection?: DirectionValue | null;
  /** Decimal USDT string, e.g. "100000". */
  readonly typicalSizeUsdt?: string | null;
  readonly pricingNotes?: string | null;
}

function typicalSize(value: string | null | undefined): bigint | null {
  if (value === undefined || value === null || value === '') return null;
  const m = Money.parse(value, 'USDT');
  if (!m.isPositive()) throw new DomainError('INVALID_AMOUNT', 'typical size must be positive');
  return m.minor;
}

/** `client.create` — `client:manage`. */
export function createClient(actor: OperatorActor) {
  return operatorCommand(actor, 'client:manage', async (ctx, p: CreateClientPayload) => {
    const row = await ctx.tx
      .insertInto('client')
      .values({
        legal_name: requireText(p.legalName, 'legalName', 200),
        display_name: requireText(p.displayName, 'displayName', 120),
        type: requireOneOf(p.type, 'type', ['COMPANY', 'INDIVIDUAL'] as const),
        typical_direction: p.typicalDirection ? requireOneOf(p.typicalDirection, 'typicalDirection', ['SELL_USDT', 'BUY_USDT'] as const) : null,
        typical_size_usdt_minor: typicalSize(p.typicalSizeUsdt),
        pricing_notes: optionalText(p.pricingNotes, 'pricingNotes'),
        created_by: actorLabel(ctx),
      })
      .returning(['id', 'ref', 'legal_name', 'display_name', 'type', 'status'])
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, { action: 'client.created', entityType: 'client', entityId: row.id, after: row });
    return { clientId: row.id, ref: row.ref };
  });
}

export interface UpdateClientPayload {
  readonly clientId: string;
  readonly expectedVersion: number;
  readonly legalName?: string;
  readonly displayName?: string;
  readonly typicalDirection?: DirectionValue | null;
  readonly typicalSizeUsdt?: string | null;
  readonly pricingNotes?: string | null;
}

async function lockClient(tx: Tx, clientId: string) {
  const row = await tx.selectFrom('client').selectAll().where('id', '=', requireUuid(clientId, 'clientId')).forUpdate().executeTakeFirst();
  if (!row) throw new DomainError('NOT_FOUND', 'client not found');
  return row;
}

/** `client.update` — profile fields only; optimistic `expectedVersion` on top of the row lock. */
export function updateClient(actor: OperatorActor) {
  return operatorCommand(actor, 'client:manage', async (ctx, p: UpdateClientPayload) => {
    const before = await lockClient(ctx.tx, p.clientId);
    if (before.version !== p.expectedVersion) throw new DomainError('STALE_VERSION', `client is at version ${before.version}`);
    const changes = {
      ...(p.legalName !== undefined ? { legal_name: requireText(p.legalName, 'legalName', 200) } : {}),
      ...(p.displayName !== undefined ? { display_name: requireText(p.displayName, 'displayName', 120) } : {}),
      ...(p.typicalDirection !== undefined ? { typical_direction: p.typicalDirection ? requireOneOf(p.typicalDirection, 'typicalDirection', ['SELL_USDT', 'BUY_USDT'] as const) : null } : {}),
      ...(p.typicalSizeUsdt !== undefined ? { typical_size_usdt_minor: typicalSize(p.typicalSizeUsdt) } : {}),
      ...(p.pricingNotes !== undefined ? { pricing_notes: optionalText(p.pricingNotes, 'pricingNotes') } : {}),
    };
    const after = await ctx.tx
      .updateTable('client')
      .set({ ...changes, version: before.version + 1, updated_at: sql<Date>`statement_timestamp()` })
      .where('id', '=', before.id)
      .returning(['id', 'legal_name', 'display_name', 'typical_direction', 'typical_size_usdt_minor', 'pricing_notes', 'version'])
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, {
      action: 'client.updated', entityType: 'client', entityId: before.id,
      before: { legal_name: before.legal_name, display_name: before.display_name, typical_direction: before.typical_direction, typical_size_usdt_minor: before.typical_size_usdt_minor, pricing_notes: before.pricing_notes, version: before.version },
      after,
    });
    return { version: after.version };
  });
}

/** `client.set_status` — ACTIVE ⇄ SUSPENDED with a reason. A suspended client cannot receive new destinations or trades. */
export function setClientStatus(actor: OperatorActor) {
  return operatorCommand(actor, 'client:manage', async (ctx, p: { clientId: string; status: ClientStatus; reason: string }) => {
    const status = requireOneOf(p.status, 'status', ['ACTIVE', 'SUSPENDED'] as const);
    const reason = requireText(p.reason, 'reason', 500);
    const before = await lockClient(ctx.tx, p.clientId);
    if (before.status === status) return { status, changed: false };
    await ctx.tx.updateTable('client').set({ status, version: before.version + 1, updated_at: sql<Date>`statement_timestamp()` }).where('id', '=', before.id).execute();
    await appendAudit(ctx, { action: status === 'SUSPENDED' ? 'client.suspended' : 'client.reactivated', entityType: 'client', entityId: before.id, before: { status: before.status }, after: { status, reason } });
    return { status, changed: true };
  });
}

/**
 * `client.set_exchange_access` — `client:manage`. Opens (or closes) the Exchange for a client: requests, quotes and
 * trades (IX080 refuses a request from a client without it). Every client the desk onboards has it; a client that
 * exists because someone applied to be a trader starts without it, and has it only when the desk decides so here.
 * Closing it stops new requests; trades already open settle as agreed.
 */
export function setClientExchangeAccess(actor: OperatorActor) {
  return operatorCommand(actor, 'client:manage', async (ctx, p: { clientId: string; exchangeAccess: boolean; reason: string }) => {
    if (typeof p.exchangeAccess !== 'boolean') throw new DomainError('INVALID_ARGUMENT', 'exchangeAccess must be boolean');
    const reason = requireText(p.reason, 'reason', 500);
    const before = await lockClient(ctx.tx, p.clientId);
    if (before.exchange_access === p.exchangeAccess) return { changed: false };
    if (p.exchangeAccess && before.status !== 'ACTIVE') throw new DomainError('CLIENT_NOT_ACTIVE', `client ${before.ref} is ${before.status}`);
    await ctx.tx.updateTable('client').set({ exchange_access: p.exchangeAccess, version: before.version + 1, updated_at: sql<Date>`statement_timestamp()` }).where('id', '=', before.id).execute();
    await appendAudit(ctx, { action: p.exchangeAccess ? 'client.exchange_opened' : 'client.exchange_closed', entityType: 'client', entityId: before.id, before: { exchange_access: before.exchange_access }, after: { exchange_access: p.exchangeAccess, reason } });
    return { changed: true };
  });
}

/** Shared precondition for adding destinations, contacts and users. */
export async function requireActiveClient(tx: Tx, clientId: string): Promise<{ id: string; ref: string }> {
  const row = await tx.selectFrom('client').select(['id', 'ref', 'status']).where('id', '=', requireUuid(clientId, 'clientId')).forShare().executeTakeFirst();
  if (!row) throw new DomainError('NOT_FOUND', 'client not found');
  if (row.status !== 'ACTIVE') throw new DomainError('CLIENT_NOT_ACTIVE', `client ${row.ref} is ${row.status}`);
  return { id: row.id, ref: row.ref };
}
