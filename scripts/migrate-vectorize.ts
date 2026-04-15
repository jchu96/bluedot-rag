#!/usr/bin/env node
/**
 * One-off: re-embed all transcripts from D1 into a new Vectorize index.
 *
 * Used when renaming the Vectorize index (CF doesn't support rename).
 * Reads transcripts from whatever D1 database wrangler.toml currently points
 * at, chunks + embeds each, writes NDJSON, and invokes
 * `wrangler vectorize insert <INDEX> --file=...`.
 *
 * Run:
 *   set -a && source .dev.vars && set +a
 *   npx tsx scripts/migrate-vectorize.ts aftercall-vectors
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { chunkTranscript, generateEmbeddings } from "../src/embeddings";

const INDEX_NAME = process.argv[2];
if (!INDEX_NAME) {
  console.error("Usage: npx tsx scripts/migrate-vectorize.ts <index-name>");
  process.exit(1);
}
const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.error("OPENAI_API_KEY not set (source .dev.vars first)");
  process.exit(1);
}

interface Row {
  id: number;
  raw_text: string;
}

function runWrangler(args: string[]): string {
  const r = spawnSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    maxBuffer: 200 * 1024 * 1024,
  });
  if (r.status !== 0) {
    console.error(`wrangler ${args.join(" ")} failed:`, r.stderr || r.stdout);
    process.exit(1);
  }
  return r.stdout;
}

async function main() {
  console.log(`[migrate-vectorize] reading transcripts from D1...`);
  const out = runWrangler([
    "d1",
    "execute",
    "aftercall-db",
    "--remote",
    "--command",
    "SELECT id, raw_text FROM transcripts WHERE raw_text IS NOT NULL AND raw_text != ''",
    "--json",
  ]);
  const parsed = JSON.parse(out) as Array<{ results: Row[] }>;
  const rows = parsed[0]?.results ?? [];
  console.log(`[migrate-vectorize] found ${rows.length} transcripts with raw_text`);

  const openai = new OpenAI({ apiKey: OPENAI_KEY });
  const ndjsonPath = path.join(tmpdir(), `aftercall-vectors-${Date.now()}.ndjson`);
  let totalChunks = 0;
  const lines: string[] = [];

  for (const row of rows) {
    const chunks = chunkTranscript(row.raw_text, { maxTokens: 500, overlapTokens: 50 });
    const embedded = await generateEmbeddings(chunks, { client: openai });
    for (const e of embedded) {
      const id = `${row.id}-${e.chunkIndex}`;
      lines.push(JSON.stringify({
        id,
        values: e.embedding,
        metadata: { text: e.text, transcriptId: row.id, chunkIndex: e.chunkIndex },
      }));
      totalChunks++;
    }
    console.log(`  transcript ${row.id}: ${embedded.length} chunks embedded`);
  }

  writeFileSync(ndjsonPath, lines.join("\n") + "\n", "utf8");
  console.log(`[migrate-vectorize] wrote ${totalChunks} vectors to ${ndjsonPath}`);

  console.log(`[migrate-vectorize] inserting into ${INDEX_NAME}...`);
  runWrangler(["vectorize", "insert", INDEX_NAME, "--file", ndjsonPath]);

  unlinkSync(ndjsonPath);
  console.log(`[migrate-vectorize] done — ${totalChunks} vectors inserted into ${INDEX_NAME}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
