import type { NextConfig } from "next";

const API_BACKEND_URL = process.env.API_INTERNAL_URL || "http://127.0.0.1:3001";

const nextConfig: NextConfig = {
  transpilePackages: ["@cloud-worker/shared"],
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${API_BACKEND_URL}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
