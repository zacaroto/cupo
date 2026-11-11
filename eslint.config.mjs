import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// Root-level TypeScript outside the workspaces: the db test project, scripts
// and the Vitest config. Each workspace lints itself via `npm run lint -w`.
export default defineConfig([
  globalIgnores(["apps/**", "packages/**", "node_modules/**", ".agents/**", ".claude/**"]),
  ...tseslint.configs.recommended,
  {
    files: ["tests/**/*.ts", "scripts/**/*.ts", "vitest.config.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
]);
