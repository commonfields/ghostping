import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"
export default defineConfig({
  test: { include: ["tests/**/*.test.ts", "app/**/*.test.ts"] },
  resolve: { alias: { "@": fileURLToPath(new URL("./app", import.meta.url)) } },
})
