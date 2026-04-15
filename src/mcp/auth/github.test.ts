import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { createGitHubAuthApp } from "./github";

type McpEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

const CLAUDE_AUTH_REQ: AuthRequest = {
  responseType: "code",
  clientId: "claude-client-id",
  redirectUri: "https://claude.ai/callback",
  scope: ["mcp:tools"],
  state: "claude-state-123",
  codeChallenge: "abc",
  codeChallengeMethod: "S256",
} as unknown as AuthRequest;

function makeOAuthProvider(overrides: Partial<OAuthHelpers> = {}): OAuthHelpers {
  return {
    parseAuthRequest: vi.fn(async () => CLAUDE_AUTH_REQ),
    completeAuthorization: vi.fn(async () => ({
      redirectTo: "https://claude.ai/callback?code=oauth-code-xyz&state=claude-state-123",
    })),
    lookupClient: vi.fn(),
    createClient: vi.fn(),
    listClients: vi.fn(),
    updateClient: vi.fn(),
    deleteClient: vi.fn(),
    listUserGrants: vi.fn(),
    revokeGrant: vi.fn(),
    unwrapToken: vi.fn(),
    exchangeToken: vi.fn(),
    ...overrides,
  } as unknown as OAuthHelpers;
}

function makeEnv(overrides: Partial<McpEnv> = {}): McpEnv {
  return {
    ...env,
    OAUTH_PROVIDER: makeOAuthProvider(),
    ...overrides,
  } as McpEnv;
}

describe("createGitHubAuthApp", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("GET /authorize", () => {
    it("stashes Claude auth request in KV (5 min TTL) and redirects to github.com", async () => {
      const testEnv = makeEnv();
      const app = createGitHubAuthApp();

      const res = await app.request(
        "https://worker.test/authorize?response_type=code&client_id=claude-client-id&state=claude-state-123",
        {},
        testEnv,
      );

      expect(res.status).toBe(302);
      const loc = res.headers.get("location")!;
      expect(loc).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);

      const locUrl = new URL(loc);
      expect(locUrl.searchParams.get("client_id")).toBe("gh-client-test");
      expect(locUrl.searchParams.get("redirect_uri")).toBe(
        "https://bluedot-rag.test.workers.dev/auth/github/callback",
      );
      expect(locUrl.searchParams.get("scope")).toBe("read:user user:email");
      const ghState = locUrl.searchParams.get("state")!;
      expect(ghState).toBeTruthy();
      expect(ghState.length).toBeGreaterThan(8);

      // KV contents
      const stashed = await testEnv.OAUTH_KV.get(`gh-state:${ghState}`, "json");
      expect(stashed).toEqual(CLAUDE_AUTH_REQ);
    });

    it("returns 400 when parseAuthRequest rejects (invalid Claude request)", async () => {
      const testEnv = makeEnv({
        OAUTH_PROVIDER: makeOAuthProvider({
          parseAuthRequest: vi.fn(async () => {
            throw new Error("bad request");
          }),
        }),
      });
      const app = createGitHubAuthApp();

      const res = await app.request("https://worker.test/authorize", {}, testEnv);
      expect(res.status).toBe(400);
    });
  });

  describe("GET /auth/github/callback", () => {
    it("exchanges code, fetches user, allowlist-passes, completes authorization and 302s to Claude", async () => {
      const testEnv = makeEnv();
      const ghState = "gh-state-abc123";
      await testEnv.OAUTH_KV.put(`gh-state:${ghState}`, JSON.stringify(CLAUDE_AUTH_REQ));

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input: any) => {
          const url = typeof input === "string" ? input : input.url;
          if (url.startsWith("https://github.com/login/oauth/access_token")) {
            return new Response(JSON.stringify({ access_token: "gho_test_token" }), {
              headers: { "content-type": "application/json" },
            });
          }
          if (url === "https://api.github.com/user") {
            return new Response(
              JSON.stringify({ id: 99, login: "jchu96", email: "j@example.com" }),
              { headers: { "content-type": "application/json" } },
            );
          }
          throw new Error("unexpected fetch: " + url);
        });

      const app = createGitHubAuthApp();
      const res = await app.request(
        `https://worker.test/auth/github/callback?code=gh-code&state=${ghState}`,
        {},
        testEnv,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        "https://claude.ai/callback?code=oauth-code-xyz&state=claude-state-123",
      );

      // KV should be cleaned up (one-time use)
      const stashed = await testEnv.OAUTH_KV.get(`gh-state:${ghState}`);
      expect(stashed).toBeNull();

      // completeAuthorization called with allowlisted user
      const completeCall = (testEnv.OAUTH_PROVIDER.completeAuthorization as any).mock
        .calls[0][0];
      expect(completeCall.userId).toBe("jchu96");
      expect(completeCall.request).toEqual(CLAUDE_AUTH_REQ);
      expect(completeCall.scope).toEqual(["mcp:tools"]);

      fetchSpy.mockRestore();
    });

    it("returns 403 when GitHub user is not in allowlist", async () => {
      const testEnv = makeEnv();
      const ghState = "gh-state-mal";
      await testEnv.OAUTH_KV.put(`gh-state:${ghState}`, JSON.stringify(CLAUDE_AUTH_REQ));

      vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith("https://github.com/login/oauth/access_token")) {
          return new Response(JSON.stringify({ access_token: "t" }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ id: 1, login: "mallory", email: "m@x.com" }),
          { headers: { "content-type": "application/json" } },
        );
      });

      const app = createGitHubAuthApp();
      const res = await app.request(
        `https://worker.test/auth/github/callback?code=gh-code&state=${ghState}`,
        {},
        testEnv,
      );

      expect(res.status).toBe(403);
      const body = await res.text();
      expect(body).toContain("mallory");
      expect(testEnv.OAUTH_PROVIDER.completeAuthorization).not.toHaveBeenCalled();
    });

    it("returns 400 for missing state param", async () => {
      const testEnv = makeEnv();
      const app = createGitHubAuthApp();

      const res = await app.request(
        "https://worker.test/auth/github/callback?code=gh-code",
        {},
        testEnv,
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 for unknown/expired state (not in KV)", async () => {
      const testEnv = makeEnv();
      const app = createGitHubAuthApp();

      const res = await app.request(
        "https://worker.test/auth/github/callback?code=gh-code&state=nonexistent",
        {},
        testEnv,
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 for missing code param", async () => {
      const testEnv = makeEnv();
      const ghState = "gh-state-nocode";
      await testEnv.OAUTH_KV.put(`gh-state:${ghState}`, JSON.stringify(CLAUDE_AUTH_REQ));

      const app = createGitHubAuthApp();
      const res = await app.request(
        `https://worker.test/auth/github/callback?state=${ghState}`,
        {},
        testEnv,
      );
      expect(res.status).toBe(400);
    });
  });
});
