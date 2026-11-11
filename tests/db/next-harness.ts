// Shared pieces for db tests that drive real server actions (U4): a browser
// cookie jar with the surface of Next's `cookies()` store, FormData and
// redirect helpers, and a fetch recorder. Each test file still declares its
// own vi.mock() calls (they are hoisted per file) and points `next/headers`
// at a jar from here. tests/db/auth.test.ts predates this module and keeps
// its inline copy.
import { vi } from "vitest";

type StoredCookie = { name: string; value: string; options: Record<string, unknown> };

export class CookieJar {
  readonly cookies = new Map<string, StoredCookie>();

  get(name: string) {
    const cookie = this.cookies.get(name);
    return cookie ? { name, value: cookie.value } : undefined;
  }

  getAll() {
    return [...this.cookies.values()].map(({ name, value }) => ({ name, value }));
  }

  has(name: string) {
    return this.cookies.has(name);
  }

  set(nameOrCookie: string | ({ name: string; value: string } & Record<string, unknown>), value?: string, options: Record<string, unknown> = {}) {
    const cookie =
      typeof nameOrCookie === "string"
        ? { name: nameOrCookie, value: value ?? "", options }
        : { name: nameOrCookie.name, value: nameOrCookie.value, options: nameOrCookie };
    if (cookie.value === "" || cookie.options.maxAge === 0) {
      this.cookies.delete(cookie.name);
    } else {
      this.cookies.set(cookie.name, cookie);
    }
    return this;
  }

  delete(name: string) {
    this.cookies.delete(name);
    return this;
  }
}

/** The headers a same-origin form post from `next start` on port 3000 carries. */
export function requestHeaders(): Headers {
  return new Headers({ origin: "http://localhost:3000", host: "localhost:3000" });
}

export function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

/** Runs a server action that must redirect and returns the target path. */
export async function expectRedirect(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    if (digest.startsWith("NEXT_REDIRECT")) return digest.split(";")[2];
    throw error;
  }
  throw new Error("expected a redirect");
}

export type RecordedExchange = { url: string; status: number; body: string };

/**
 * Wraps the global fetch for the duration of `run`: every response body is
 * recorded, and `override` may answer a request instead of the network (to
 * simulate an email failure). Supabase clients created inside `run` pick up
 * the wrapper because they resolve `fetch` at creation time.
 */
export async function withFetch<T>(
  run: () => Promise<T>,
  override?: (url: string) => Response | undefined,
): Promise<{ result: T; exchanges: RecordedExchange[] }> {
  const original = globalThis.fetch;
  const exchanges: RecordedExchange[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const response = override?.(url) ?? (await original(input, init));
    exchanges.push({ url, status: response.status, body: await response.clone().text() });
    return response;
  });
  try {
    return { result: await run(), exchanges };
  } finally {
    spy.mockRestore();
  }
}

/** A GoTrue-shaped 500, as when the mailer fails. */
export function mailerFailure(): Response {
  return new Response(JSON.stringify({ code: 500, error_code: "unexpected_failure", msg: "Error sending email" }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}
