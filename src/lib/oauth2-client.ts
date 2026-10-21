/**
 * Shared OAuth2 client for token exchange, refresh, and validation.
 * Composes with oauth-callback.ts and oauth-tokens.ts.
 */

import { createHash, randomBytes } from "node:crypto";
import { waitForOAuthCallback, OAUTH_REDIRECT_URI } from "./oauth-callback";
import { createTokenManager, type OAuthTokens } from "./oauth-tokens";

export interface OAuth2ProviderConfig {
  name: string;
  authUrl: string;
  tokenUrl: string;

  scopes?: string[];
  /** "body" = client_id/secret in POST body, "basic" = Basic Auth header */
  authMethod: "body" | "basic";
  /** "form" = application/x-www-form-urlencoded, "json" = application/json */
  contentType: "form" | "json";
  extraAuthParams?: Record<string, string>;
  /** Enable PKCE (Proof Key for Code Exchange). When true, client_secret is optional. */
  pkce?: boolean;
}

export interface OAuth2TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
  [key: string]: unknown;
}

export type TokenExtractor<T extends OAuthTokens> = (
  response: OAuth2TokenResponse,
  previousTokens?: T
) => T;

export interface OAuth2ClientOptions<T extends OAuthTokens> {
  provider: OAuth2ProviderConfig;
  /** clientSecret is optional when provider.pkce is true. */
  credentials: { clientId: string; clientSecret?: string };
  stateKey: string;
  tokenExtractor?: TokenExtractor<T>;
  /** Buffer before expiry to trigger refresh (default: 5 min) */
  expiryBufferMs?: number;
  /** Override the default redirect URI (default: http://127.0.0.1:8742/callback) */
  redirectUri?: string;
}

export interface OAuth2Client<T extends OAuthTokens> {
  authorize(): Promise<T>;
  refresh(currentTokens: T, options?: { silent?: boolean }): Promise<T | null>;
  ensureValidToken(options?: { headless?: boolean }): Promise<T>;
  clearTokens(): void;
  getTokens(): T | null;
}

// ============================================================================
// PKCE Helpers
// ============================================================================

function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createCodeVerifier(): string {
  return base64UrlEncode(randomBytes(64));
}

function createCodeChallenge(verifier: string): string {
  const digest = createHash("sha256").update(verifier).digest();
  return base64UrlEncode(digest);
}

// ============================================================================
// URL/Request Builders
// ============================================================================

function buildAuthUrl(
  provider: OAuth2ProviderConfig,
  credentials: { clientId: string; clientSecret?: string },
  redirectUri: string,
  pkceChallenge?: string
): string {
  const url = new URL(provider.authUrl);
  url.searchParams.set("client_id", credentials.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");

  if (provider.scopes?.length) {
    url.searchParams.set("scope", provider.scopes.join(" "));
  }

  if (provider.extraAuthParams) {
    for (const [key, value] of Object.entries(provider.extraAuthParams)) {
      url.searchParams.set(key, value);
    }
  }

  if (pkceChallenge) {
    url.searchParams.set("code_challenge", pkceChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }

  return url.toString();
}

function buildTokenRequest(
  provider: OAuth2ProviderConfig,
  credentials: { clientId: string; clientSecret?: string },
  params: Record<string, string>,
  redirectUri: string
): { headers: Record<string, string>; body: string | URLSearchParams } {
  const body: Record<string, string> = { ...params };
  if (params.grant_type === "authorization_code") {
    body.redirect_uri = redirectUri;
  }
  const headers: Record<string, string> = {
    "Content-Type": provider.contentType === "json" ? "application/json" : "application/x-www-form-urlencoded",
  };

  if (provider.authMethod === "basic" && credentials.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64")}`;
  } else {
    body.client_id = credentials.clientId;
    if (credentials.clientSecret) body.client_secret = credentials.clientSecret;
  }

  return {
    headers,
    body: provider.contentType === "json" ? JSON.stringify(body) : new URLSearchParams(body),
  };
}

export function createOAuth2Client<T extends OAuthTokens = OAuthTokens>(
  options: OAuth2ClientOptions<T>
): OAuth2Client<T> {
  const {
    provider,
    credentials,
    stateKey,
    expiryBufferMs = 5 * 60 * 1000,
  } = options;

  const tokenExtractor: TokenExtractor<T> = options.tokenExtractor ?? ((r) => ({
    access_token: r.access_token,
    refresh_token: r.refresh_token,
    expires_at: Date.now() + r.expires_in * 1000,
  }) as T);

  const redirectUri = options.redirectUri ?? OAUTH_REDIRECT_URI;
  const tokenManager = createTokenManager<T>(stateKey);

  async function authorize(): Promise<T> {
    // Generate PKCE code verifier/challenge if enabled
    let codeVerifier: string | undefined;
    let codeChallenge: string | undefined;
    if (provider.pkce) {
      codeVerifier = createCodeVerifier();
      codeChallenge = createCodeChallenge(codeVerifier);
    }

    const authUrl = buildAuthUrl(provider, credentials, redirectUri, codeChallenge);

    const { code } = await waitForOAuthCallback(authUrl, {
      successMessage: `${provider.name} authentication successful! Return to terminal.`,
    });

    console.log("Exchanging code for tokens...");

    const tokenParams: Record<string, string> = {
      grant_type: "authorization_code",
      code,
    };
    if (codeVerifier) {
      tokenParams.code_verifier = codeVerifier;
    }

    const response = await fetch(provider.tokenUrl, {
      method: "POST",
      ...buildTokenRequest(provider, credentials, tokenParams, redirectUri),
    });

    if (!response.ok) {
      throw new Error(`Token exchange failed: ${await response.text()}`);
    }

    const tokenResponse: OAuth2TokenResponse = await response.json();
    const tokens = tokenExtractor(tokenResponse);
    tokenManager.save(tokens);
    console.log(`${provider.name} authenticated\n`);

    return tokens;
  }

  async function refresh(
    currentTokens: T,
    opts: { silent?: boolean } = {}
  ): Promise<T | null> {
    if (!currentTokens.refresh_token) {
      if (opts.silent) return null;
      throw new Error("No refresh token available");
    }

    console.log("Refreshing access token...");

    try {
      const response = await fetch(provider.tokenUrl, {
        method: "POST",
        ...buildTokenRequest(provider, credentials, { grant_type: "refresh_token", refresh_token: currentTokens.refresh_token }, redirectUri),
      });

      if (!response.ok) {
        throw new Error(`Token refresh failed: ${await response.text()}`);
      }

      const tokenResponse: OAuth2TokenResponse = await response.json();
      const newTokens = tokenExtractor(tokenResponse, currentTokens);
      tokenManager.save(newTokens);
      console.log("Token refreshed\n");

      return newTokens;
    } catch (e) {
      if (opts.silent) {
        console.log(`Token refresh failed: ${e instanceof Error ? e.message : e}`);
        return null;
      }
      throw e;
    }
  }

  async function ensureValidToken(opts: { headless?: boolean } = {}): Promise<T> {
    let tokens = tokenManager.load();

    if (!tokens) {
      if (opts.headless) {
        throw new Error(
          `${provider.name} not authenticated. Run the parser interactively first.`
        );
      }
      return await authorize();
    }

    if (!tokens.non_expiring && Date.now() >= tokens.expires_at - expiryBufferMs) {
      try {
        const refreshed = await refresh(tokens); // silent defaults to false, so throws on error
        if (!refreshed) throw new Error("Token refresh returned null");
        tokens = refreshed;
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.error("Token refresh failed:", errorMsg);

        if (opts.headless) {
          throw new Error(
            `${provider.name} token refresh failed: ${errorMsg}. Re-authenticate by running the parser interactively.`
          );
        }

        console.log("Re-authenticating...");
        tokens = await authorize();
      }
    }

    return tokens;
  }

  return {
    authorize,
    refresh,
    ensureValidToken,
    clearTokens: () => tokenManager.clear(),
    getTokens: () => tokenManager.load(),
  };
}
