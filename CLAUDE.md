# bluedot-rag

Cloudflare Worker that ingests Bluedot meeting transcripts → OpenAI extraction + embeddings → Cloudflare D1 + Vectorize → Notion (transcript pages + Followups task DB).

## Architecture

| Layer | Tech |
|-------|------|
| Webhook + processing | Cloudflare Workers |
| Transcript store | Cloudflare D1 (SQLite, Drizzle schema) |
| Embeddings | Cloudflare Vectorize (1536d, cosine) |
| LLM | OpenAI `gpt-4.1-nano` (structured outputs) + `text-embedding-3-small` |
| Output | Notion API (direct fetch — NOT `@notionhq/client`, broken in workerd) |

Single user (single GitHub username allowlist for the future MCP track). Friends fork to host their own.

## Conventions

- **TDD strict** — failing test first, minimal impl, refactor
- **Conventional Commits** — `feat:`, `fix:`, `chore:`, `docs:`, etc.
- **Idempotency** is non-negotiable — D1 has `UNIQUE(video_id)`, Vectorize uses deterministic IDs (`{transcript_id}-{chunk_index}`)
- **D1 write FIRST** in the handler — gates Notion writes so concurrent retries dedupe before any side effects
- **Notion failures are non-fatal** — D1 is source of truth; Notion is a derived view
- **Pipeline failures return 500** so Svix retries

## Common Tasks

| Task | Command |
|------|---------|
| Run tests | `npx vitest run` |
| Typecheck | `npx tsc --noEmit` |
| Local dev (Vectorize remote) | `npx wrangler dev` |
| Deploy | `npx wrangler deploy` |
| Tail logs | `npx wrangler tail` |
| Generate D1 migration | `npx drizzle-kit generate --name <description>` |
| Apply D1 migration | `npx wrangler d1 migrations apply bluedot-rag-db --remote` |
| Set a secret | `npx wrangler secret put <NAME>` |
| Reprocess a call | `npx wrangler d1 execute bluedot-rag-db --remote --command "DELETE FROM transcripts WHERE video_id = '...'"` then refire |

## Don't

- ❌ Import `@notionhq/client` — fails in workerd (`Cannot read properties of undefined (reading 'call')`). Use direct `fetch`.
- ❌ Add a Notion `Title` property — Notion's default title property is named `Name`. Use `Name`.
- ❌ Test against mocked D1 — use `@cloudflare/vitest-pool-workers` so tests hit real SQLite via miniflare. Vectorize must still be mocked (no miniflare support yet).
- ❌ Forget `--remote` on `wrangler d1 migrations apply` for the prod database.
- ❌ Re-introduce Anthropic — single LLM provider (OpenAI) is intentional, simplifies deploy + setup story for forkers.

## Repo Layout

See [README.md](./README.md) for full structure. Quick map:

```
src/             # Worker code (handler, extract, d1, vectorize, notion, ...)
scripts/         # setup.ts (interactive provisioning), smoke-vectorize.ts
drizzle/         # Numbered SQL migrations
test/            # vitest setup (D1 migrations + ProvidedEnv typing)
```

## Plan-reviewer discipline

When making non-trivial changes, run a plan-reviewer pass before implementing. Track major architectural decisions in commit messages and link back to spec/plan docs in the parent `REDACTED` conductor track if relevant.
