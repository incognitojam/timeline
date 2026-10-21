/**
 * OAuth Token Storage Helpers
 *
 * Common utilities for loading and saving OAuth tokens to the app-state database.
 */

import { getAppStateDb, getSyncState, setSyncState } from "../db/app-state";

/**
 * Base interface for OAuth tokens.
 * Specific implementations may extend this with additional fields.
 */
export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  /** True for long-lived tokens that do not expire or support refresh. */
  non_expiring?: boolean;
}

export type OAuthAuthStatus = "connected" | "needs-reauth" | "not-configured";

/**
 * Report whether locally stored OAuth state can continue without interactive
 * authorization. This deliberately does not attempt a refresh or call a
 * provider: an expired access token remains connected when its refresh token
 * can renew it.
 */
export function deriveOAuthAuthStatus(
  hasClientCredentials: boolean,
  tokens: OAuthTokens | null
): OAuthAuthStatus {
  if (!hasClientCredentials) return "not-configured";
  if (!tokens || (!tokens.non_expiring && !tokens.refresh_token)) return "needs-reauth";
  return "connected";
}

/**
 * Creates a token manager for a specific OAuth source.
 *
 * @example
 * ```typescript
 * interface MonzoTokens extends OAuthTokens {
 *   refresh_token: string; // required for Monzo
 * }
 *
 * const tokens = createTokenManager<MonzoTokens>("monzo");
 *
 * const current = tokens.load();
 * tokens.save({ ...current, access_token: "new_token" });
 * ```
 */
export function createTokenManager<T extends OAuthTokens>(stateKey: string) {
  return {
    /**
     * Load tokens from app-state database.
     */
    load(): T | null {
      const appDb = getAppStateDb();
      return getSyncState<T>(appDb, stateKey);
    },

    /**
     * Save tokens to app-state database.
     */
    save(tokens: T): void {
      const appDb = getAppStateDb();
      setSyncState(appDb, stateKey, tokens);
    },

    /**
     * Check if tokens are expired (with optional buffer in seconds).
     * @param tokens The tokens to check
     * @param bufferSeconds Consider expired this many seconds before actual expiry (default: 60)
     */
    isExpired(tokens: T, bufferSeconds: number = 60): boolean {
      if (tokens.non_expiring) return false;
      return Date.now() >= tokens.expires_at - bufferSeconds * 1000;
    },

    /**
     * Clear stored tokens.
     */
    clear(): void {
      const appDb = getAppStateDb();
      setSyncState(appDb, stateKey, null);
    },
  };
}
