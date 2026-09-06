import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@cloud-worker/shared"],
};

export default nextConfig;
