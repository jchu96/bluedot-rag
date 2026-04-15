import type { Env } from "./env";

// Phase 1 stub — full handler arrives in Phase 3.
export default {
  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response("Not yet implemented", { status: 501 });
  },
};
