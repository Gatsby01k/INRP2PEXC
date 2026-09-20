/**
 * Verifies the approved version matrix (docs/DEPENDENCIES.md): exact pins in every package.json,
 * installed versions equal the pins, Node runtime and pnpm match, engines satisfied.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

export const MATRIX: Record<string, string> = {
  node: '24.21.0',
  pnpm: '12.4.2',
  typescript: '6.0.3',
  next: '16.3.5',
  react: '19.3.0',
  'react-dom': '19.3.0',
  'better-auth': '1.7.5',
  '@better-auth/utils': '0.4.2',
  kysely: '0.29.6',
  pg: '8.23.0',
  'graphile-worker': '0.18.0',
  vitest: '5.0.1',
  vite: '8.3.0',
  '@testcontainers/postgresql': '12.1.0',
  eslint: '10.10.0',
  'typescript-eslint': '8.70.0',
  '@eslint/js': '10.0.1',
  '@types/node': '24.13.5',
  '@types/pg': '8.23.1',
  '@types/react': '19.3.0',
  '@types/react-dom': '19.3.0',
  'server-only': '0.0.1',
  // Phase 1.5 design system
  storybook: '10.6.0',
  '@storybook/react-vite': '10.6.0',
  '@storybook/addon-a11y': '10.6.0',
  // Pinned to the Chromium revision the visual baselines were recorded with (docs/DEPENDENCIES.md).
  '@playwright/test': '1.56.1',
  // The PDF renderer drives the same pinned Chromium the pixel baselines use, so a printed receipt and a
  // captured page are the same browser.
  'playwright-core': '1.56.1',
  '@axe-core/playwright': '4.13.0',
  uqr: '0.1.3',
  // Phase 7: the quote link is opened on a phone, so its mobile budget is measured rather than assumed.
  lighthouse: '13.4.1',
};
export const POSTGRES = '18.6';

const root = path.resolve(import.meta.dirname, '..');
const manifests = ['package.json', ...['packages', 'apps'].flatMap((d) => readdirSync(path.join(root, d)).map((p) => path.join(d, p, 'package.json')))].filter((p) => existsSync(path.join(root, p)));
const problems: string[] = [];

if (process.versions.node !== MATRIX.node) problems.push(`node ${process.versions.node} != ${MATRIX.node}`);
const rootPkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
if (rootPkg.packageManager !== `pnpm@${MATRIX.pnpm}`) problems.push(`packageManager ${rootPkg.packageManager} != pnpm@${MATRIX.pnpm}`);
if (rootPkg.engines?.node !== MATRIX.node) problems.push(`engines.node ${rootPkg.engines?.node} != ${MATRIX.node}`);

for (const m of manifests) {
  const pkg = JSON.parse(readFileSync(path.join(root, m), 'utf8'));
  for (const field of ['dependencies', 'devDependencies'] as const) {
    for (const [name, spec] of Object.entries<string>(pkg[field] ?? {})) {
      if (spec.startsWith('workspace:')) continue;
      if (!/^\d+\.\d+\.\d+$/.test(spec)) problems.push(`${m} ${name}@${spec} is not an exact pin`);
      if (MATRIX[name] && MATRIX[name] !== spec) problems.push(`${m} ${name}@${spec} != approved ${MATRIX[name]}`);
      if (!MATRIX[name]) problems.push(`${m} ${name} is not in the approved matrix`);
      const installed = path.join(root, path.dirname(m), 'node_modules', name, 'package.json');
      if (existsSync(installed)) {
        const v = JSON.parse(readFileSync(installed, 'utf8')).version;
        if (v !== spec) problems.push(`${m} ${name} installed ${v} != pinned ${spec}`);
      }
    }
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`version matrix OK (${manifests.length} manifests); PostgreSQL ${POSTGRES} enforced by CI via REQUIRE_PG_VERSION`);
