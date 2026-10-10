import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../src/deployment.ts';
import { loadMigrations } from '../src/migrate.ts';

describe('the schema version a release is built for', () => {
  it('is the last migration file, so a release never serves a schema it was not built for', async () => {
    const migrations = await loadMigrations();
    expect(SCHEMA_VERSION).toBe(migrations.at(-1)!.version);
  });
});
