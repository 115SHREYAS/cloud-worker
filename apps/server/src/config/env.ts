import { z } from "zod";
import path from "node:path";
import fs from "node:fs";

function loadEnvFiles() {
  const candidateDirs = [
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "../.."),
    import.meta.dir,
    path.resolve(import.meta.dir, ".."),
    path.resolve(import.meta.dir, "../.."),
    path.resolve(import.meta.dir, "../../.."),
  ];

  for (const dir of candidateDirs) {
    const envFile = path.join(dir, ".env");
    if (fs.existsSync(envFile)) {
      try {
        if (typeof process.loadEnvFile === "function") {
          process.loadEnvFile(envFile);
        }
      } catch {
        // Continue searching
      }
    }
  }
}

loadEnvFiles();

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
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_APP_SLUG: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
  ENCRYPTION_KEY: z.string().optional(),
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
