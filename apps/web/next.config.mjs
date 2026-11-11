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
  async redirects() {
    return [
      // U1 only: there is no src/proxy.ts yet, so "/" has nothing to send it to
      // the default locale. U3 ships the proxy (updateSession + handleI18nRouting,
      // KTD9) which owns locale detection; remove this entry in U3.
      { source: "/", destination: "/es", permanent: false },
    ];
  },
};

export default withNextIntl(nextConfig);
