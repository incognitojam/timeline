/**
 * Auth Tests
 *
 * Tests authentication middleware and routes.
 * Run with: bun test src/api/auth.test.ts
 */

process.env.NODE_ENV = "test";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { app } from "./index";
import { assertApiAuthConfigured } from "./auth";
import { SignJWT } from "jose";

// Helper to create a JWT with custom secret/expiry
async function createTestToken(
  secret: string,
  options?: { expired?: boolean }
): Promise<string> {
  const secretBytes = new TextEncoder().encode(secret);
  const jwt = new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt();

  if (options?.expired) {
    // Set expiry to 1 second ago
    jwt.setExpirationTime(Math.floor(Date.now() / 1000) - 1);
  } else {
    jwt.setExpirationTime("1h");
  }

  return jwt.sign(secretBytes);
}

// Helper to extract Set-Cookie header value
function getCookieValue(res: Response, cookieName: string): string | undefined {
  const setCookie = res.headers.get("Set-Cookie");
  if (!setCookie) return undefined;
  const match = setCookie.match(new RegExp(`${cookieName}=([^;]+)`));
  return match?.[1];
}

describe("Auth - Runtime Requirement", () => {
  test("production startup fails closed without AUTH_PASSWORD", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousPassword = process.env.AUTH_PASSWORD;

    try {
      process.env.NODE_ENV = "production";
      delete process.env.AUTH_PASSWORD;

      expect(() => assertApiAuthConfigured()).toThrow(
        "AUTH_PASSWORD must be set outside development"
      );
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      if (previousPassword === undefined) {
        delete process.env.AUTH_PASSWORD;
      } else {
        process.env.AUTH_PASSWORD = previousPassword;
      }
    }
  });

  test("production API requests fail closed if startup guard is bypassed", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousPassword = process.env.AUTH_PASSWORD;

    try {
      process.env.NODE_ENV = "production";
      delete process.env.AUTH_PASSWORD;

      for (const path of ["/api/stats", "/status", "/status.md"]) {
        const res = await app.request(path);
        expect(res.status).toBe(503);
        const json = await res.json();
        expect(json).toEqual({ error: "AUTH_PASSWORD must be set outside development" });
      }
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      if (previousPassword === undefined) {
        delete process.env.AUTH_PASSWORD;
      } else {
        process.env.AUTH_PASSWORD = previousPassword;
      }
    }
  });
});

describe("Auth - Disabled Mode", () => {
  beforeAll(() => {
    // Ensure auth is disabled
    delete process.env.AUTH_PASSWORD;
  });

  test("GET /api/auth/status returns authEnabled: false", async () => {
    const res = await app.request("/api/auth/status");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ authenticated: true, authEnabled: false });
  });

  test("Protected routes work without auth", async () => {
    const res = await app.request("/api/stats");
    expect(res.status).toBe(200);
  });
});

describe("Auth - Enabled Mode", () => {
  const TEST_PASSWORD = "test-password-123";

  beforeAll(() => {
    process.env.AUTH_PASSWORD = TEST_PASSWORD;
  });

  afterAll(() => {
    delete process.env.AUTH_PASSWORD;
  });

  describe("Status pages", () => {
    const variants = [
      { path: "/status", accept: "text/html", contentType: "text/html" },
      { path: "/status", accept: "text/markdown", contentType: "text/markdown" },
      { path: "/status.md", accept: "text/markdown", contentType: "text/markdown" },
    ];

    for (const { path, accept, contentType } of variants) {
      test(`${path} (${accept}) rejects missing and invalid credentials`, async () => {
        for (const cookie of ["", "timeline_session=invalid"]) {
          const res = await app.request(path, {
            headers: { Accept: accept, Cookie: cookie },
          });
          expect(res.status).toBe(401);
          expect(res.headers.get("Cache-Control")).toBe("no-store");
          expect(await res.json()).toEqual({ error: "Unauthorized" });
        }
      });

      test(`${path} (${accept}) accepts session and Basic authentication`, async () => {
        const token = await createTestToken(TEST_PASSWORD);
        const credentials: Record<string, string>[] = [
          { Cookie: `timeline_session=${token}` },
          { Authorization: `Basic ${Buffer.from(`:${TEST_PASSWORD}`).toString("base64")}` },
        ];
        for (const credential of credentials) {
          const res = await app.request(path, {
            headers: { Accept: accept, ...credential },
          });
          expect(res.status).toBe(200);
          expect(res.headers.get("Content-Type")).toContain(contentType);
          expect(res.headers.get("Cache-Control")).toBe("no-store");
          expect(await res.text()).toContain("Timeline Service Status");
        }
      });
    }
  });

  describe("Auth Status", () => {
    test("GET /api/auth/status returns authEnabled: true, authenticated: false without cookie", async () => {
      const res = await app.request("/api/auth/status");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ authenticated: false, authEnabled: true });
    });

    test("GET /api/auth/status returns authenticated: true with valid cookie", async () => {
      const token = await createTestToken(TEST_PASSWORD);
      const res = await app.request("/api/auth/status", {
        headers: { Cookie: `timeline_session=${token}` },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ authenticated: true, authEnabled: true });
    });
  });

  describe("Protected Routes - Missing JWT", () => {
    test("GET /api/stats returns 401 without cookie", async () => {
      const res = await app.request("/api/stats");
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json).toEqual({ error: "Unauthorized" });
    });

    test("GET /api/search returns 401 without cookie", async () => {
      const res = await app.request("/api/search?limit=5");
      expect(res.status).toBe(401);
    });

    test("GET /api/contacts returns 401 without cookie", async () => {
      const res = await app.request("/api/contacts");
      expect(res.status).toBe(401);
    });
  });

  describe("Protected Routes - Invalid JWT", () => {
    test("GET /api/stats returns 401 with tampered JWT", async () => {
      // Create a valid token, then corrupt it
      const token = await createTestToken(TEST_PASSWORD);
      const tamperedToken = token.slice(0, -5) + "xxxxx";

      const res = await app.request("/api/stats", {
        headers: { Cookie: `timeline_session=${tamperedToken}` },
      });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json).toEqual({ error: "Unauthorized" });
    });

    test("GET /api/stats returns 401 with wrong-secret JWT", async () => {
      const token = await createTestToken("wrong-secret");

      const res = await app.request("/api/stats", {
        headers: { Cookie: `timeline_session=${token}` },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("Protected Routes - Expired JWT", () => {
    test("GET /api/stats returns 401 with expired JWT", async () => {
      const token = await createTestToken(TEST_PASSWORD, { expired: true });

      const res = await app.request("/api/stats", {
        headers: { Cookie: `timeline_session=${token}` },
      });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json).toEqual({ error: "Unauthorized" });
    });

    test("GET /api/auth/status returns authenticated: false with expired JWT", async () => {
      const token = await createTestToken(TEST_PASSWORD, { expired: true });

      const res = await app.request("/api/auth/status", {
        headers: { Cookie: `timeline_session=${token}` },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ authenticated: false, authEnabled: true });
    });
  });

  describe("Protected Routes - Valid JWT", () => {
    test("GET /api/stats returns 200 with valid JWT", async () => {
      const token = await createTestToken(TEST_PASSWORD);

      const res = await app.request("/api/stats", {
        headers: { Cookie: `timeline_session=${token}` },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("total_events");
    });

    test("GET /api/search returns 200 with valid JWT", async () => {
      const token = await createTestToken(TEST_PASSWORD);

      const res = await app.request("/api/search?limit=5", {
        headers: { Cookie: `timeline_session=${token}` },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("events");
    });
  });

  describe("Public Routes", () => {
    test("GET /api/health returns 200 without auth", async () => {
      const res = await app.request("/api/health");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe("healthy");
    });

    test("GET /api/auth/status returns 200 without auth", async () => {
      const res = await app.request("/api/auth/status");
      expect(res.status).toBe(200);
    });
  });

  describe("Logout Flow", () => {
    test("POST /api/auth/logout clears the cookie", async () => {
      const res = await app.request("/api/auth/logout", {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ success: true });

      // Check that cookie is cleared (expires in past or empty value)
      const setCookie = res.headers.get("Set-Cookie");
      expect(setCookie).toBeTruthy();
      expect(setCookie).toContain("timeline_session=");
    });
  });

  describe("Basic Auth", () => {
    // Helper to create Basic Auth header
    function basicAuthHeader(username: string, password: string): string {
      const credentials = Buffer.from(`${username}:${password}`).toString("base64");
      return `Basic ${credentials}`;
    }

    test("GET /api/auth/status with valid Basic Auth returns authenticated and sets cookie", async () => {
      const res = await app.request("/api/auth/status", {
        headers: { Authorization: basicAuthHeader("", TEST_PASSWORD) },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ authenticated: true, authEnabled: true });

      // Check Set-Cookie header is set
      const setCookie = res.headers.get("Set-Cookie");
      expect(setCookie).toBeTruthy();
      expect(setCookie).toContain("timeline_session=");
    });

    test("GET /api/auth/status with wrong Basic Auth returns unauthenticated", async () => {
      const res = await app.request("/api/auth/status", {
        headers: { Authorization: basicAuthHeader("", "wrong-password") },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ authenticated: false, authEnabled: true });
    });

    test("GET /api/stats returns 200 with valid Basic Auth", async () => {
      const res = await app.request("/api/stats", {
        headers: { Authorization: basicAuthHeader("", TEST_PASSWORD) },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("total_events");
    });

    test("GET /api/stats returns 200 with valid Basic Auth (any username)", async () => {
      const res = await app.request("/api/stats", {
        headers: { Authorization: basicAuthHeader("anyuser", TEST_PASSWORD) },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("total_events");
    });

    test("GET /api/stats returns 401 with wrong Basic Auth password", async () => {
      const res = await app.request("/api/stats", {
        headers: { Authorization: basicAuthHeader("", "wrong-password") },
      });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json).toEqual({ error: "Unauthorized" });
    });

    test("Basic Auth sets session cookie for future requests", async () => {
      const res = await app.request("/api/stats", {
        headers: { Authorization: basicAuthHeader("", TEST_PASSWORD) },
      });
      expect(res.status).toBe(200);

      // Check Set-Cookie header is set
      const setCookie = res.headers.get("Set-Cookie");
      expect(setCookie).toBeTruthy();
      expect(setCookie).toContain("timeline_session=");
      expect(setCookie).toContain("HttpOnly");
    });

    test("Cookie from Basic Auth can be used for subsequent requests", async () => {
      // First request with Basic Auth
      const firstRes = await app.request("/api/stats", {
        headers: { Authorization: basicAuthHeader("", TEST_PASSWORD) },
      });
      expect(firstRes.status).toBe(200);

      // Extract cookie
      const token = getCookieValue(firstRes, "timeline_session");
      expect(token).toBeTruthy();

      // Subsequent request using only cookie (no Basic Auth)
      const secondRes = await app.request("/api/search?limit=5", {
        headers: { Cookie: `timeline_session=${token}` },
      });
      expect(secondRes.status).toBe(200);
    });

    test("Basic Auth with malformed header is ignored, falls back to cookie check", async () => {
      // Malformed Basic Auth should be ignored, resulting in 401 since no cookie
      const res = await app.request("/api/stats", {
        headers: { Authorization: "Basic notbase64!!!" },
      });
      expect(res.status).toBe(401);
    });

    test("Basic Auth with missing colon separator is ignored", async () => {
      const badCredentials = Buffer.from("nopassword").toString("base64");
      const res = await app.request("/api/stats", {
        headers: { Authorization: `Basic ${badCredentials}` },
      });
      expect(res.status).toBe(401);
    });
  });
});
