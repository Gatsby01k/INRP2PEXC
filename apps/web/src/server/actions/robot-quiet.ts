'use server';

import { executeCommand, hitRateLimit } from '@inrp2p/commands';
import { quietByEmailLink } from '@inrp2p/robot';
import { callerIpHash } from '../link.ts';
import { getRuntime } from '../runtime.ts';

/**
 * The robot email's own stop link (ADR 0034 §2.4), pressed: no session, so the link is the whole authority — it stops
 * the robot's messages to the person it was sent to and nothing else. Counted per caller so the token cannot be guessed
 * at speed (it is 192 random bits besides).
 */
export async function stopRobotByLinkAction(input: { link: string }): Promise<{ stopped: boolean }> {
  const rt = getRuntime();
  try {
    await hitRateLimit(rt.appDb, { bucket: 'robot_quiet_link', subject: await callerIpHash(), limit: 10, windowSeconds: 600 });
    const out = await executeCommand(rt.appDb, quietByEmailLink(), {
      name: 'robot.quiet_link', actor: { type: 'SYSTEM', id: null, surface: 'SYSTEM' }, payload: { link: String(input.link).slice(0, 120) }, idempotencyKey: null, financial: false,
    });
    return out.result;
  } catch {
    return { stopped: false };
  }
}
