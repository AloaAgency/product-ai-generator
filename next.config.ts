import type { NextConfig } from "next";
import { SECURITY_HEADERS } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  // Strip X-Powered-By: Next.js to avoid leaking framework info
  poweredByHeader: false,
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
