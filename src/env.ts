/**
 * Worker environment bindings + secrets.
 *
 * D1 + Vectorize are native Cloudflare bindings configured in wrangler.toml.
 * Secrets are set via `wrangler secret put`.
 * Vars are set in wrangler.toml [vars] block.
 */
export interface Env {
  // Native Cloudflare bindings
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  OAUTH_KV: KVNamespace;

  // Secrets (wrangler secret put)
  OPENAI_API_KEY: string;
  NOTION_INTEGRATION_KEY: string;
  BLUEDOT_WEBHOOK_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;

  // Vars (wrangler.toml)
  OPENAI_EXTRACTION_MODEL: string;
  NOTION_TRANSCRIPTS_DATA_SOURCE_ID: string;
  NOTION_FOLLOWUPS_DATA_SOURCE_ID: string;
  ALLOWED_USERS: string;
  BASE_URL: string;
}
