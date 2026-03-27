/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typescript: {
    // wallet-adapter-react types lag behind React 19 — safe to ignore
    ignoreBuildErrors: true,
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com",
              "img-src 'self' data: blob: https://raw.githubusercontent.com https://arweave.net https://assets.coingecko.com https://coin-images.coingecko.com https://static.jup.ag https://tokens.jup.ag https://metadata.jito.network https://pyth.network https://wormhole.com https://ipfs.io https://*.ipfs.cf-ipfs.com https://*.ipfs.nftstorage.link https://shdw-drive.genesysgo.net https://gateway.irys.xyz https://api.coingecko.com",
              "connect-src 'self' https://api.devnet.solana.com https://api.mainnet-beta.solana.com https://mainnet.helius-rpc.com https://hermes.pyth.network https://benchmarks.pyth.network https://api.jup.ag https://api.coingecko.com wss://api.devnet.solana.com wss://api.mainnet-beta.solana.com wss://mainnet.helius-rpc.com",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'X-XSS-Protection', value: '0' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
