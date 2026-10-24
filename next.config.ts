import type { NextConfig } from "next";

// cacheComponents / partialPrefetching are intentionally off: every page here is
// authenticated and dynamic, so there is nothing worth caching or prerendering.
const nextConfig: NextConfig = {
  // /api/preflight compares the DB's applied migrations with the migration folders,
  // so those files must be bundled into that function.
  outputFileTracingIncludes: {
    "/api/preflight": ["./prisma/migrations/**/*"],
  },
};

export default nextConfig;
