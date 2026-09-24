import { z } from "zod";

export const AuthModeSchema = z.enum(["subscription", "api_key"]);
export type AuthMode = z.infer<typeof AuthModeSchema>;

export const UserSchema = z.object({
  id: z.string(),
  githubId: z.number().int().positive(),
  username: z.string(),
  email: z.string().email(),
  avatarUrl: z.string().url(),
  defaultModel: z.string().default("codex"),
  defaultAuthMode: AuthModeSchema.default("subscription"),
  onboardingCompleted: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type User = z.infer<typeof UserSchema>;

export const UserPublicProfileSchema = UserSchema.omit({
  createdAt: true,
  updatedAt: true,
});

export type UserPublicProfile = z.infer<typeof UserPublicProfileSchema>;

export const SaveCredentialsInputSchema = z.object({
  provider: z.enum(["codex", "claude"]),
  authMode: AuthModeSchema,
  credential: z.string().min(1, "Credential cannot be empty"),
});

export type SaveCredentialsInput = z.infer<typeof SaveCredentialsInputSchema>;

export const UpdateOnboardingInputSchema = z.object({
  onboardingCompleted: z.boolean().optional(),
  defaultModel: z.string().optional(),
  defaultAuthMode: AuthModeSchema.optional(),
});

export type UpdateOnboardingInput = z.infer<typeof UpdateOnboardingInputSchema>;

export const ConfiguredProviderSchema = z.object({
  provider: z.enum(["codex", "claude"]),
  authMode: AuthModeSchema,
  updatedAt: z.string(),
});

export type ConfiguredProvider = z.infer<typeof ConfiguredProviderSchema>;

export const UserSettingsSchema = z.object({
  user: UserPublicProfileSchema,
  configuredProviders: z.array(ConfiguredProviderSchema),
  linkedInstallationsCount: z.number().int().nonnegative(),
});

export type UserSettings = z.infer<typeof UserSettingsSchema>;
