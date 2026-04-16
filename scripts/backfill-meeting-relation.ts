/**
 * Phase 1b backfill — populate the Meeting relation on every Followup row.
 *
 * For each Followup row: look up the Transcripts page by Video ID and
 * set the Meeting relation. Idempotent (skips rows already having Meeting
 * populated). Rate-limited to stay under Notion's 3 req/s cap. Resumable
 * via a local checkpoint file.
 *
 * Usage:
 *   NOTION_INTEGRATION_KEY=ntn_... \
 *   NOTION_TRANSCRIPTS_DATA_SOURCE_ID=70c2fa08-... \
 *   NOTION_FOLLOWUPS_DATA_SOURCE_ID=d2a8aa9c-... \
 *   npx tsx scripts/backfill-meeting-relation.ts --dry-run
 *
 * Remove --dry-run to actually write.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const NOTION_KEY = process.env.NOTION_INTEGRATION_KEY;
const TRANSCRIPTS_DS = process.env.NOTION_TRANSCRIPTS_DATA_SOURCE_ID;
const FOLLOWUPS_DS = process.env.NOTION_FOLLOWUPS_DATA_SOURCE_ID;

if (!NOTION_KEY || !TRANSCRIPTS_DS || !FOLLOWUPS_DS) {
  console.error(
    "Missing env: NOTION_INTEGRATION_KEY, NOTION_TRANSCRIPTS_DATA_SOURCE_ID, NOTION_FOLLOWUPS_DATA_SOURCE_ID",
  );
  process.exit(1);
}

const DRY_RUN = process.argv.includes("--dry-run");
const CHECKPOINT_FILE =
  process.argv.find((a) => a.startsWith("--checkpoint-file="))?.split("=")[1] ??
  "/tmp/aftercall-backfill-checkpoint.json";
const INTER_REQUEST_MS = 400;
const NOTION_VERSION = "2025-09-03";

interface Checkpoint {
  processed: Record<string, string>;
  lastRun: string;
}

function loadCheckpoint(): Checkpoint {
  if (!existsSync(CHECKPOINT_FILE)) {
    return { processed: {}, lastRun: new Date().toISOString() };
  }
  return JSON.parse(readFileSync(CHECKPOINT_FILE, "utf8")) as Checkpoint;
}

function saveCheckpoint(cp: Checkpoint): void {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

interface NotionPage {
  id: string;
  properties: Record<string, {
    type: string;
    rich_text?: Array<{ plain_text: string }>;
    relation?: Array<{ id: string }>;
    title?: Array<{ plain_text: string }>;
  }>;
}

interface QueryResponse {
  results: NotionPage[];
  next_cursor: string | null;
  has_more: boolean;
}

async function notionFetch(path: string, init: RequestInit): Promise<Response> {
  let attempt = 0;
  while (true) {
    const resp = await fetch(`https://api.notion.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${NOTION_KEY}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (resp.ok) return resp;
    if (resp.status === 429 && attempt < 3) {
      const backoff = 1000 * Math.pow(2, attempt);
      console.warn(`  429 from Notion, backing off ${backoff}ms...`);
      await sleep(backoff);
      attempt++;
      continue;
    }
    const txt = await resp.text();
    throw new Error(`Notion ${resp.status}: ${txt.slice(0, 300)}`);
  }
}

async function queryAllPages(dataSourceId: string): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let cursor: string | null = null;
  do {
    const body: Record<string, unknown> = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const resp = await notionFetch(`/v1/data_sources/${dataSourceId}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const data = (await resp.json()) as QueryResponse;
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
    if (cursor) await sleep(INTER_REQUEST_MS);
  } while (cursor);
  return pages;
}

function getRichText(page: NotionPage, propName: string): string | null {
  const prop = page.properties[propName];
  if (!prop) return null;
  if (prop.type === "title" && prop.title?.[0]) return prop.title[0].plain_text;
  if (prop.type === "rich_text" && prop.rich_text?.[0]) return prop.rich_text[0].plain_text;
  return null;
}

function getRelation(page: NotionPage, propName: string): string[] {
  const prop = page.properties[propName];
  if (!prop || prop.type !== "relation") return [];
  return (prop.relation ?? []).map((r) => r.id);
}

async function main(): Promise<void> {
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`Checkpoint: ${CHECKPOINT_FILE}`);

  console.log("\n→ Loading Transcripts rows (building Video ID → page ID map)...");
  const transcripts = await queryAllPages(TRANSCRIPTS_DS!);
  console.log(`  Found ${transcripts.length} transcripts`);

  const videoIdToPageId = new Map<string, string>();
  for (const t of transcripts) {
    const videoId = getRichText(t, "Video ID");
    if (videoId) videoIdToPageId.set(videoId, t.id);
  }
  console.log(`  Mapped ${videoIdToPageId.size} Video IDs`);

  console.log("\n→ Loading Followups rows...");
  const followups = await queryAllPages(FOLLOWUPS_DS!);
  console.log(`  Found ${followups.length} followups`);

  const checkpoint = loadCheckpoint();

  let planned = 0;
  let skippedAlreadyLinked = 0;
  let skippedAlreadyProcessed = 0;
  let skippedNoVideoId = 0;
  let skippedNoTranscript = 0;
  let succeeded = 0;
  let failed = 0;

  for (const followup of followups) {
    if (getRelation(followup, "Meeting").length > 0) {
      skippedAlreadyLinked++;
      continue;
    }
    if (checkpoint.processed[followup.id]) {
      skippedAlreadyProcessed++;
      continue;
    }
    const videoId = getRichText(followup, "Video ID");
    if (!videoId) {
      skippedNoVideoId++;
      console.warn(`  ⊘ Followup ${followup.id} has no Video ID`);
      continue;
    }
    const transcriptPageId = videoIdToPageId.get(videoId);
    if (!transcriptPageId) {
      skippedNoTranscript++;
      console.warn(`  ⊘ Followup ${followup.id} — no transcript for Video ID ${videoId}`);
      continue;
    }

    planned++;
    const title = getRichText(followup, "Name") ?? "(no title)";
    const line = `  → Followup ${followup.id} [${title.slice(0, 50)}] → Meeting ${transcriptPageId}`;
    if (DRY_RUN) {
      console.log(line);
      continue;
    }

    try {
      await notionFetch(`/v1/pages/${followup.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          properties: {
            Meeting: { relation: [{ id: transcriptPageId }] },
          },
        }),
      });
      console.log(`  ✓ ${line.slice(3)}`);
      succeeded++;
      checkpoint.processed[followup.id] = transcriptPageId;
      checkpoint.lastRun = new Date().toISOString();
      saveCheckpoint(checkpoint);
      await sleep(INTER_REQUEST_MS);
    } catch (err) {
      failed++;
      console.error(`  ✗ Failed ${followup.id}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log("\n--- Summary ---");
  console.log(`  Planned updates:          ${planned}`);
  console.log(`  Skipped (already linked): ${skippedAlreadyLinked}`);
  console.log(`  Skipped (checkpointed):   ${skippedAlreadyProcessed}`);
  console.log(`  Skipped (no Video ID):    ${skippedNoVideoId}`);
  console.log(`  Skipped (no transcript):  ${skippedNoTranscript}`);
  if (!DRY_RUN) {
    console.log(`  Succeeded:                ${succeeded}`);
    console.log(`  Failed:                   ${failed}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
