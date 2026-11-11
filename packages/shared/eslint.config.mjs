import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// KTD15: packages/shared is consumed by apps/web now and by apps/worker later.
// It must stay free of Next, React, request-scoped code and Supabase clients.
const forbiddenMessage =
  "@cupo/shared must not depend on Next, React, next-intl, server-only or Supabase clients (KTD15).";

export default defineConfig([
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "next", message: forbiddenMessage },
            { name: "next-intl", message: forbiddenMessage },
            { name: "react", message: forbiddenMessage },
            { name: "react-dom", message: forbiddenMessage },
            { name: "server-only", message: forbiddenMessage },
            { name: "@supabase/ssr", message: forbiddenMessage },
            { name: "@supabase/supabase-js", message: forbiddenMessage },
          ],
          patterns: [
            { group: ["next/*", "next-intl/*", "react/*", "react-dom/*", "@supabase/*"], message: forbiddenMessage },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "process", message: "@cupo/shared must not read process.env; pass values in explicitly (KTD15)." },
        { name: "FormData", message: "@cupo/shared validates plain objects; the server action converts FormData first (KTD15)." },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  globalIgnores(["node_modules/**", "dist/**"]),
]);
