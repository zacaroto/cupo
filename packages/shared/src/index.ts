// @cupo/shared: framework-free code shared by apps/web (and apps/worker in Phase 2).
// Schemas are imported by path (`@cupo/shared/schemas/auth`) so consumers that
// only need the permission map do not load Zod.
export const CUPO = "cupo" as const;

export type { Database, Json } from "./database.types.ts";
export * from "./permissions";
export * from "./errors";
