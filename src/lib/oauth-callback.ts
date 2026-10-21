/**
 * OAuth Callback Server Helper
 *
 * Shared utility for OAuth flows that require a local callback server.
 * Handles the common pattern of starting a server, waiting for the auth code,
 * and cleaning up.
 */

export const OAUTH_CALLBACK_PORT = 8742;
export const OAUTH_REDIRECT_URI = `http://127.0.0.1:${OAUTH_CALLBACK_PORT}/callback`;

export interface OAuthCallbackOptions {
  /** Custom success message shown in browser (default: "Success! Return to terminal.") */
  successMessage?: string;
}

export interface OAuthCallbackResult {
  code: string;
}

/**
 * Start a local HTTP server and wait for an OAuth callback with an authorization code.
 *
 * @param authUrl - The authorization URL to display to the user
 * @param options - Configuration options
 * @returns The authorization code from the callback
 * @throws Error if the callback contains an error parameter
 */
export async function waitForOAuthCallback(
  authUrl: string,
  options: OAuthCallbackOptions
): Promise<OAuthCallbackResult> {
  const { successMessage = "Success! Return to terminal." } = options;

  let resolveAuth: (code: string) => void;
  let rejectAuth: (error: Error) => void;

  const authPromise = new Promise<string>((resolve, reject) => {
    resolveAuth = resolve;
    rejectAuth = reject;
  });

  const server = Bun.serve({
    port: OAUTH_CALLBACK_PORT,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        if (code) {
          resolveAuth(code);
          return new Response(
            `<html><body style="font-family: sans-serif; padding: 40px;">
            <h1>✓ ${successMessage}</h1></body></html>`,
            { headers: { "Content-Type": "text/html; charset=utf-8" } }
          );
        }

        // Handle error response
        const error =
          url.searchParams.get("error_description") ||
          url.searchParams.get("error") ||
          "Authorization failed";
        rejectAuth(new Error(error));
        return new Response(
          `<html><body style="font-family: sans-serif; padding: 40px;">
          <h1>Error</h1><p>${error}</p></body></html>`,
          { headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }

      return new Response("Not found", { status: 404 });
    },
  });

  console.log("Open this URL in your browser to authenticate:");
  console.log(`\n  ${authUrl}\n`);
  console.log(`Waiting for callback on ${OAUTH_REDIRECT_URI} ...\n`);

  try {
    const code = await authPromise;
    return { code };
  } finally {
    server.stop();
  }
}
