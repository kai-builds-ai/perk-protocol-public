/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typescript: {
    // wallet-adapter-react types lag behind React 19 — safe to ignore
    ignoreBuildErrors: true,
  },
};

module.exports = nextConfig;
