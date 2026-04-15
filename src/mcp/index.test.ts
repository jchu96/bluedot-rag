import { describe, it, expect } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "./index";

async function call(request: Request) {
  const ctx = createExecutionContext();
  const res = await worker.fetch!(request, env as any, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("OAuthProvider integration", () => {
  describe("well-known metadata", () => {
    it("serves /.well-known/oauth-protected-resource/mcp with resource matching the MCP URL", async () => {
      const res = await call(
        new Request("https://worker.test/.well-known/oauth-protected-resource/mcp"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.resource).toBe("https://worker.test/mcp");
      expect(Array.isArray(body.authorization_servers)).toBe(true);
      expect(body.authorization_servers).toContain("https://worker.test");
    });

    it("serves /.well-known/oauth-authorization-server with authorize/token endpoints", async () => {
      const res = await call(
        new Request("https://worker.test/.well-known/oauth-authorization-server"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.authorization_endpoint).toBe("https://worker.test/authorize");
      expect(body.token_endpoint).toBe("https://worker.test/token");
      expect(body.registration_endpoint).toBe("https://worker.test/register");
      expect(body.scopes_supported).toContain("mcp:tools");
    });
  });

  describe("bearer enforcement on /mcp", () => {
    it("returns 401 with WWW-Authenticate header pointing at resource metadata when no bearer", async () => {
      const res = await call(new Request("https://worker.test/mcp", { method: "POST" }));
      expect(res.status).toBe(401);
      const www = res.headers.get("www-authenticate");
      expect(www).toBeTruthy();
      expect(www).toMatch(/^Bearer /);
      expect(www).toContain(
        `resource_metadata="https://worker.test/.well-known/oauth-protected-resource/mcp"`,
      );
    });

    it("returns 401 with WWW-Authenticate when bearer is bogus", async () => {
      const res = await call(
        new Request("https://worker.test/mcp", {
          method: "POST",
          headers: { Authorization: "Bearer not-a-real-token" },
        }),
      );
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/resource_metadata=/);
    });
  });

  describe("POST /auth/revoke", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await call(
        new Request("https://worker.test/auth/revoke", { method: "POST" }),
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 for malformed bearer", async () => {
      const res = await call(
        new Request("https://worker.test/auth/revoke", {
          method: "POST",
          headers: { Authorization: "Basic abc" },
        }),
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 for invalid bearer (not in token store)", async () => {
      const res = await call(
        new Request("https://worker.test/auth/revoke", {
          method: "POST",
          headers: { Authorization: "Bearer unknown-token-value" },
        }),
      );
      expect(res.status).toBe(401);
    });
  });

  describe("webhook fallback", () => {
    it("GET / returns health JSON (not webhook)", async () => {
      const res = await call(new Request("https://worker.test/"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.service).toBe("aftercall");
    });

    it("POST / without svix signature returns 401 (webhook path)", async () => {
      const res = await call(
        new Request("https://worker.test/", {
          method: "POST",
          body: JSON.stringify({ type: "video.transcript.created" }),
          headers: { "content-type": "application/json" },
        }),
      );
      // Webhook rejects missing signature with 401.
      expect(res.status).toBe(401);
    });

    it("GET /some-random-path returns 404", async () => {
      const res = await call(new Request("https://worker.test/nonexistent"));
      expect(res.status).toBe(404);
    });
  });
});
