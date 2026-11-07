import { createHmac, timingSafeEqual } from "crypto";

export interface SessionPayload {
  sub: string;
  githubId?: number;
  username: string;
  email: string;
  avatarUrl: string;
  iat: number;
  exp: number;
}

const DEFAULT_SECRET = "cloud-worker-session-secret-change-in-prod";
const DEFAULT_MAX_AGE_SEC = 7 * 24 * 60 * 60; // 7 days

let warnedDevSessionSecret = false;

function resolveSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret) return secret;

  if (process.env.NODE_ENV !== "test" && !warnedDevSessionSecret) {
    warnedDevSessionSecret = true;
    console.warn(
      "[session] SESSION_SECRET is not set — using the built-in development secret. " +
        "Acceptable for local development only; production refuses to boot without SESSION_SECRET.",
    );
  }
  return DEFAULT_SECRET;
}

function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  return Buffer.from(base64, "base64").toString("utf8");
}

export function createSessionToken(
  payload: Omit<SessionPayload, "iat" | "exp">,
  secret = resolveSessionSecret(),
  maxAgeSec = DEFAULT_MAX_AGE_SEC,
): string {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: SessionPayload = {
    ...payload,
    iat: now,
    exp: now + maxAgeSec,
  };

  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const signature = createHmac("sha256", secret).update(dataToSign).digest();
  const encodedSignature = base64UrlEncode(signature.toString("binary"));

  return `${dataToSign}.${encodedSignature}`;
}

export function verifySessionToken(
  token: string,
  secret = resolveSessionSecret(),
): SessionPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSignature) return null;

  const dataToSign = `${encodedHeader}.${encodedPayload}`;
  const expectedSig = createHmac("sha256", secret).update(dataToSign).digest();
  const expectedSigEncoded = base64UrlEncode(expectedSig.toString("binary"));

  const sigBuf = Buffer.from(encodedSignature);
  const expBuf = Buffer.from(expectedSigEncoded);

  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as SessionPayload;
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(cookieHeader?: string | null): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(";")) {
    const [name, ...val] = pair.trim().split("=");
    if (name) {
      cookies[name] = decodeURIComponent(val.join("="));
    }
  }
  return cookies;
}

export function createSessionCookie(
  token: string,
  maxAgeSec = DEFAULT_MAX_AGE_SEC,
  secure = process.env.NODE_ENV === "production",
): string {
  const flags = [
    `cw_session=${token}`,
    "Path=/",
    `Max-Age=${maxAgeSec}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) flags.push("Secure");
  return flags.join("; ");
}

export function createLogoutCookie(secure = process.env.NODE_ENV === "production"): string {
  const flags = [
    "cw_session=",
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) flags.push("Secure");
  return flags.join("; ");
}

/**
 * CSRF protection for the OAuth flow: the state is stored in a short-lived
 * cookie at initiation and must round-trip through GitHub back to the callback.
 */
export function createOAuthStateCookie(state: string, maxAgeSec = 600): string {
  const flags = [
    `cw_oauth_state=${state}`,
    "Path=/",
    `Max-Age=${maxAgeSec}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (process.env.NODE_ENV === "production") flags.push("Secure");
  return flags.join("; ");
}

export function createClearOAuthStateCookie(): string {
  const flags = ["cw_oauth_state=", "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax"];
  if (process.env.NODE_ENV === "production") flags.push("Secure");
  return flags.join("; ");
}
