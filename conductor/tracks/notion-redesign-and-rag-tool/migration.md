# Migration Guide — Phase 1b + Phase 2 Prerequisites

Manual steps + scripted backfills to bring production data in sync with the new schema **before** new code is deployed.

> ⚠️ **Do not deploy Phase 1a code until the pre-flight checks below pass AND the backfill has run.**

---

## Pre-flight checks

Run these before touching anything. If any check fails, halt the track and rescope.

### Check 1: D1 `summary` column has full `summaryV2` markdown (rollback safety)

```bash
npx wrangler d1 execute aftercall-db --remote --command \
  "SELECT video_id, substr(summary, 1, 100) as head, length(summary) as len FROM transcripts ORDER BY id DESC LIMIT 3"
```

**Expected:** `head` starts with `## Overview` or similar markdown heading; `len` matches observed Bluedot summaryV2 sizes (often 5k–15k chars).

**If fail:** `summary` is a structured/truncated derivative — rollback becomes hard. Pause the track and decide whether to accept un-rollbackable migration or preserve `summary` differently.

### Check 2: Sample Followups row has `Video ID` property

```
In Notion: open Followups DB → any row → confirm `Video ID` property is populated with a non-empty string.
```

**Expected:** `Video ID` present and matches a row in D1 `transcripts.video_id`.

**If fail:** Backfill join key doesn't exist. Two options:
- (a) Add `Video ID` to Followups and backfill from D1's `action_items` JSON (harder)
- (b) Skip backfill; only new Followups get `Meeting` relation; historical Followups stay text-only

Decide explicitly; document the choice here before proceeding.

### Check 3: Notion integration write access

```
In Notion: Settings → Integrations → (your integration) → confirm Transcripts DB and Followups DB are both in the "Access" list.
```

**If fail:** Grant access via the "..." → "Add connections" menu on each DB.

---

## Notes from the 2026-04-16 execution

**Backfill was NOT run** on jchu96's production data. Pre-flight discovered the Video ID values in existing Followups rows did not match any Transcripts rows:

- Followups used Bluedot's internal Video ID (`69e147ed5f1492f692bb0122`) or the bare Google Meet slug (`meet.google.com/ahn-mfrm-hfm`)
- Transcripts used `https://meet.google.com/...` / `meet.google.com/...` for different meetings entirely — none overlapped

This happened because historical rows were created across code-path churn (pre-rebrand pipelines, `migrate-from-neon.ts`, different `videoId` conventions). Net: 11 historical Followups couldn't be automatically linked.

**Decision:** skip automated backfill. Historical Followups stay text-only (they keep `Meeting Title` + `Video ID` text properties, just no `Meeting` relation). New Followups created by the redeployed worker get the relation automatically.

**Rationale:** historical followups are either already triaged or stale; retroactive linking isn't worth the engineering cost of rebuilding the Transcripts DB from D1 (which would be path B, deferred).

**For forkers:** your data may be clean. Run the dry-run first — if matches look right, run live. If your data is mismatched like jchu96's was, decide whether to skip, rebuild Transcripts from D1, or clean up manually.

---

## Phase 1b: Notion schema + backfill

### Step 1: Update schemas via Notion UI

**Transcripts DB:**
1. Open the DB in Notion
2. `+ Add a property` → `URL` → name it `Recording URL`
3. `+ Add a property` → `URL` → name it `Bluedot Page`
4. **Do NOT delete** `Summary` or `Action Items` rich_text properties yet — new code ignores them; deleting archives them (irreversible via API, harmless but invisible)

**Followups DB:**
1. Open the DB in Notion
2. `+ Add a property` → `Relation` → name it `Meeting`
3. Target: `Call Transcripts` DB
4. Configure: show on related Transcripts page (bidirectional relation for the linked-view embed)

### Step 2: Dry-run the backfill script

```bash
# From repo root, loading .dev.vars for secrets
set -a && source .dev.vars && set +a
npx tsx scripts/backfill-meeting-relation.ts --dry-run
```

Review the output:
- Each line shows `Followup <id> → Meeting <transcript page id>` planned
- Count of rows: should match your Followups DB row count
- Any errors (missing video_id, missing transcripts row) surfaced

### Step 3: Execute the backfill

```bash
npx tsx scripts/backfill-meeting-relation.ts
```

Watch the log. Script writes a checkpoint file (`/tmp/aftercall-backfill-checkpoint.json`) after each successful update. If it dies or you ctrl-C, rerun — it resumes.

### Step 4: Audit

Open 3 random Followups in Notion:
1. Confirm `Meeting` field is populated
2. Click through → lands on the correct Transcripts page
3. The Transcripts page now shows this Followup in its related view (because the relation is bidirectional)

### Step 5: Deploy Phase 1a code

Now safe to deploy:

```bash
npm run deploy
```

Fire a real webhook (or wait for one) and verify new Transcripts pages + Followups have the expected slim schema.

---

## Phase 2 prerequisites: Vectorize metadata index + reindex

### Step 1: Create the metadata index

```bash
npx wrangler vectorize create-metadata-index aftercall-vectors \
  --property-name=transcript_id --type=number
```

This takes effect for **new** inserts only. Existing vectors are invisible to filter queries until reinserted.

### Step 2: Reinsert existing vectors

```bash
npx tsx scripts/reindex-vectorize.ts
```

The script:
- Reads every `transcripts` row from D1
- Regenerates embeddings via `generateEmbeddings` on `raw_text`
- Re-upserts via `upsertChunkEmbeddings` (idempotent — deterministic IDs overwrite cleanly)
- Rate-limited to stay under OpenAI embedding quota

**Cost estimate:** ~$0.00002/1k tokens × ~500 tokens/chunk × ~20 chunks/call × N calls. For 50 calls ≈ $0.01.

### Step 3: Verify filter works

Quick check via `scripts/smoke-answer.ts` (see Phase 2 implementation):

```bash
npx tsx scripts/smoke-answer.ts
```

If filters return matching chunks: ready to ship `answer_from_transcript`. If not: metadata index didn't take, debug via `wrangler vectorize list-metadata-indexes aftercall-vectors`.

---

## Rollback

If the redesign lands and you want to revert:

### Revert code

```bash
git revert <merge-commit-sha>
git push origin main
npm run deploy
```

### Revert Notion schema

The new properties (`Recording URL`, `Bluedot Page`, `Meeting`) are harmless if unused. Option 1: leave them, ignore. Option 2: archive them via the Notion UI.

The old `Summary` + `Action Items` rich_text properties were never removed (just stopped being written), so historical rows retain them.

### Revert Transcripts content

For historical meetings: re-run `createTranscriptPage` with the old code path against existing rows. Requires:
- Pre-flight Check 1 passed (D1 `summary` has full markdown)
- A one-off script that iterates D1 rows and calls the old `buildTranscriptPageBody`
- Updates existing Notion pages via `pages.update` (replacing children)

Not automated. Only run if actually needed.

### Revert Vectorize

Metadata index can stay — it doesn't affect non-filtered queries. If desired: `wrangler vectorize delete-metadata-index`.

Reinserted vectors are identical to what was there before (deterministic IDs). No action needed.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Backfill script: "Followup has no Video ID" | Check 2 failed; you proceeded anyway | Either backfill Video ID first or accept partial coverage |
| Backfill: 429 from Notion | Rate limit; script should retry | If persistent, increase the 400ms inter-request sleep |
| `answer_from_transcript` returns "no chunks found" on a fresh call | Vectorize eventual consistency | Wait 30s and retry; tool's D1 `raw_text` fallback should handle this |
| `answer_from_transcript` returns "no chunks found" on an old call | Metadata index not covering it; reindex missed it | Rerun `scripts/reindex-vectorize.ts` for that specific `video_id` |
| Bluedot Page URL never populates | Lookup logic is best-effort; Notion search is ranked+eventually-consistent | Manual population in Notion UI, or add a background retry job (out of scope for this track) |
