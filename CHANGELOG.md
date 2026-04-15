# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-04-15

**MCP server with GitHub OAuth.** Indexed calls are now queryable from Claude.ai over the Model Context Protocol.

### Added

- MCP server at `/mcp` using `@modelcontextprotocol/sdk` Streamable HTTP transport in stateless mode.
- Five MCP tools with Zod schemas:
  - `search_calls(query, limit?)` — semantic search via OpenAI embeddings + Vectorize.
  - `get_call(video_id)` — full D1 transcript details.
  - `list_followups(status?, source?, limit?)` — query the Notion Followups DB.
  - `find_action_items_for(person, since?)` — `json_each` over the D1 `action_items` column.
  - `recent_calls(days?)` — last N days of calls ordered newest first.
- GitHub OAuth using `@cloudflare/workers-oauth-provider`. `/authorize` + `/auth/github/callback` mint MCP bearer tokens after verifying the caller's GitHub username against a comma-separated `ALLOWED_USERS` allowlist.
- `POST /auth/revoke` endpoint to invalidate a bearer token via `unwrapToken` + `revokeGrant`.
- `OAUTH_KV` KV namespace binding for OAuth state (`gh-state:*`, 5-min TTL) + OAuth provider's internal storage.
- Setup script step 8 that provisions `OAUTH_KV`, walks through GitHub OAuth App registration, collects `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `ALLOWED_USERS`, and writes everything to `wrangler.toml` + `.dev.vars`.
- Docs: `docs/architecture.md` (ingestion + OAuth + MCP query flow mermaid diagrams), `docs/tools.md` (tool reference with sample Claude.ai prompts), `docs/auth.md` (OAuth setup walkthrough + troubleshooting).
- `global_fetch_strictly_public` compatibility flag (required by `workers-oauth-provider`).

### Changed

- `src/index.ts` is now a thin re-export from `src/mcp/index.ts`, which wraps the Bluedot webhook handler + OAuth routes + MCP API handler under a single `OAuthProvider` default export.
- `Env` type extended with `OAUTH_KV`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ALLOWED_USERS`, `BASE_URL`.
- `src/mcp/handler.ts` dynamically imports `./tools` so the MCP SDK (and its transitive `ajv` dep) doesn't load on non-MCP code paths — keeps vitest-pool-workers' ESM shim happy.

### Notes

- End-to-end MCP transport (`tools/list`, `tools/call` through Streamable HTTP) is exercised by live Claude.ai smoke tests rather than automated — `ajv`'s internal JSON import breaks under vitest-pool-workers' ESM shim, but each tool's business logic is covered by a fast unit suite.
- Bluedot webhook (POST `/`) behavior is unchanged — the same signed payloads continue to flow through the ingestion pipeline.

## [0.1.0] — 2026-04-14

Initial public release. Bluedot → Cloudflare D1 + Vectorize → Notion Followups pipeline.

### Added

- Cloudflare Worker that verifies Svix-signed Bluedot webhooks and handles both `meeting.transcript.created` + `meeting.summary.created` event types.
- OpenAI structured extraction (`gpt-4.1-nano` via json_schema) to pull `{ title, summary, action_items[], participants[] }` from Bluedot's summary text.
- OpenAI embeddings (`text-embedding-3-small`, 1536d) on chunked transcript text, upserted to Cloudflare Vectorize with deterministic IDs (`{transcript_id}-{chunk_index}`).
- Cloudflare D1 `transcripts` table with `UNIQUE(video_id)` constraint for idempotent concurrent writes.
- Notion integration (direct `fetch`, not the SDK) that creates one page per meeting in a Call Transcripts DB and one row per action item in a Followups DB with `Status = Inbox`.
- Interactive `npm run setup` script that provisions D1, Vectorize, both Notion databases, and writes `.dev.vars` + `wrangler.toml`.
- Migration script for historical Neon transcripts → D1 + Vectorize + Followups.

[0.2.0]: https://github.com/jchu96/bluedot-rag/releases/tag/v0.2.0
[0.1.0]: https://github.com/jchu96/bluedot-rag/releases/tag/v0.1.0
