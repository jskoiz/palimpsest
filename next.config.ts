import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // vinext classifies multipart route requests alongside Server Actions.
      // Artwork source and mask PNGs can legitimately exceed the 1 MB default.
      bodySizeLimit: "12mb",
    },
  },
};

export default nextConfig;
