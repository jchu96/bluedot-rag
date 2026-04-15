# bluedot-rag

> Auto-ingest Bluedot meeting transcripts into Cloudflare D1 + Vectorize, and route action items into a Notion Followups inbox.

Currently scaffolding — full README arrives in Phase 5.

## Stack

- **Cloudflare Workers** — webhook ingestion + processing
- **Cloudflare D1** — transcript storage (SQLite)
- **Cloudflare Vectorize** — embedding storage (1536d, cosine)
- **OpenAI** — `text-embedding-3-small` for vectors, `gpt-4.1-nano` for action item extraction
- **Notion** — Call Transcripts pages + Followups task DB
- **Bluedot** — meeting recordings + webhooks

## Status

In active development. See predecessor pipeline at [jeremy-personal-os/docs/bluedot-pipeline.md](https://github.com/jchu96/jeremy-personal-os/blob/main/docs/bluedot-pipeline.md) for the previous Neon-based architecture.
