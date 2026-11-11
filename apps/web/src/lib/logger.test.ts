import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, logger } from "./logger";

type Spy = ReturnType<typeof vi.spyOn>;

let logSpy: Spy;
let warnSpy: Spy;
let errorSpy: Spy;

function lastJson(spy: Spy): Record<string, unknown> {
  const call = spy.mock.calls.at(-1);
  if (!call) throw new Error("console method was not called");
  return JSON.parse(String(call[0])) as Record<string, unknown>;
}

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logger", () => {
  it("writes one JSON line with level, message and context fields", () => {
    logger.info("reservation created", {
      requestId: "req-1",
      operatorId: "op-1",
      userId: "user-1",
      extra: { reservationId: "res-9" },
    });

    const entry = lastJson(logSpy);
    expect(entry).toMatchObject({
      level: "info",
      message: "reservation created",
      requestId: "req-1",
      operatorId: "op-1",
      userId: "user-1",
      extra: { reservationId: "res-9" },
    });
    expect(typeof entry.time).toBe("string");
  });

  it("routes warn and error to the matching console method", () => {
    logger.warn("slow query");
    logger.error("boom");
    expect(lastJson(warnSpy)).toMatchObject({ level: "warn", message: "slow query" });
    expect(lastJson(errorSpy)).toMatchObject({ level: "error", message: "boom" });
  });

  it("redacts sensitive keys at any depth, including inside arrays", () => {
    logger.info("login attempt", {
      extra: {
        password: "hunter2",
        token_hash: "abc",
        email: "person@example.com",
        session: { access_token: "at", refresh_token: "rt", expires_in: 3600 },
        attempts: [{ email: "x@example.com", ok: false }],
      },
    });

    const entry = lastJson(logSpy);
    expect(entry.extra).toEqual({
      password: "[redacted]",
      token_hash: "[redacted]",
      email: "[redacted]",
      session: { access_token: "[redacted]", refresh_token: "[redacted]", expires_in: 3600 },
      attempts: [{ email: "[redacted]", ok: false }],
    });
    const raw = String(logSpy.mock.calls.at(-1)?.[0]);
    for (const secret of ["hunter2", "person@example.com", '"at"', '"rt"', "x@example.com"]) {
      expect(raw).not.toContain(secret);
    }
  });

  it("redacts case-insensitively and does not touch other keys", () => {
    logger.info("x", { extra: { Email: "a@b.c", EMAIL: "d@e.f", emailCount: 2 } });
    expect(lastJson(logSpy).extra).toEqual({ Email: "[redacted]", EMAIL: "[redacted]", emailCount: 2 });
  });

  it("serializes Error values and redacts inside their causes", () => {
    const cause = { email: "leak@example.com" };
    logger.error("failed", { extra: { err: new Error("nope", { cause }) } });
    const entry = lastJson(errorSpy);
    const err = (entry.extra as { err: Record<string, unknown> }).err;
    expect(err).toMatchObject({ name: "Error", message: "nope", cause: { email: "[redacted]" } });
    expect(typeof err.stack).toBe("string");
  });

  it("survives circular structures", () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    expect(() => logger.info("cycle", { extra: { loop } })).not.toThrow();
    expect((lastJson(logSpy).extra as { loop: Record<string, unknown> }).loop).toMatchObject({
      a: 1,
      self: "[circular]",
    });
  });

  it("createLogger binds request and operator context to every line", () => {
    const scoped = createLogger({ requestId: "req-7", operatorId: "op-7" });
    scoped.info("hello");
    scoped.warn("careful", { userId: "u-1" });
    expect(lastJson(logSpy)).toMatchObject({ requestId: "req-7", operatorId: "op-7", message: "hello" });
    expect(lastJson(warnSpy)).toMatchObject({ requestId: "req-7", operatorId: "op-7", userId: "u-1" });
  });
});
