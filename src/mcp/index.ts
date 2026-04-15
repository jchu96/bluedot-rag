/**
 * OAuth provider + MCP worker entrypoint.
 *
 * Routes:
 *   /authorize                  -> GitHub OAuth handler (default)
 *   /auth/github/callback       -> GitHub OAuth handler (default)
 *   /auth/revoke                -> bearer revocation (default)
 *   /token, /register           -> OAuthProvider built-ins
 *   /.well-known/oauth-*        -> OAuthProvider built-ins (RFC 8414, RFC 9728)
 *   /mcp                        -> API handler, bearer required
 *   POST anything else          -> legacy Bluedot webhook (preserves existing integration)
 */
import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { Env } from "../env";
import { createGitHubAuthApp } from "./auth/github";
import { mcpApiHandler } from "./handler";
import { handleWebhook, buildHandlerDeps } from "../handler";

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };

function createDefaultApp() {
  const app = new Hono<{ Bindings: Bindings }>();

  // GitHub auth routes: /authorize, /auth/github/callback
  app.route("/", createGitHubAuthApp());

  // POST /auth/revoke — revoke the bearer token in the Authorization header.
  app.post("/auth/revoke", async (c) => {
    const authHeader = c.req.header("authorization") ?? c.req.header("Authorization");
    if (!authHeader || !/^Bearer\s+/i.test(authHeader)) {
      return c.text("Missing bearer token", 401);
    }
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return c.text("Empty bearer token", 401);

    const summary = await c.env.OAUTH_PROVIDER.unwrapToken(token);
    if (!summary) return c.text("Invalid token", 401);

    await c.env.OAUTH_PROVIDER.revokeGrant(summary.grantId, summary.userId);
    return c.json({ revoked: true }, 200);
  });

  // Health check / root
  app.get("/", (c) => c.json({ service: "aftercall", status: "ok" }));

  // Fallback: Bluedot webhook on POST. Preserves the pre-MCP behavior where
  // Bluedot hits the worker root with a signed payload.
  app.all("*", async (c) => {
    if (c.req.method === "POST") {
      return handleWebhook(c.req.raw, buildHandlerDeps(c.env));
    }
    return c.notFound();
  });

  return app;
}

const defaultApp = createDefaultApp();

export default new OAuthProvider<Bindings>({
  apiHandlers: {
    "/mcp": mcpApiHandler,
  },
  defaultHandler: defaultApp,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["mcp:tools"],
  accessTokenTTL: 60 * 60, // 1h access tokens
  refreshTokenTTL: 60 * 60 * 24 * 30, // 30d refresh
});

// Re-exported for tests.
export { createDefaultApp };
