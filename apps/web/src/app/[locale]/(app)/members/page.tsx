import { can } from "@cupo/shared/permissions";
import { getFormatter, getTranslations } from "next-intl/server";
import { ActionButton } from "@/components/forms/action-button";
import { InviteMemberForm } from "@/components/forms/invite-member-form";
import { MemberRoleForm } from "@/components/members/member-role-form";
import { Link } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { listMembers } from "@/lib/dal/members";
import { requirePageContext } from "@/lib/dal/page";
import { removeMemberAction, resendAccessAction } from "./actions";

type Props = { params: Promise<{ locale: string }> };

// Members of the active operator (U4, R9, R12). Administrador only.
export default async function MembersPage({ params }: Props) {
  const locale = await pageLocale(params);
  const ctx = await requirePageContext(locale, "members.read");
  const [t, common, format, members] = await Promise.all([
    getTranslations("members"),
    getTranslations("common"),
    getFormatter(),
    listMembers(ctx),
  ]);
  const canInvite = can(ctx.role, "members.invite");
  const canWrite = can(ctx.role, "members.write");

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-heading font-semibold tracking-tight text-text">{t("title")}</h1>
        <p className="text-small text-muted">{t("description")}</p>
      </header>

      {canInvite ? (
        <div className="flex flex-col gap-3 rounded border border-border bg-surface p-4">
          <h2 className="text-small font-semibold text-text">{t("invite.title")}</h2>
          <InviteMemberForm />
        </div>
      ) : null}

      {members.length === 0 ? (
        <p className="text-small text-muted">{t("table.empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded border border-border bg-surface">
          <table className="w-full text-left text-small">
            <caption className="sr-only">{t("table.caption")}</caption>
            <thead className="border-b border-border text-label text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">{t("table.person")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("table.role")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("table.since")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => {
                const name = member.fullName ?? member.email ?? t("table.noName");
                return (
                  <tr key={member.id} className="border-b border-rule align-top last:border-b-0" data-member-id={member.id}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-text">
                        {name}
                        {member.isSelf ? <span className="ml-2 text-label text-muted">({t("table.you")})</span> : null}
                      </div>
                      {member.email && member.email !== name ? <div className="text-label text-muted">{member.email}</div> : null}
                    </td>
                    <td className="px-3 py-2">
                      {member.role === "guia" || !canWrite ? (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-text">{common(`roles.${member.role}`)}</span>
                          {member.guide ? (
                            <Link href={`/guides/${member.guide.id}`} className="text-label text-accent hover:underline">
                              {t("table.guideOf", { name: member.guide.name })}
                            </Link>
                          ) : null}
                        </div>
                      ) : (
                        <MemberRoleForm membershipId={member.id} role={member.role} memberName={name} />
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted">
                      {format.dateTime(new Date(member.createdAt), { dateStyle: "medium", timeZone: ctx.operator.timezone })}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-2">
                        {canInvite ? (
                          <ActionButton
                            action={resendAccessAction}
                            fields={{ membershipId: member.id }}
                            label={t("actions.resend")}
                            doneMessage={t("actions.resent")}
                          />
                        ) : null}
                        {canWrite ? (
                          <ActionButton
                            action={removeMemberAction}
                            fields={{ membershipId: member.id }}
                            label={t("actions.remove")}
                            confirmMessage={t("actions.removeConfirm", { name })}
                            tone="danger"
                          />
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
