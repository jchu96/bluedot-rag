/**
 * GitHub OAuth handler for the MCP server.
 *
 * Flow (see spec.md sequence diagram):
 *   Claude -> GET /authorize -> 302 to github.com
 *   GitHub -> GET /auth/github/callback -> allowlist -> completeAuthorization -> 302 to Claude
 *
 * KV layout:
 *   gh-state:<uuid>  -> serialized AuthRequest (5 min TTL, one-time use)
 */
import { Hono } from "hono";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { isAllowed } from "./allowlist";

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };

const GH_STATE_TTL_SECONDS = 300;
const USER_AGENT = "bluedot-rag";

interface GitHubTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GitHubUser {
  id: number;
  login: string;
  email?: string | null;
  name?: string | null;
}

export function createGitHubAuthApp() {
  const app = new Hono<{ Bindings: Bindings }>();

  app.get("/authorize", async (c) => {
    let authReq: AuthRequest;
    try {
      authReq = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
    } catch (_err) {
      return c.text("Invalid authorization request", 400);
    }

    const ghState = crypto.randomUUID();
    await c.env.OAUTH_KV.put(`gh-state:${ghState}`, JSON.stringify(authReq), {
      expirationTtl: GH_STATE_TTL_SECONDS,
    });

    const ghUrl = new URL("https://github.com/login/oauth/authorize");
    ghUrl.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID);
    ghUrl.searchParams.set(
      "redirect_uri",
      `${c.env.BASE_URL}/auth/github/callback`,
    );
    ghUrl.searchParams.set("scope", "read:user user:email");
    ghUrl.searchParams.set("state", ghState);

    return c.redirect(ghUrl.toString(), 302);
  });

  app.get("/auth/github/callback", async (c) => {
    const ghState = c.req.query("state");
    const code = c.req.query("code");

    if (!ghState) return c.text("Missing state", 400);
    if (!code) return c.text("Missing code", 400);

    const stashed = await c.env.OAUTH_KV.get<AuthRequest>(
      `gh-state:${ghState}`,
      "json",
    );
    if (!stashed) return c.text("Invalid or expired state", 400);
    // One-time use: delete immediately so replays fail.
    await c.env.OAUTH_KV.delete(`gh-state:${ghState}`);

    // Exchange code for GitHub access token
    const tokenResp = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({
          client_id: c.env.GITHUB_CLIENT_ID,
          client_secret: c.env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: `${c.env.BASE_URL}/auth/github/callback`,
        }),
      },
    );
    if (!tokenResp.ok) {
      return c.text(`GitHub token exchange failed: ${tokenResp.status}`, 502);
    }
    const tokenJson = (await tokenResp.json()) as GitHubTokenResponse;
    if (!tokenJson.access_token) {
      return c.text(
        `GitHub token exchange error: ${tokenJson.error_description ?? tokenJson.error ?? "no access_token"}`,
        502,
      );
    }

    // Fetch GitHub user
    const userResp = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokenJson.access_token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
      },
    });
    if (!userResp.ok) {
      return c.text(`GitHub user fetch failed: ${userResp.status}`, 502);
    }
    const user = (await userResp.json()) as GitHubUser;

    if (!isAllowed(user.login, c.env.ALLOWED_USERS)) {
      return c.text(
        `Not authorized: GitHub user '${user.login}' is not in the allowlist.`,
        403,
      );
    }

    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: stashed,
      userId: user.login,
      scope: stashed.scope,
      metadata: {
        github_id: user.id,
        email: user.email ?? null,
        name: user.name ?? null,
      },
      props: {
        login: user.login,
        github_id: user.id,
        email: user.email ?? null,
      },
    });

    return c.redirect(redirectTo, 302);
  });

  return app;
}
