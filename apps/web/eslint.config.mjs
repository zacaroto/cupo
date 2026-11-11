import { fileURLToPath } from "node:url";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const rootDir = fileURLToPath(new URL("./", import.meta.url));

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["**/*.{js,jsx,mjs,ts,tsx}"],
    settings: {
      // Explicit app root so @next/next rules resolve pages/app from the
      // workspace, not from wherever eslint happens to be launched (monorepo).
      next: { rootDir },
    },
    rules: {
      // KTD12: navigation goes through the locale-aware wrappers.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "next/link",
              message: "Use Link from @/i18n/navigation (locale-aware).",
            },
            {
              name: "next/navigation",
              importNames: ["redirect", "permanentRedirect", "usePathname", "useRouter"],
              message: "Use redirect/usePathname/useRouter from @/i18n/navigation (locale-aware).",
            },
          ],
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
