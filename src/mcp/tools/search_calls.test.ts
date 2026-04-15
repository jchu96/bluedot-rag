import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { setupD1 } from "../../../test/setup-d1";
import { searchCalls } from "./search_calls";

describe("searchCalls", () => {
  beforeEach(async () => {
    await setupD1();
  });

  it("embeds the query, queries Vectorize, fetches matching transcripts, and formats results", async () => {
    await env.DB.prepare(
      `INSERT INTO transcripts (id, video_id, title, raw_text, summary)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(
        7,
        "https://meet.google.com/pierce-sync",
        "Pierce weekly sync",
        "raw",
        "Discussed IronRidge contract and next steps.",
      )
      .run();

    const vectorize = {
      query: vi.fn().mockResolvedValue({
        matches: [
          { id: "7-0", score: 0.89, metadata: { transcript_id: 7, chunk_index: 0, chunk_text: "About IronRidge contract" } },
          { id: "7-1", score: 0.81, metadata: { transcript_id: 7, chunk_index: 1, chunk_text: "Deeper discussion" } },
        ],
      }),
    } as unknown as VectorizeIndex;

    const openai = {
      embeddings: {
        create: vi.fn().mockResolvedValue({
          data: [{ embedding: new Array(1536).fill(0.1) }],
        }),
      },
    } as any;

    const out = await searchCalls(
      { query: "IronRidge", limit: 5 },
      env,
      { openai, vectorize },
    );

    expect(openai.embeddings.create).toHaveBeenCalledOnce();
    expect(vectorize.query).toHaveBeenCalledOnce();
    const [vec, opts] = (vectorize.query as any).mock.calls[0];
    expect(vec).toHaveLength(1536);
    expect(opts.topK).toBe(5);

    const text = out.content[0].text;
    expect(text).toContain("Pierce weekly sync");
    expect(text).toContain("IronRidge");
    expect(text).toContain("https://meet.google.com/pierce-sync");
    // Score should appear
    expect(text).toMatch(/0\.89|0\.8[0-9]/);
  });

  it("defaults limit to 5 when not provided", async () => {
    const vectorize = {
      query: vi.fn().mockResolvedValue({ matches: [] }),
    } as unknown as VectorizeIndex;
    const openai = {
      embeddings: {
        create: vi.fn().mockResolvedValue({
          data: [{ embedding: new Array(1536).fill(0.1) }],
        }),
      },
    } as any;

    await searchCalls({ query: "anything" }, env, { openai, vectorize });
    expect((vectorize.query as any).mock.calls[0][1].topK).toBe(5);
  });

  it("dedupes multiple chunks from the same transcript", async () => {
    await env.DB.prepare(
      `INSERT INTO transcripts (id, video_id, title, raw_text, summary)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(3, "video-3", "Only Result", "raw", "summary")
      .run();

    const vectorize = {
      query: vi.fn().mockResolvedValue({
        matches: [
          { id: "3-0", score: 0.9, metadata: { transcript_id: 3, chunk_index: 0, chunk_text: "chunk a" } },
          { id: "3-1", score: 0.8, metadata: { transcript_id: 3, chunk_index: 1, chunk_text: "chunk b" } },
          { id: "3-2", score: 0.7, metadata: { transcript_id: 3, chunk_index: 2, chunk_text: "chunk c" } },
        ],
      }),
    } as unknown as VectorizeIndex;
    const openai = {
      embeddings: {
        create: vi.fn().mockResolvedValue({
          data: [{ embedding: new Array(1536).fill(0.1) }],
        }),
      },
    } as any;

    const out = await searchCalls({ query: "q" }, env, { openai, vectorize });
    const occurrences = (out.content[0].text.match(/Only Result/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("returns an empty-result message when Vectorize returns no matches", async () => {
    const vectorize = {
      query: vi.fn().mockResolvedValue({ matches: [] }),
    } as unknown as VectorizeIndex;
    const openai = {
      embeddings: {
        create: vi.fn().mockResolvedValue({
          data: [{ embedding: new Array(1536).fill(0.1) }],
        }),
      },
    } as any;

    const out = await searchCalls({ query: "obscure" }, env, { openai, vectorize });
    expect(out.content[0].text.toLowerCase()).toContain("no matches");
  });
});
