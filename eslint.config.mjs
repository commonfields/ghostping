// Real lint: scans all hosted TypeScript/React sources. CI runs `pnpm lint`
// (recursive) and fails on any error or warning (--max-warnings 0).
// Deliberately the non-type-checked recommended set plus hygiene rules:
// semantic/static checks without formatting churn on pre-existing code.
import tseslint from "typescript-eslint"
import reactHooks from "eslint-plugin-react-hooks"

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/target/**", "tauri-app/**", "website/**"],
  },
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: ["apps/*/src/**/*.ts", "apps/web/app/**/*.ts", "apps/web/app/**/*.tsx", "apps/web/tests/**/*.ts", "packages/*/src/**/*.ts", "packages/*/test/**/*.ts", "packages/*/scripts/**/*.ts"],
  })),
  {
    files: ["apps/*/src/**/*.ts", "apps/web/app/**/*.ts", "apps/web/app/**/*.tsx", "apps/web/tests/**/*.ts", "packages/*/src/**/*.ts", "packages/*/test/**/*.ts", "packages/*/scripts/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["apps/web/app/**/*.ts", "apps/web/app/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...(reactHooks.configs["recommended-latest"]?.rules ?? {}),
    },
  },
  {
    files: ["**/*.test.ts", "apps/web/tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
)
