/**
 * MCP Token Validation
 *
 * Phase 1: Simple token validation from MCP_TOKENS env var.
 * Tokens are comma-separated, e.g., MCP_TOKENS=abc123,def456
 *
 * Future: Store tokens in app-state.db with generation, revocation, labels.
 */

/**
 * Check if MCP access is enabled (at least one token configured).
 */
export function isMcpEnabled(): boolean {
  return !!process.env.MCP_TOKENS?.trim();
}

/**
 * Validate an MCP access token.
 * Returns true if the token is valid.
 */
export function validateMcpToken(token: string): boolean {
  if (!token) return false;

  const envTokens = process.env.MCP_TOKENS?.split(",").map(t => t.trim()).filter(Boolean) || [];
  return envTokens.includes(token);
}

/**
 * Extract an MCP bearer token from an Authorization header.
 */
export function getMcpBearerToken(authorization: string | null): string | null {
  if (!authorization) return null;

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token ? token : null;
}
