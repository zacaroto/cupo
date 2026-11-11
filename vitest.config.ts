import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("./", import.meta.url));
const webSrc = fileURLToPath(new URL("./apps/web/src", import.meta.url));
const dbSetup = fileURLToPath(new URL("./tests/db/setup.ts", import.meta.url));

// Two projects (KTD11):
// - unit: pure logic in apps/web/src and packages/shared/src, no database.
// - db: the isolation, role and concurrency suite in tests/db against the local
//   Supabase stack (U2 fills tests/db/setup.ts and the helpers). Files run
//   serially: `fileParallelism` is root-only in Vitest, so the `test:db` script
//   passes `--no-file-parallelism` instead of setting it per project.
export default defineConfig({
  test: {
    projects: [
      {
        resolve: {
          alias: { "@": webSrc },
        },
        test: {
          name: "unit",
          root,
          environment: "node",
          include: [
            "apps/web/src/**/*.test.ts",
            "packages/shared/src/**/*.test.ts",
          ],
        },
      },
      {
        resolve: {
          alias: { "@": webSrc },
        },
        test: {
          name: "db",
          root,
          environment: "node",
          include: ["tests/db/**/*.test.ts"],
          testTimeout: 20_000,
          hookTimeout: 30_000,
          setupFiles: [dbSetup],
        },
      },
    ],
  },
});
