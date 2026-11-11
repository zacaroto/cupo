// Guide registry of the active operator (U4, R19). Reads and writes run with
// the caller's session; RLS lets staff read and administradores write, and a
// guía read only their own row. Takes `ctx`, never resolves it (KTD3).
import "server-only";
import type { GuideInput } from "@cupo/shared/schemas/guides";
import { createClient } from "@/lib/supabase/server";
import type { OperatorContext } from "./context";
import { NotFoundError } from "./errors";

export type GuideRecord = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  languages: string[];
  specialties: string[];
  maxDailyHours: number | null;
  active: boolean;
  /** The linked auth account, if access was ever sent. */
  userId: string | null;
};

const COLUMNS = "id, name, email, phone, languages, specialties, max_daily_hours, active, user_id";

type GuideRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  languages: string[];
  specialties: string[];
  max_daily_hours: number | null;
  active: boolean;
  user_id: string | null;
};

function toRecord(row: GuideRow): GuideRecord {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    languages: row.languages,
    specialties: row.specialties,
    maxDailyHours: row.max_daily_hours,
    active: row.active,
    userId: row.user_id,
  };
}

function toColumns(input: GuideInput) {
  return {
    name: input.name,
    email: input.email,
    phone: input.phone,
    languages: input.languages,
    specialties: input.specialties,
    max_daily_hours: input.maxDailyHours,
  };
}

/** Active guides first, then by name. */
export async function listGuides(ctx: OperatorContext): Promise<GuideRecord[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("guides")
    .select(COLUMNS)
    .eq("operator_id", ctx.operator.id)
    .order("active", { ascending: false })
    .order("name", { ascending: true });
  if (error) throw error;
  return data.map(toRecord);
}

export async function getGuide(ctx: OperatorContext, guideId: string): Promise<GuideRecord | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("guides")
    .select(COLUMNS)
    .eq("operator_id", ctx.operator.id)
    .eq("id", guideId)
    .maybeSingle();
  if (error) throw error;
  return data ? toRecord(data) : null;
}

/** Creates a guide; a contact email already used in the operator raises 23505 (`duplicate`). */
export async function createGuide(ctx: OperatorContext, input: GuideInput): Promise<string> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("guides")
    .insert({ operator_id: ctx.operator.id, ...toColumns(input) })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function updateGuideRow(
  ctx: OperatorContext,
  guideId: string,
  values: Partial<ReturnType<typeof toColumns>> & { active?: boolean; user_id?: string | null },
): Promise<void> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("guides")
    .update(values)
    .eq("operator_id", ctx.operator.id)
    .eq("id", guideId)
    .select("id");
  if (error) throw error;
  if (data.length === 0) throw new NotFoundError("guide");
}

export function updateGuide(ctx: OperatorContext, guideId: string, input: GuideInput): Promise<void> {
  return updateGuideRow(ctx, guideId, toColumns(input));
}

/** Deactivating also revokes the guía membership, in the same statement (t80 trigger). */
export function setGuideActive(ctx: OperatorContext, guideId: string, active: boolean): Promise<void> {
  return updateGuideRow(ctx, guideId, { active });
}

/** Links (or unlinks) the guide's account; refused with `guide_has_access` while the old account holds the guía role. */
export function linkGuideAccount(ctx: OperatorContext, guideId: string, userId: string | null): Promise<void> {
  return updateGuideRow(ctx, guideId, { user_id: userId });
}
