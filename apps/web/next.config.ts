import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: [
    '@inrp2p/kernel', '@inrp2p/db', '@inrp2p/audit', '@inrp2p/identity', '@inrp2p/commands', '@inrp2p/ui', '@inrp2p/desk',
    '@inrp2p/settlement', '@inrp2p/quotes', '@inrp2p/clients', '@inrp2p/inr-accounts', '@inrp2p/pricing', '@inrp2p/routes',
    '@inrp2p/treasury', '@inrp2p/trades', '@inrp2p/adapters', '@inrp2p/outbox', '@inrp2p/ledger',
  ],
  serverExternalPackages: ['pg', 'graphile-worker'],
  typescript: { tsconfigPath: './tsconfig.json' },
};

export default config;
