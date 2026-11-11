// @cupo/shared: framework-free code shared by apps/web (and apps/worker in Phase 2).
// U3 adds permissions, errors, money, schemas and dto modules.
export const CUPO = "cupo" as const;

export type { Database, Json } from "./database.types.ts";
