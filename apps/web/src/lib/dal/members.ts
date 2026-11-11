// Members of the active operator (U4, R3, R9, R12). Every query runs with the
// administrador's own session: RLS limits memberships to their operator and
// `auth.uid()` makes them the audit actor (KTD6). Like every domain module it
// takes `ctx` and never resolves the context itself (KTD3); the operator id
// comes from `ctx` only.
import "server-only";
import type { Role } from "@cupo/shared/permissions";
import { createClient } from "@/lib/supabase/server";
import type { OperatorContext } from "./context";
import { NotFoundError } from "./errors";

export type MemberSummary = {
  id: string;
  userId: string;
  role: Role;
  createdAt: string;
  email: string | null;
  fullName: string | null;
  /** The guide record a guía member is linked to. */
  guide: { id: string; name: string } | null;
  isSelf: boolean;
};

/** Memberships of the operator joined with `profiles` (two queries: no foreign key links them). */
export async function listMembers(ctx: OperatorContext): Promise<MemberSummary[]> {
  const supabase = await createClient();
  const { data: memberships, error } = await supabase
    .from("memberships")
    .select("id, user_id, role, created_at")
    .eq("operator_id", ctx.operator.id)
    .order("created_at", { ascending: true });
  if (error) throw error;
  if (memberships.length === 0) return [];

  const userIds = memberships.map((m) => m.user_id);
  const [profiles, guides] = await Promise.all([
    supabase.from("profiles").select("id, email, full_name").in("id", userIds),
    supabase.from("guides").select("id, name, user_id").eq("operator_id", ctx.operator.id).in("user_id", userIds),
  ]);
  if (profiles.error) throw profiles.error;
  if (guides.error) throw guides.error;

  const profileById = new Map(profiles.data.map((p) => [p.id, p]));
  const guideByUser = new Map(guides.data.map((g) => [g.user_id, g]));
  return memberships.map((m) => {
    const profile = profileById.get(m.user_id);
    const guide = m.role === "guia" ? guideByUser.get(m.user_id) : undefined;
    return {
      id: m.id,
      userId: m.user_id,
      role: m.role,
      createdAt: m.created_at,
      email: profile?.email ?? null,
      fullName: profile?.full_name ?? null,
      guide: guide ? { id: guide.id, name: guide.name } : null,
      isSelf: m.user_id === ctx.user.id,
    };
  });
}

/** One membership of the operator with the member's email, or null. */
export async function getMembership(
  ctx: OperatorContext,
  membershipId: string,
): Promise<{ id: string; userId: string; role: Role; email: string | null } | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("id, user_id, role")
    .eq("operator_id", ctx.operator.id)
    .eq("id", membershipId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("email")
    .eq("id", data.user_id)
    .maybeSingle();
  if (profileError) throw profileError;
  return { id: data.id, userId: data.user_id, role: data.role, email: profile?.email ?? null };
}

/** The user's membership in the operator, or null. */
export async function findMembershipOfUser(
  ctx: OperatorContext,
  userId: string,
): Promise<{ id: string; role: Role } | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("id, role")
    .eq("operator_id", ctx.operator.id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** User ids holding the guía role in the operator (for the guides "access" column). */
export async function listGuiaUserIds(ctx: OperatorContext): Promise<Set<string>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("user_id")
    .eq("operator_id", ctx.operator.id)
    .eq("role", "guia");
  if (error) throw error;
  return new Set(data.map((m) => m.user_id));
}

/**
 * Adds a member under the caller's session. A second membership for the same
 * user raises 23505 (`duplicate`); a guía without a linked guide raises
 * `guide_not_linked`. Returns the membership id.
 */
export async function insertMembership(ctx: OperatorContext, input: { userId: string; role: Role }): Promise<string> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("memberships")
    .insert({ user_id: input.userId, operator_id: ctx.operator.id, role: input.role })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

/** Changes a member's role; the last administrador is protected by the database (`last_administrador`). */
export async function updateMembershipRole(ctx: OperatorContext, membershipId: string, role: Role): Promise<void> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("memberships")
    .update({ role })
    .eq("operator_id", ctx.operator.id)
    .eq("id", membershipId)
    .select("id");
  if (error) throw error;
  if (data.length === 0) throw new NotFoundError("membership");
}

/** Removes a member; the last administrador is protected by the database (`last_administrador`). */
export async function deleteMembership(ctx: OperatorContext, membershipId: string): Promise<void> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("memberships")
    .delete()
    .eq("operator_id", ctx.operator.id)
    .eq("id", membershipId)
    .select("id");
  if (error) throw error;
  if (data.length === 0) throw new NotFoundError("membership");
}
