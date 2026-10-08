import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next 16.4 blocks dev-only resources (/_next/hmr, dev chunks) requested
  // from any origin other than localhost. Without this, a page opened at
  // http://127.0.0.1:<port> -- which is what Playwright uses (see
  // playwright.config.ts) -- never hydrates, so every test just times out
  // waiting for the sign-in form. Dev-only; has no effect on `next build`.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
