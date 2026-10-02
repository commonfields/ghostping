import { defineConfig } from "vitest/config"
// Integration files share one database (and one re-runs migrations), so
// files run serially.
export default defineConfig({ test: { include: ["src/**/*.test.ts"], testTimeout: 30000, fileParallelism: false } })
