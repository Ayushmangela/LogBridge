// Structured Correlation Logger with Secret Redaction (Phase 6).
// Formats structured JSON log entries carrying correlation metadata across the lifecycle.

export interface LogContext {
  requestId?: string;
  projectId?: string;
  workflowId?: string;
  goalId?: string;
  taskId?: string;
  attemptId?: string;
  agentId?: string;
  [key: string]: any;
}

const REDACT_KEYS = new Set([
  "password",
  "token",
  "secret",
  "authorization",
  "apikey",
  "api_key",
  "gh_token",
  "sessiontoken",
]);

function sanitize(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sanitize);

  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACT_KEYS.has(k.toLowerCase())) {
      out[k] = "[REDACTED]";
    } else if (typeof v === "object") {
      out[k] = sanitize(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export class Logger {
  constructor(private context: LogContext = {}) {}

  child(extraContext: LogContext): Logger {
    return new Logger({ ...this.context, ...extraContext });
  }

  private log(level: "debug" | "info" | "warn" | "error", message: string, data?: any) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: sanitize(this.context),
      data: data ? sanitize(data) : undefined,
    };
    if (process.env.NODE_ENV !== "test" || process.env.DEBUG_TESTS) {
      if (level === "error") {
        console.error(JSON.stringify(entry));
      } else if (level === "warn") {
        console.warn(JSON.stringify(entry));
      } else {
        console.log(JSON.stringify(entry));
      }
    }
  }

  debug(msg: string, data?: any) { this.log("debug", msg, data); }
  info(msg: string, data?: any) { this.log("info", msg, data); }
  warn(msg: string, data?: any) { this.log("warn", msg, data); }
  error(msg: string, data?: any) { this.log("error", msg, data); }
}

export const logger = new Logger();
