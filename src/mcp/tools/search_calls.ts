import OpenAI from "openai";
import type { Env } from "../../env";
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "../../embeddings";
import type { ToolResult } from "./recent_calls";

export interface SearchCallsInput {
  query: string;
  limit?: number;
}

export interface SearchCallsDeps {
  openai?: OpenAI;
  vectorize?: VectorizeIndex;
}

interface TranscriptRow {
  id: number;
  video_id: string;
  title: string;
  created_at: string;
  summary: string | null;
}

export async function searchCalls(
  input: SearchCallsInput,
  env: Env,
  deps: SearchCallsDeps = {},
): Promise<ToolResult> {
  const limit = Math.max(1, Math.min(input.limit ?? 5, 25));
  const openai = deps.openai ?? new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const vectorize = deps.vectorize ?? env.VECTORIZE;

  const embedResp = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: input.query,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  const queryVector = embedResp.data[0].embedding;

  const queryResult = await vectorize.query(queryVector, {
    topK: limit,
    returnMetadata: "all",
  });

  if (!queryResult.matches || queryResult.matches.length === 0) {
    return {
      content: [
        { type: "text", text: `No matches found for "${input.query}".` },
      ],
    };
  }

  // Dedup by transcript_id, keeping best score per transcript.
  const bestScore = new Map<number, number>();
  const bestChunk = new Map<number, string>();
  for (const m of queryResult.matches) {
    const tid = Number((m.metadata as any)?.transcript_id);
    if (!Number.isFinite(tid)) continue;
    if (!bestScore.has(tid) || m.score > bestScore.get(tid)!) {
      bestScore.set(tid, m.score);
      bestChunk.set(tid, String((m.metadata as any)?.chunk_text ?? ""));
    }
  }

  const transcriptIds = [...bestScore.keys()];
  if (transcriptIds.length === 0) {
    return {
      content: [
        { type: "text", text: `No matches found for "${input.query}".` },
      ],
    };
  }

  const placeholders = transcriptIds.map((_, i) => `?${i + 1}`).join(",");
  const { results } = await env.DB.prepare(
    `SELECT id, video_id, title, created_at, summary
     FROM transcripts WHERE id IN (${placeholders})`,
  )
    .bind(...transcriptIds)
    .all<TranscriptRow>();

  const byId = new Map<number, TranscriptRow>();
  for (const r of results ?? []) byId.set(r.id, r);

  // Preserve score ordering
  const ordered = transcriptIds
    .map((id) => ({ id, score: bestScore.get(id)!, row: byId.get(id) }))
    .filter((x) => x.row)
    .sort((a, b) => b.score - a.score);

  if (ordered.length === 0) {
    return {
      content: [
        { type: "text", text: `No matches found for "${input.query}".` },
      ],
    };
  }

  const lines = ordered.map(({ score, row }) => {
    const r = row!;
    const date = r.created_at.split(" ")[0];
    const chunkPreview = (bestChunk.get(r.id) ?? "")
      .slice(0, 140)
      .replace(/\s+/g, " ");
    const preview = chunkPreview ? `\n   > ${chunkPreview}${chunkPreview.length >= 140 ? "…" : ""}` : "";
    return `• [${date}] **${r.title}** (score ${score.toFixed(2)}) — \`${r.video_id}\`${preview}`;
  });

  return {
    content: [
      {
        type: "text",
        text: `Found ${ordered.length} call${ordered.length === 1 ? "" : "s"} matching "${input.query}":\n\n${lines.join("\n")}`,
      },
    ],
  };
}
