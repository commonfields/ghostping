import { defineConfig } from "vitest/config"
// Integration files share one database, so files run serially
// (same precedent as packages/db/vitest.config.ts).
export default defineConfig({ test: { include: ["src/**/*.test.ts"], testTimeout: 30000, fileParallelism: false } })
