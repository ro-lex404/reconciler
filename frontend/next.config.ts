import type { NextConfig } from "next";

const backendInternalUrl = process.env.BACKEND_INTERNAL_URL || "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/finance/:path*",
        destination: `${backendInternalUrl}/finance/:path*`,
      },
      {
        source: "/chat",
        destination: `${backendInternalUrl}/chat`,
      },
      {
        source: "/upload",
        destination: `${backendInternalUrl}/upload`,
      },
      {
        source: "/pdf-reconciliation/:path*",
        destination: `${backendInternalUrl}/pdf-reconciliation/:path*`,
      },
      {
        source: "/reconciliation/:path*",
        destination: `${backendInternalUrl}/reconciliation/:path*`,
      },
    ];
  },
};

export default nextConfig;
