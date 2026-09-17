import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@inrp2p/kernel', '@inrp2p/db', '@inrp2p/audit', '@inrp2p/identity', '@inrp2p/commands'],
  serverExternalPackages: ['pg', 'graphile-worker'],
  typescript: { tsconfigPath: './tsconfig.json' },
};

export default config;
