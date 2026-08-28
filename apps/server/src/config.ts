// Centralized Configuration & Environment Validation (Phase 6).
// Ensures all critical runtime parameters are validated on startup.

import { z } from "zod";

export const ConfigSchema = z.object({
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DB_PATH: z.string().default(":memory:"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  RATE_LIMIT_ENABLED: z.coerce.boolean().default(true),
  RATE_LIMIT_MAX: z.coerce.number().default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  MAX_CONCURRENT_TASKS_PER_AGENT: z.coerce.number().default(2),
  MAX_CONCURRENT_TASKS_PER_PROJECT: z.coerce.number().default(25),
  MAX_CONCURRENT_WORKFLOWS_PER_PROJECT: z.coerce.number().default(5),
  LEASE_TIMEOUT_SECONDS: z.coerce.number().default(60),
  HEARTBEAT_GRACE_SECONDS: z.coerce.number().default(30),
  RETENTION_DAYS: z.coerce.number().default(30),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().default(10000),
});

export type ServerConfig = z.infer<typeof ConfigSchema>;

let _config: ServerConfig | null = null;

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    throw new Error(`Invalid server environment configuration: ${issues}`);
  }
  _config = parsed.data;
  return _config;
}

export function getConfig(): ServerConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}
