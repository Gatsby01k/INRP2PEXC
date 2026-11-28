'use server';

import { revalidatePath } from 'next/cache';
import type { RobotAnswers, RobotOutreach } from '@inrp2p/db';
import { answerRobotCase, closeRobotCase, setRobotPolicy } from '@inrp2p/robot';
import { type CommandResult, runCommand } from '../command.ts';

/**
 * The desk's side of the robot (ADR 0034): what it may do on its own (the owner, with step-up and a reason), and the
 * questions it passed to a person — answered, or closed with a reason.
 */
export async function setRobotPolicyAction(
  input: { expectedPolicyId: string; reason: string; outreach?: RobotOutreach; answers?: RobotAnswers; quietFrom?: number; quietTo?: number; aiDailyLimit?: number; playbooksOff?: string[] },
  key: string,
): Promise<CommandResult<{ id: string }>> {
  const out = await runCommand((ctx) => setRobotPolicy(ctx.actor), input, { name: 'robot_policy.set', idempotencyKey: key, financial: false });
  if (out.ok) revalidatePath('/robot-desk');
  return out;
}

export async function answerRobotCaseAction(input: { caseRef: string; answer: string }, key: string): Promise<CommandResult<{ ref: string }>> {
  const out = await runCommand((ctx) => answerRobotCase(ctx.actor), input, { name: 'robot.answer_case', idempotencyKey: key, financial: false });
  if (out.ok) revalidatePath('/robot-desk');
  return out;
}

export async function closeRobotCaseAction(input: { caseRef: string; reason: string }, key: string): Promise<CommandResult<{ ref: string }>> {
  const out = await runCommand((ctx) => closeRobotCase(ctx.actor), input, { name: 'robot.close_case', idempotencyKey: key, financial: false });
  if (out.ok) revalidatePath('/robot-desk');
  return out;
}
