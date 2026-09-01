import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone build so the Docker runtime stage ships without node_modules.
  output: "standalone",
  // better-sqlite3 is native and must not be bundled into the server chunks.
  serverExternalPackages: ["better-sqlite3"],
  /* config options here */
};

export default nextConfig;
