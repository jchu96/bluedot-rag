/**
 * MCP API handler — mounted by OAuthProvider at `/mcp`, bearer required.
 * Delegates to the Streamable HTTP transport in ./tools.ts.
 *
 * The tools module is dynamically imported so loading the OAuth wrapper
 * for other routes (webhook, /authorize, etc.) doesn't pull the MCP SDK
 * (and its ajv dep) into scope. `ajv` has a `require('./refs/data.json')`
 * that vitest-pool-workers' module shim can't resolve — deferring the
 * import keeps non-MCP tests working.
 */
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };

export const mcpApiHandler = {
  async fetch(request: Request, env: Bindings, _ctx: ExecutionContext): Promise<Response> {
    const { handleMcpRequest } = await import("./tools");
    return handleMcpRequest(request, env);
  },
} satisfies ExportedHandler<Bindings>;
