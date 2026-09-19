import type { FullConfig } from '@playwright/test';
import { UPDATE_REQUESTED, guard, record } from './environment.ts';

/** Environment mismatch guard: refuses to compare or record pixels outside the canonical environment. */
export default async function globalSetup(_config: FullConfig): Promise<void> {
  const env = await guard();
  if (env && UPDATE_REQUESTED) process.env.VISUAL_ENV_JSON = JSON.stringify(env);
}

export { record as writeMetadata };
