import type { RobotChannel } from '@inrp2p/db';
import type { PersonFacts } from './facts.ts';
import type { PlaybookKind } from './playbooks.ts';
import type { RobotPolicy } from './policy.ts';
import { istHour } from './format.ts';

/**
 * Whether the robot may write to a person now, and where (ADR 0034 §2.4). The rules, in the order they are asked:
 *
 * 1. The owner switched outreach on (or to a dry run) and did not switch this playbook off.
 * 2. The person consented: anything for SERVICE, only "tell me everything" for an OPPORTUNITY; and did not snooze it.
 * 3. They are not in the workspace right now — there the robot shows it on the page instead of writing.
 * 4. Not more than one message from the robot a day, and none within three hours of anything else INRP2P told them:
 *    a person who just heard about their deal does not also hear a suggestion.
 * 5. Not in the quiet hours of India's night.
 * 6. Somewhere to write: Telegram first (instant, and where they chose deal alerts), then their browser, then email.
 *
 * The inbox is not a channel here: a member always gets the note in the inbox as well; someone with no account yet has
 * none, so for them a channel is required.
 */
export type ContactRefusal = 'OFF' | 'PLAYBOOK_OFF' | 'CONSENT' | 'SNOOZED' | 'IN_APP' | 'DAILY_CAP' | 'RECENTLY_TOLD' | 'QUIET_HOURS' | 'NO_CHANNEL';

export type ContactDecision = { readonly ok: true; readonly channel: RobotChannel | null } | { readonly ok: false; readonly why: ContactRefusal };

export const DAILY_CAP_HOURS = 20;
export const RECENTLY_TOLD_HOURS = 3;
const HOUR = 3_600_000;

/** The IST hour is inside the quiet window `[from, to)`, which may wrap midnight; equal hours mean never quiet. */
export function inQuietHours(policy: Pick<RobotPolicy, 'quietFrom' | 'quietTo'>, now: Date): boolean {
  const { quietFrom: from, quietTo: to } = policy;
  if (from === to) return false;
  const h = istHour(now);
  return from < to ? h >= from && h < to : h >= from || h < to;
}

export function channelFor(f: Pick<PersonFacts, 'telegramChat' | 'push' | 'email' | 'member'>): RobotChannel | null {
  if (f.telegramChat) return 'TELEGRAM';
  if (f.member && f.push) return 'PUSH';
  if (f.email) return 'EMAIL';
  return null;
}

export function mayContact(f: PersonFacts, playbook: { key: string; kind: PlaybookKind }, policy: RobotPolicy, now: Date): ContactDecision {
  if (policy.outreach === 'OFF') return { ok: false, why: 'OFF' };
  if (policy.playbooksOff.includes(playbook.key)) return { ok: false, why: 'PLAYBOOK_OFF' };
  const consent = f.preference.outreach;
  if (consent === 'NONE' || (playbook.kind === 'OPPORTUNITY' && consent !== 'ALL')) return { ok: false, why: 'CONSENT' };
  const snoozed = f.preference.snoozed[playbook.key];
  if (snoozed && Date.parse(snoozed) > now.getTime()) return { ok: false, why: 'SNOOZED' };
  if (f.activeNow) return { ok: false, why: 'IN_APP' };
  const lastTouch = f.touches.filter((t) => t.mine && t.mode === (policy.outreach === 'ON' ? 'LIVE' : 'DRY_RUN')).reduce<Date | null>((a, t) => (a === null || t.createdAt > a ? t.createdAt : a), null);
  if (lastTouch && now.getTime() - lastTouch.getTime() < DAILY_CAP_HOURS * HOUR) return { ok: false, why: 'DAILY_CAP' };
  if (f.lastNotifiedAt && now.getTime() - f.lastNotifiedAt.getTime() < RECENTLY_TOLD_HOURS * HOUR) return { ok: false, why: 'RECENTLY_TOLD' };
  if (inQuietHours(policy, now)) return { ok: false, why: 'QUIET_HOURS' };
  const channel = channelFor(f);
  if (!channel && !f.member) return { ok: false, why: 'NO_CHANNEL' };
  return { ok: true, channel };
}
