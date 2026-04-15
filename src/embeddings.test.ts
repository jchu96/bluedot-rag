import { describe, it, expect, vi } from "vitest";
import { chunkTranscript, generateEmbeddings } from "./embeddings";

describe("chunkTranscript", () => {
  it("returns a single chunk for short input", () => {
    const chunks = chunkTranscript("Short transcript.", { maxTokens: 500 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("Short transcript.");
    expect(chunks[0].index).toBe(0);
  });

  it("splits long input into multiple overlapping chunks", () => {
    const text = Array.from({ length: 400 }, (_, i) => `Sentence number ${i}.`).join(" ");
    const chunks = chunkTranscript(text, { maxTokens: 200, overlapTokens: 20 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks.at(-1)!.index).toBe(chunks.length - 1);

    // Overlap: at least a few words of chunk 0's tail should appear somewhere
    // early in chunk 1 (sentence-boundary alignment may shift the exact start).
    const firstTail = chunks[0].text.split(/\s+/).slice(-5).join(" ");
    expect(chunks[1].text.slice(0, firstTail.length + 50)).toContain(firstTail);
  });

  it("preserves sentence boundaries where possible", () => {
    const sentences = Array.from({ length: 50 }, (_, i) => `This is sentence ${i}.`).join(" ");
    const chunks = chunkTranscript(sentences, { maxTokens: 100, overlapTokens: 10 });
    for (const chunk of chunks) {
      // Chunks should end with a period (preferring sentence boundary).
      expect(chunk.text.trim().endsWith(".")).toBe(true);
    }
  });

  it("rejects empty input", () => {
    expect(() => chunkTranscript("", { maxTokens: 100 })).toThrow(/empty/i);
    expect(() => chunkTranscript("   ", { maxTokens: 100 })).toThrow(/empty/i);
  });
});

describe("generateEmbeddings", () => {
  it("calls OpenAI embeddings API and returns vectors", async () => {
    const mockEmbedding = new Array(1536).fill(0).map((_, i) => i / 1536);
    const mockCreate = vi.fn().mockResolvedValue({
      data: [
        { embedding: mockEmbedding, index: 0 },
        { embedding: mockEmbedding, index: 1 },
      ],
      model: "text-embedding-3-small",
      usage: { total_tokens: 50 },
    });
    const fakeClient = { embeddings: { create: mockCreate } };

    const result = await generateEmbeddings(
      [
        { index: 0, text: "first chunk" },
        { index: 1, text: "second chunk" },
      ],
      { client: fakeClient as never },
    );

    expect(result).toHaveLength(2);
    expect(result[0].embedding).toHaveLength(1536);
    expect(result[0].chunkIndex).toBe(0);
    expect(result[1].chunkIndex).toBe(1);
    expect(mockCreate).toHaveBeenCalledWith({
      model: "text-embedding-3-small",
      input: ["first chunk", "second chunk"],
    });
  });

  it("retries on transient server errors", async () => {
    const err = Object.assign(new Error("server"), { status: 502 });
    const mockCreate = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({
        data: [{ embedding: new Array(1536).fill(0.1), index: 0 }],
        model: "text-embedding-3-small",
        usage: { total_tokens: 10 },
      });

    const result = await generateEmbeddings(
      [{ index: 0, text: "one" }],
      { client: { embeddings: { create: mockCreate } } as never, retryDelayMs: 1 },
    );

    expect(result).toHaveLength(1);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 4xx errors", async () => {
    const err = Object.assign(new Error("bad"), { status: 400 });
    const mockCreate = vi.fn().mockRejectedValue(err);

    await expect(
      generateEmbeddings([{ index: 0, text: "x" }], {
        client: { embeddings: { create: mockCreate } } as never,
        retryDelayMs: 1,
      }),
    ).rejects.toThrow(/bad/);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("throws if embedding dimensions mismatch expected", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      data: [{ embedding: new Array(768).fill(0), index: 0 }],
      model: "wrong",
      usage: { total_tokens: 5 },
    });

    await expect(
      generateEmbeddings(
        [{ index: 0, text: "x" }],
        { client: { embeddings: { create: mockCreate } } as never, retryDelayMs: 1 },
      ),
    ).rejects.toThrow(/dimension/i);
  });
});
