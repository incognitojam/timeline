import { describe, expect, test } from "bun:test";
import { deriveOAuthAuthStatus } from "./oauth-tokens";

describe("deriveOAuthAuthStatus", () => {
  test("reports not-configured when client credentials are absent", () => {
    expect(deriveOAuthAuthStatus(false, null)).toBe("not-configured");
  });

  test("reports needs-reauth when tokens cannot be refreshed", () => {
    expect(deriveOAuthAuthStatus(true, null)).toBe("needs-reauth");
    expect(deriveOAuthAuthStatus(true, {
      access_token: "expired-token",
      expires_at: Date.now() - 1,
    })).toBe("needs-reauth");
  });

  test("reports connected when an expired access token has a refresh token", () => {
    expect(deriveOAuthAuthStatus(true, {
      access_token: "expired-token",
      refresh_token: "refresh-token",
      expires_at: Date.now() - 1,
    })).toBe("connected");
  });
});
