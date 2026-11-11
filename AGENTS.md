<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# cupo — agent notes

- Monorepo: `apps/web` (`@cupo/web`, Next.js 16) and `packages/shared` (`@cupo/shared`, framework-free TypeScript consumed as source). The Next.js docs above live at `node_modules/next/dist/docs/` at the repo root (npm workspaces hoist `next`; there is no `apps/web/node_modules/next`).
- Read `README.md` for setup and scripts, `REVIEW.md` for the review priorities and the multi-tenant rules, and `docs/plans/` for the implementation plan.
- Verification before claiming a unit done: `npm run lint`, `npm run typecheck`, `npm run test:unit`, `npm run build -w @cupo/web`.
