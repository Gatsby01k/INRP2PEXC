import 'server-only';

/**
 * Every environment read on the server goes through here.
 *
 * The bundler substitutes a *static* `process.env.NAME` with the value it had when the app was **built**, so a
 * variable that only exists when the server **runs** silently becomes `undefined` in the built app — the base
 * URL falls back to a guess, a configured chain provider looks unconfigured. Reading through a computed key is
 * opaque to that substitution, so configuration is always the deployment's and never the build's.
 *
 * Empty is treated as absent: an unset variable and one set to "" must not mean different things.
 */
function read(name: string): string | undefined {
  const key = name;
  const value = process.env[key];
  return value === undefined || value === '' ? undefined : value;
}

export function optionalEnv(name: string): string | undefined {
  return read(name);
}

export function requiredEnv(name: string): string {
  const value = read(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** True only for the exact string `true`, so a typo can never enable something by accident. */
export function envFlag(name: string): boolean {
  return read(name) === 'true';
}
