import path from "node:path";
import { fileURLToPath } from "node:url";
import createNextIntlPlugin from "next-intl/plugin";

// .mjs on purpose (KTD9): a next.config.ts would pull @swc/core into the build path.
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    // The workspace root (root package-lock.json), so @cupo/shared resolves and
    // Turbopack does not warn about multiple lockfiles.
    root: repoRoot,
  },
  // "/" -> "/es" is handled by src/proxy.ts (next-intl, localeDetection off).
};

export default withNextIntl(nextConfig);
