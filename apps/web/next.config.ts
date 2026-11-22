import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: [
    '@inrp2p/kernel', '@inrp2p/db', '@inrp2p/audit', '@inrp2p/identity', '@inrp2p/commands', '@inrp2p/ui', '@inrp2p/desk',
    '@inrp2p/settlement', '@inrp2p/quotes', '@inrp2p/clients', '@inrp2p/pricing', '@inrp2p/routes',
    '@inrp2p/treasury', '@inrp2p/trades', '@inrp2p/adapters', '@inrp2p/outbox', '@inrp2p/ledger',
  ],
  serverExternalPackages: ['pg', 'graphile-worker'],
  typescript: { tsconfigPath: './tsconfig.json' },
  experimental: {
    // ADR 0023: a receipt attached in a deal's chat is up to 3 MB; the command checks the bytes, this only lets them in.
    serverActions: { bodySizeLimit: '4mb' },
    // Stylesheets are cut by which pages use them together. The default merges freely to save requests, and the home
    // page shipped the workspace's, the desk's and /traders' styles with its own: 384 KB of CSS, two thirds of it
    // unused, all of it read before the first paint. Here a request is worth 30 KB of styles nobody uses, which
    // takes the home page to 160 KB without the others and keeps a page's stylesheets to a handful.
    cssChunking: { type: 'graph', requestCost: 30000 },
  },
};

export default config;
