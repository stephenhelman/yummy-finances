import "dotenv/config";
import { defineConfig } from "prisma/config";

// Migrations and seeding run over the direct (non-pooled) connection, from a developer machine.
// DIRECT_URL is deliberately NOT required to build or run the app (`prisma generate` needs no
// database), so the Vercel project never has to hold it. Commands that do touch the database
// fail with an empty-URL error if it is missing; nothing falls back to another URL.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DIRECT_URL ?? "",
  },
});
