import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  distDir: process.env.COVEREDYOU_E2E_AUTH_ISOLATED === "1" ? ".next-playwright" : ".next",
};

export default nextConfig;
