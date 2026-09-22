import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

export interface GitHubAppConfig {
  appId?: number;
  privateKey?: string;
  clientId?: string;
  clientSecret?: string;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

export class GitHubTokenManager {
  private readonly appId?: number;
  private readonly privateKey?: string;
  private readonly authStrategy?: ReturnType<typeof createAppAuth>;
  private readonly tokenCache = new Map<number, CachedToken>();

  constructor(config?: GitHubAppConfig) {
    const rawAppId =
      config?.appId ?? (process.env.GITHUB_APP_ID ? parseInt(process.env.GITHUB_APP_ID, 10) : undefined);
    const rawPrivateKey = config?.privateKey ?? process.env.GITHUB_APP_PRIVATE_KEY;

    if (rawAppId && !isNaN(rawAppId) && rawPrivateKey && rawPrivateKey.trim().length > 0) {
      this.appId = rawAppId;
      // Handle escaped newlines in environment variables
      this.privateKey = rawPrivateKey.replace(/\\n/g, "\n");
      this.authStrategy = createAppAuth({
        appId: this.appId,
        privateKey: this.privateKey,
      });
    }
  }

  public isConfigured(): boolean {
    return this.authStrategy !== undefined;
  }

  public getAppId(): number | undefined {
    return this.appId;
  }

  public async getInstallationToken(installationId: number): Promise<string> {
    const now = Date.now();
    const cached = this.tokenCache.get(installationId);
    // Refresh token if expiring within 5 minutes
    if (cached && cached.expiresAtMs - now > 5 * 60 * 1000) {
      return cached.token;
    }

    if (!this.authStrategy) {
      // Check fallback personal access token if App credentials not configured
      const fallbackToken = process.env.GITHUB_TOKEN;
      if (fallbackToken) {
        return fallbackToken;
      }
      throw new Error(
        "GitHub App is not configured (missing GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY) and no GITHUB_TOKEN fallback available",
      );
    }

    const auth = await this.authStrategy({
      type: "installation",
      installationId,
    });

    const expiresAtMs = auth.expiresAt ? new Date(auth.expiresAt).getTime() : now + 55 * 60 * 1000;
    this.tokenCache.set(installationId, {
      token: auth.token,
      expiresAtMs,
    });

    return auth.token;
  }

  public async getInstallationOctokit(installationId: number): Promise<Octokit> {
    const token = await this.getInstallationToken(installationId);
    return new Octokit({ auth: token });
  }

  public getAppOctokit(): Octokit {
    if (!this.authStrategy || !this.appId || !this.privateKey) {
      throw new Error("GitHub App is not configured");
    }
    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: this.appId,
        privateKey: this.privateKey,
      },
    });
  }

  public clearCache(): void {
    this.tokenCache.clear();
  }
}
