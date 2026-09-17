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
  { ignores: ['**/node_modules/**', '**/.next/**', '**/dist/**', 'docs/**', 'apps/web/next-env.d.ts'] },
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
    files: [`packages/${pkg}/src/**/*.ts`],
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
    files: ['packages/kernel/src/**/*.ts', 'packages/ledger/src/**/*.ts', 'packages/commands/src/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', ...NO_FLOAT_MONEY] },
  },
  {
    files: ['**/test/**/*.ts', 'test/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', 'no-restricted-imports': 'off' },
  },
);
