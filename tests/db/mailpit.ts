// Reads auth emails from the local stack's mail catcher (Mailpit, port 54324)
// so tests can follow invite, magic-link and recovery links like a user.
const MAILPIT_URL = process.env.CUPO_MAILPIT_URL ?? "http://127.0.0.1:54324";

type MailpitSummary = { ID: string; Created: string };


async function search(email: string): Promise<MailpitSummary[]> {
  const query = encodeURIComponent(`to:"${email}"`);
  const response = await fetch(`${MAILPIT_URL}/api/v1/search?query=${query}&limit=50`);
  if (!response.ok) throw new Error(`mailpit search failed: ${response.status}`);
  const body = (await response.json()) as { messages?: MailpitSummary[] };
  return body.messages ?? [];
}

export async function countMessagesTo(email: string): Promise<number> {
  return (await search(email)).length;
}

export type AuthLink = { href: string; tokenHash: string; type: string };

/**
 * Waits until `email` has more than `seenBefore` messages (take the count with
 * countMessagesTo() before triggering the mail) and returns the newest
 * message's /auth/confirm link. Counting instead of comparing timestamps keeps
 * an older message from being mistaken for the new one.
 */
export async function waitForAuthLink(email: string, seenBefore: number, timeoutMs = 10_000): Promise<AuthLink> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await search(email);
    if (messages.length > seenBefore) {
      const newest = [...messages].sort((a, b) => b.Created.localeCompare(a.Created))[0];
      const response = await fetch(`${MAILPIT_URL}/api/v1/message/${newest.ID}`);
      const message = (await response.json()) as { HTML: string };
      const href = /href="([^"]*\/auth\/confirm\?[^"]+)"/.exec(message.HTML)?.[1]?.replace(/&amp;/g, "&");
      if (!href) throw new Error(`no /auth/confirm link in the message to ${email}`);
      const url = new URL(href);
      return { href, tokenHash: url.searchParams.get("token_hash") ?? "", type: url.searchParams.get("type") ?? "" };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no new email to ${email} within ${timeoutMs} ms`);
}
