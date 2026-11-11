// Structured JSON logger: one line per event, console transport, so Vercel
// runtime logs can be filtered by requestId and operatorId (pilot monitoring).
// Sensitive keys are redacted at any depth; do not work around this.

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = {
  requestId?: string;
  operatorId?: string;
  userId?: string;
  extra?: Record<string, unknown>;
};

export type LogEntry = {
  level: LogLevel;
  time: string;
  message: string;
} & LogContext;

const REDACTED = "[redacted]";
const CIRCULAR = "[circular]";
const REDACTED_KEYS = new Set([
  "password",
  "token_hash",
  "email",
  "access_token",
  "refresh_token",
]);

function isRedactedKey(key: string): boolean {
  return REDACTED_KEYS.has(key.toLowerCase());
}

function serializeError(error: Error, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  if ("cause" in error && error.cause !== undefined) {
    out.cause = redact(error.cause, seen);
  }
  return out;
}

/** Returns a copy of `value` with every sensitive key replaced by "[redacted]". */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return CIRCULAR;
  }
  seen.add(value);

  if (value instanceof Error) {
    return serializeError(value, seen);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isRedactedKey(key) ? REDACTED : redact(child, seen);
  }
  return out;
}

const transport: Record<LogLevel, (line: string) => void> = {
  debug: (line) => console.log(line),
  info: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

function write(level: LogLevel, message: string, context: LogContext): void {
  const entry: LogEntry = {
    level,
    time: new Date().toISOString(),
    message,
    ...(context.requestId !== undefined && { requestId: context.requestId }),
    ...(context.operatorId !== undefined && { operatorId: context.operatorId }),
    ...(context.userId !== undefined && { userId: context.userId }),
    ...(context.extra !== undefined && {
      extra: redact(context.extra) as Record<string, unknown>,
    }),
  };
  transport[level](JSON.stringify(entry));
}

export type Logger = {
  [L in LogLevel]: (message: string, context?: LogContext) => void;
};

/** A logger with `base` context merged into every line (for example per request). */
export function createLogger(base: Omit<LogContext, "extra"> = {}): Logger {
  const bound =
    (level: LogLevel) =>
    (message: string, context: LogContext = {}) =>
      write(level, message, { ...base, ...context });
  return {
    debug: bound("debug"),
    info: bound("info"),
    warn: bound("warn"),
    error: bound("error"),
  };
}

export const logger: Logger = createLogger();
