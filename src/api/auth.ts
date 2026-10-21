import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context, Next } from "hono";
import { SignJWT, jwtVerify } from "jose";
import { resolveEnvFilePath } from "../config";

// Configuration
const SESSION_COOKIE_NAME = "timeline_session";

// Read config dynamically to support testing
function getAuthPassword(): string | undefined {
  return process.env.AUTH_PASSWORD;
}

export function isDevelopmentMode(): boolean {
  return process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
}

export function assertApiAuthConfigured(): void {
  if (!isAuthEnabled() && !isDevelopmentMode()) {
    throw new Error(
      `AUTH_PASSWORD must be set outside development. Add it to ${resolveEnvFilePath()}.`
    );
  }
}

function getTokenExpiryDays(): number {
  return parseInt(process.env.AUTH_TOKEN_EXPIRY_DAYS || "30", 10);
}

function getTokenExpirySeconds(): number {
  return getTokenExpiryDays() * 24 * 60 * 60;
}

// Get secret as Uint8Array for jose
function getSecret(): Uint8Array {
  const password = getAuthPassword();
  if (!password) throw new Error("AUTH_PASSWORD not set");
  return new TextEncoder().encode(password);
}

export function isAuthEnabled(): boolean {
  return !!getAuthPassword();
}

// Parse Basic Auth header, returns password (after colon) or null
function parseBasicAuth(header: string | undefined): string | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
    const i = decoded.indexOf(":");
    return i === -1 ? null : decoded.slice(i + 1);
  } catch {
    return null;
  }
}

// Set session cookie with JWT token
async function setSessionCookie(c: Context): Promise<void> {
  const token = await generateToken();
  const isHttps =
    c.req.header("x-forwarded-proto") === "https" ||
    c.req.url.startsWith("https://");
  setCookie(c, SESSION_COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    secure: isHttps,
    sameSite: "Lax",
    maxAge: getTokenExpirySeconds(),
  });
}

// Generate JWT token
async function generateToken(): Promise<string> {
  const secret = getSecret();
  const expiryDays = getTokenExpiryDays();
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${expiryDays}d`)
    .sign(secret);
}

// Validate JWT token
export async function validateToken(token: string): Promise<boolean> {
  try {
    const secret = getSecret();
    await jwtVerify(token, secret);
    return true;
  } catch {
    return false;
  }
}

// Check auth via Basic Auth header or session cookie. Sets cookie on Basic Auth success.
export async function checkAuth(c: Context): Promise<boolean> {
  if (!isAuthEnabled()) return isDevelopmentMode();

  // Try Basic Auth first
  const basicPw = parseBasicAuth(c.req.header("authorization"));
  if (basicPw !== null) {
    if (basicPw !== getAuthPassword()) return false;
    await setSessionCookie(c);
    return true;
  }

  // Fall back to session cookie
  const token = getCookie(c, SESSION_COOKIE_NAME);
  return token ? await validateToken(token) : false;
}

// Auth middleware
export async function authMiddleware(c: Context, next: Next) {
  const path = c.req.path;

  // Unauthenticated API access is only allowed in development/test.
  if (!isAuthEnabled() && isDevelopmentMode()) {
    return next();
  }

  if (!isAuthEnabled()) {
    return c.json({ error: "AUTH_PASSWORD must be set outside development" }, 503);
  }

  // Allow public endpoints
  if (
    path === "/api/health" ||
    path.startsWith("/api/auth/")
  ) {
    return next();
  }

  // Check authentication (cookie or Basic Auth)
  if (!(await checkAuth(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return next();
}

// Auth routes
export const authRoutes = new Hono()
  .get("/api/auth/status", async (c) => {
    if (!isAuthEnabled()) {
      return c.json({ authenticated: true, authEnabled: false });
    }

    // checkAuth handles Basic Auth (sets cookie) or validates existing cookie
    const authenticated = await checkAuth(c);
    return c.json({ authenticated, authEnabled: true });
  })
  .post("/api/auth/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
    return c.json({ success: true });
  });
