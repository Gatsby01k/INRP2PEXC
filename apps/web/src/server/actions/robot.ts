'use server';

import { hitRateLimit } from '@inrp2p/commands';
import type { RobotConsent } from '@inrp2p/db';
import { type AskResult, askRobot, markRobotSeen, setRobotConsent, snoozeRobot } from '@inrp2p/robot';
import { type CommandResult, failure } from '../command.ts';
import { runWorkspaceCommand, workspaceContext } from '../client.ts';
import { robotDeskEmail, robotMind } from '../robot.ts';

/**
 * The person's side of the robot (ADR 0034): a question, their consent, "not now" on a suggestion, and that they saw
 * what it had to say. Each acts as the signed-in person only — a member of a client or someone with no account yet.
 */
export async function askRobotAction(input: { text: string }): Promise<CommandResult<AskResult>> {
  try {
    const ctx = await workspaceContext();
    const text = typeof input.text === 'string' ? input.text : '';
    if (text.trim().length === 0) return { ok: false, code: 'INVALID_ARGUMENT', message: 'Ask me something.' };
    if (text.length > 1000) return { ok: false, code: 'INVALID_ARGUMENT', message: 'That is a long one — keep it under 1,000 characters.' };
    // A person asks a few questions a minute at most; a script asking hundreds is refused before anything is read.
    await hitRateLimit(ctx.db, { bucket: 'robot_ask', subject: ctx.actor.userId, limit: 12, windowSeconds: 300 });
    const result = await askRobot(ctx.db, { mind: robotMind(), deskEmail: robotDeskEmail() }, { userId: ctx.actor.userId, channel: 'APP', text });
    return { ok: true, result };
  } catch (e) {
    return failure(e, new Set(['INVALID_ARGUMENT']));
  }
}

export async function setRobotConsentAction(input: { outreach: RobotConsent }, key: string): Promise<CommandResult<{ outreach: RobotConsent }>> {
  return runWorkspaceCommand((ctx) => setRobotConsent(ctx.actor), { outreach: input.outreach }, { name: 'robot.consent', idempotencyKey: key, financial: false });
}

export async function snoozeRobotAction(input: { playbook: string }, key: string): Promise<CommandResult<{ until: string }>> {
  return runWorkspaceCommand((ctx) => snoozeRobot(ctx.actor), { playbook: input.playbook, days: 7 }, { name: 'robot.snooze', idempotencyKey: key, financial: false });
}

export async function markRobotSeenAction(input: { key: string }): Promise<CommandResult<null>> {
  try {
    const ctx = await workspaceContext();
    await markRobotSeen(ctx.db, ctx.actor.userId, input.key);
    return { ok: true, result: null };
  } catch (e) {
    return failure(e);
  }
}
