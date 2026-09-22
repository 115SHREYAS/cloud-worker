import { z } from "zod";

export const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  E2B_API_KEY: z.string().optional(),
  GITHUB_APP_ID: z.coerce.number().int().positive().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  CODEX_AUTH_JSON: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  CLAUDE_AUTH_JSON: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  MAX_TASK_DURATION_MS: z.coerce.number().int().positive().default(900_000), // 15 minutes
  MAX_TOOL_ITERATIONS: z.coerce.number().int().positive().default(50),
});

export type ServerEnvironment = z.infer<typeof EnvironmentSchema>;

export function loadConfig(env = process.env): ServerEnvironment {
  const result = EnvironmentSchema.safeParse(env);
  if (!result.success) {
    console.error("[config] Invalid environment configuration:", result.error.format());
    throw new Error(`Environment validation failed: ${result.error.message}`);
  }

  const config = result.data;

  // Production security validations
  if (config.NODE_ENV === "production") {
    if (!config.E2B_API_KEY) {
      console.warn("[config] WARNING: E2B_API_KEY is not set in production. Sandbox provisioning will fail.");
    }
    if (!config.DATABASE_URL) {
      console.warn("[config] WARNING: DATABASE_URL is not set in production. Using ephemeral in-memory storage.");
    }
  }

  return config;
}
