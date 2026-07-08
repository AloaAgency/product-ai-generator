import type { NextConfig } from "next";
import { SECURITY_HEADERS } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  // Strip X-Powered-By: Next.js to avoid leaking framework info
  poweredByHeader: false,
  // sharp ships its native libvips binary as a platform-specific optional dep
  // (@img/sharp-linux-x64 on Vercel). Force the linux binaries into every API
  // function's trace so image generation / thumbnailing / reference processing
  // don't 500 with "Could not load the sharp module using the linux-x64 runtime".
  serverExternalPackages: ['sharp'],
  // Pin the trace root to this project so the include globs below resolve from
  // here (a stray parent lockfile otherwise makes Next infer the wrong root).
  outputFileTracingRoot: process.cwd(),
  outputFileTracingIncludes: {
    '/api/**': [
      './node_modules/@img/sharp-linux-x64/**',
      './node_modules/@img/sharp-libvips-linux-x64/**',
    ],
  },
  experimental: {
    proxyClientMaxBodySize: '50mb',
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: Array.from(SECURITY_HEADERS),
      },
    ]
  },
};

export default nextConfig;
