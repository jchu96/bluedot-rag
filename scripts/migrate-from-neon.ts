/**
 * One-off migration: copy historical transcripts from the predecessor
 * personal-os Neon database into the new D1 + Vectorize + Notion Followups.
 *
 * Skips Notion transcript page creation (Bluedot already created those
 * originally, and the user explicitly opted out).
 *
 * Run from /Users/jeremychu/repos/bluedot-rag/:
 *   set -a && source /Users/jeremychu/repos/REDACTED/.env.local && set +a
 *   npx tsx scripts/migrate-from-neon.ts
 */
import { neon } from "@neondatabase/serverless";
import OpenAI from "openai";
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";

const D1_NAME = "bluedot-rag-db";
const VECTORIZE_NAME = "bluedot-rag-vectors";
const FOLLOWUPS_DS = "f04d875e-00a1-4241-8ee1-c73217310212";

interface OldRow {
  id: number;
  video_id: string;
  title: string;
  raw_text: string;
  summary: string;
  participants: Array<{ name?: string; email?: string; role?: string }>;
  action_items: Array<{ task: string; owner?: string; due_date?: string }>;
  language: string | null;
  svix_id: string | null;
  created_at: string;
}

const NEON_URL = process.env.DATABASE_URL!;
const OPENAI_KEY = process.env.OPENAI_API_KEY!;
const NOTION_KEY = process.env.NOTION_INTEGRATION_KEY!;

if (!NEON_URL || !OPENAI_KEY || !NOTION_KEY) {
  console.error("Missing env vars (DATABASE_URL, OPENAI_API_KEY, NOTION_INTEGRATION_KEY)");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_KEY });

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

function runWrangler(args: string[], opts: { input?: string } = {}): string {
  const r = spawnSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    input: opts.input,
    maxBuffer: 50 * 1024 * 1024,
  });
  if (r.status !== 0) {
    console.error(`wrangler ${args.join(" ")} failed:`, r.stderr || r.stdout);
    process.exit(1);
  }
  return r.stdout;
}

/** Run SQL via a temp file using D1 query API (not the bulk-import one). */
function runD1SQL(sql: string): string {
  // Use --command for short queries; for longer ones we have to chunk
  // Most reliable: use the query API directly via wrangler dev command with --persist-to off
  // For now: use --command and rely on shell's argument length limit (~256KB)
  return runWrangler(["d1", "execute", D1_NAME, "--remote", "--command", sql, "--json"]);
}

function chunkText(text: string, maxChars = 2000, overlapChars = 200): string[] {
  if (text.length <= maxChars) return [text.trim()];
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const end = Math.min(cursor + maxChars, text.length);
    let sliceEnd = end;
    if (end < text.length) {
      const window = text.slice(cursor, end);
      const sentenceMatch = window.match(/[.!?]\s[^.!?]*$/);
      if (sentenceMatch?.index !== undefined) sliceEnd = cursor + sentenceMatch.index + 1;
      else {
        const lastSpace = window.lastIndexOf(" ");
        if (lastSpace > maxChars * 0.5) sliceEnd = cursor + lastSpace;
      }
    }
    const chunkText = text.slice(cursor, sliceEnd).trim();
    if (chunkText) chunks.push(chunkText);
    if (sliceEnd >= text.length) break;
    cursor = Math.max(cursor + 1, sliceEnd - overlapChars);
  }
  return chunks;
}

function parseIsoDate(input: string | undefined): string | null {
  if (!input) return null;
  return /^\d{4}-\d{2}-\d{2}(T|$)/.test(input) ? input : null;
}

function followupTitle(task: string, due?: string): string {
  if (!due || /^\d{4}-\d{2}-\d{2}(T|$)/.test(due)) return task;
  return `${task} (due ${due})`;
}

async function migrateOne(row: OldRow): Promise<void> {
  console.log(`\n=== ${row.id}: ${row.title.slice(0, 60)}`);

  // 1. Insert into D1, mark notion_synced so worker won't try to create transcript page later
  const insertSQL = `INSERT INTO transcripts (
      video_id, title, raw_text, summary, bluedot_summary,
      participants, action_items, language, svix_id,
      notion_page_id, notion_synced_at, created_at
    ) VALUES (
      '${sqlEscape(row.video_id)}', '${sqlEscape(row.title)}',
      '${sqlEscape(row.raw_text)}', '${sqlEscape(row.summary)}',
      '${sqlEscape(row.summary)}',
      '${sqlEscape(JSON.stringify(row.participants || []))}',
      '${sqlEscape(JSON.stringify(row.action_items || []))}',
      ${row.language ? `'${sqlEscape(row.language)}'` : "NULL"},
      ${row.svix_id ? `'${sqlEscape(row.svix_id)}'` : "NULL"},
      'migrated-from-neon',
      datetime('now'),
      '${row.created_at}'
    ) ON CONFLICT(video_id) DO NOTHING RETURNING id;`;

  const out = runD1SQL(insertSQL);

  let newId: number;
  try {
    const parsed = JSON.parse(out);
    const results = parsed[0]?.results;
    if (!results || results.length === 0) {
      console.log(`  ⊘ Already exists in D1; fetching existing id`);
      const lookupOut = runD1SQL(
        `SELECT id FROM transcripts WHERE video_id = '${sqlEscape(row.video_id)}';`,
      );
      newId = JSON.parse(lookupOut)[0].results[0].id;
    } else {
      newId = results[0].id;
      console.log(`  ✓ D1 row inserted (id ${newId})`);
    }
  } catch (e) {
    console.error(`  ✗ Failed to parse D1 output:`, out);
    throw e;
  }

  // 2. Embed raw_text + upsert to Vectorize
  if (row.raw_text && row.raw_text.length > 0) {
    const chunks = chunkText(row.raw_text);
    console.log(`  Embedding ${chunks.length} chunk(s)...`);
    const embResp = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: chunks,
    });

    const vectors = embResp.data.map((d, i) => ({
      id: `${newId}-${i}`,
      values: d.embedding,
      metadata: {
        transcript_id: newId,
        chunk_index: i,
        chunk_text: chunks[i].slice(0, 2048),
      },
    }));

    const ndjson = vectors.map((v) => JSON.stringify(v)).join("\n");
    const vecFile = `/tmp/migrate-${row.id}-vectors.ndjson`;
    writeFileSync(vecFile, ndjson);
    runWrangler(["vectorize", "insert", VECTORIZE_NAME, "--file", vecFile]);
    unlinkSync(vecFile);
    console.log(`  ✓ ${vectors.length} vector(s) upserted`);
  } else {
    console.log(`  ⊘ Skipping embeddings (no raw_text)`);
  }

  // 3. Create Followup rows in Notion
  const meetingUrl =
    row.video_id.startsWith("http")
      ? row.video_id
      : row.video_id.includes("meet.google.com/") || row.video_id.includes("zoom.us/")
      ? `https://${row.video_id}`
      : undefined;

  let followupsCreated = 0;
  for (const item of row.action_items || []) {
    const isoDate = parseIsoDate(item.due_date);
    const titleText = followupTitle(item.task, item.due_date).slice(0, 2000);
    const properties: Record<string, unknown> = {
      Name: { title: [{ type: "text", text: { content: titleText } }] },
      Status: { select: { name: "Inbox" } },
      Priority: { select: { name: "P2" } },
      Due: isoDate ? { date: { start: isoDate } } : { date: null },
      Owner: { rich_text: [{ type: "text", text: { content: item.owner ?? "" } }] },
      Source: { select: { name: "Bluedot" } },
      "Source Link": meetingUrl ? { url: meetingUrl } : { url: null },
      "Meeting Title": { rich_text: [{ type: "text", text: { content: row.title.slice(0, 2000) } }] },
      "Video ID": { rich_text: [{ type: "text", text: { content: row.video_id.slice(0, 2000) } }] },
    };

    const resp = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_KEY}`,
        "Notion-Version": "2025-09-03",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parent: { type: "data_source_id", data_source_id: FOLLOWUPS_DS },
        properties,
      }),
    });
    if (!resp.ok) {
      console.error(`  ✗ Followup failed: ${await resp.text()}`);
    } else {
      followupsCreated++;
    }
  }
  console.log(`  ✓ ${followupsCreated}/${row.action_items?.length ?? 0} Followups created`);
}

async function main() {
  const sql = neon(NEON_URL);
  const rows = await sql`SELECT * FROM transcripts ORDER BY id`;
  console.log(`Found ${rows.length} historical transcripts to migrate.\n`);

  for (const row of rows) {
    try {
      await migrateOne(row as unknown as OldRow);
    } catch (err) {
      console.error(`Failed for ${row.id}:`, err);
    }
  }

  console.log("\nDone.");
}

main().catch(console.error);
