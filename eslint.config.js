// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Allowed internal dependencies per package (ARCHITECTURE §3 dependency rule). */
const BOUNDARIES = {
  kernel: [],
  db: ['kernel'],
  audit: ['kernel', 'db'],
  ledger: ['kernel', 'db'],
  outbox: ['kernel', 'db'],
  commands: ['kernel', 'db', 'audit'],
  identity: ['kernel', 'db', 'audit'],
  // Ports and provider implementations; depends on nothing domain-specific.
  adapters: ['kernel'],
  // Phase 2 reference-data modules (ARCHITECTURE §3): talk to each other only through public APIs.
  clients: ['kernel', 'db', 'audit', 'identity', 'outbox', 'adapters'],
  'inr-accounts': ['kernel', 'db', 'audit', 'identity', 'outbox', 'adapters'],
  routes: ['kernel', 'db', 'audit', 'identity'],
  pricing: ['kernel', 'db', 'audit', 'identity', 'routes'],
  treasury: ['kernel', 'db', 'audit', 'identity', 'outbox', 'adapters'],
  // Phase 3 trade lifecycle modules (ARCHITECTURE §3).
  trades: ['kernel', 'db', 'audit', 'ledger', 'routes'],
  // Phase 4 settlement: drives trades, movements, route obligations, capacity and treasury through their APIs.
  settlement: ['kernel', 'db', 'audit', 'identity', 'outbox', 'adapters', 'commands', 'ledger', 'clients', 'inr-accounts', 'routes', 'treasury', 'trades'],
  quotes: ['kernel', 'db', 'audit', 'identity', 'outbox', 'adapters', 'commands', 'ledger', 'clients', 'routes', 'pricing', 'treasury', 'trades'],
  // Phase 5 chain monitoring: reads the chain through adapters and drives settlement through its public API.
  scanner: ['kernel', 'db', 'audit', 'identity', 'adapters', 'commands', 'ledger', 'clients', 'inr-accounts', 'routes', 'treasury', 'trades', 'settlement', 'pricing', 'quotes', 'outbox'],
  // Design system: formats kernel Money/Rate values; never touches persistence or domain modules.
  ui: ['kernel'],
};
const ALL = Object.keys(BOUNDARIES);

/** Money must never pass through floating point (FINANCIAL_INVARIANTS §1.1). */
const NO_FLOAT_MONEY = [
  { selector: "CallExpression[callee.name='parseFloat']", message: 'parseFloat is forbidden in financial code; use kernel decimal parsing.' },
  { selector: "CallExpression[callee.object.name='Number'][callee.property.name='parseFloat']", message: 'Number.parseFloat is forbidden in financial code.' },
  { selector: "CallExpression[callee.name='Number']", message: 'Number() coercion is forbidden in financial code; use bigint minor units.' },
  { selector: "CallExpression[callee.property.name='toFixed']", message: 'toFixed is forbidden in financial code; use kernel formatting.' },
  { selector: "CallExpression[callee.object.name='Math'][callee.property.name=/^(round|floor|ceil|trunc)$/]", message: 'Math rounding is forbidden in financial code; use kernel divRound.' },
];

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/.next/**', '**/dist/**', 'docs/**', 'apps/web/next-env.d.ts', '**/storybook-static/**', '**/playwright-report/**', '**/test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-imports': ['error', { patterns: [{ group: ['@inrp2p/*/src/*', '@inrp2p/*/test/*'], message: 'Import packages through their public entry points.' }] }],
      eqeqeq: ['error', 'always'],
    },
  },
  ...Object.entries(BOUNDARIES).map(([pkg, allowed]) => ({
    files: [`packages/${pkg}/src/**/*.ts`, `packages/${pkg}/src/**/*.tsx`],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@inrp2p/*/src/*', '@inrp2p/*/test/*'], message: 'Import packages through their public entry points.' },
          ...ALL.filter((p) => p !== pkg && !allowed.includes(p)).map((p) => ({ group: [`@inrp2p/${p}`, `@inrp2p/${p}/*`], message: `packages/${pkg} must not depend on @inrp2p/${p} (ARCHITECTURE §3).` })),
          { group: ['@inrp2p/web', '@inrp2p/worker'], message: 'Packages must not depend on apps.' },
        ],
      }],
    },
  })),
  {
    files: ['packages/kernel/src/**/*.ts', 'packages/ledger/src/**/*.ts', 'packages/commands/src/**/*.ts', 'packages/ui/src/format/money.ts', 'packages/ui/src/format/number.ts', 'packages/inr-accounts/src/**/*.ts', 'packages/pricing/src/**/*.ts', 'packages/routes/src/**/*.ts', 'packages/treasury/src/**/*.ts', 'packages/clients/src/**/*.ts', 'packages/trades/src/**/*.ts', 'packages/quotes/src/**/*.ts', 'packages/settlement/src/**/*.ts', 'packages/scanner/src/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', ...NO_FLOAT_MONEY] },
  },
  {
    files: ['**/test/**/*.ts', 'test/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', 'no-restricted-imports': 'off' },
  },
);
