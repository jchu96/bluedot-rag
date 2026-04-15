import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  EXTRACTION_SCHEMA,
  extractFromSummary,
  type ExtractedFromSummary,
} from "./extract";

const fakeExtracted: ExtractedFromSummary = {
  action_items: [
    { task: "Send notes", owner: "Alice", due_date: "Friday" },
    { task: "Book room" },
  ],
  participants: [{ name: "Alice", role: "PM" }, { name: "Bob" }],
};

function fakeOpenAI(content: object | string, opts: { reject?: unknown } = {}) {
  const create = vi.fn(async () => {
    if (opts.reject) throw opts.reject;
    return {
      choices: [
        {
          message: {
            content: typeof content === "string" ? content : JSON.stringify({
              action_items: fakeExtracted.action_items.map((a) => ({
                task: a.task,
                owner: a.owner ?? null,
                due_date: a.due_date ?? null,
              })),
              participants: fakeExtracted.participants.map((p) => ({
                name: p.name ?? null,
                email: p.email ?? null,
                role: p.role ?? null,
              })),
            }),
          },
        },
      ],
    };
  });
  return { client: { chat: { completions: { create } } } as never, create };
}

describe("EXTRACTION_SCHEMA", () => {
  it("requires action_items and participants only (no title or summary)", () => {
    expect(EXTRACTION_SCHEMA.required).toEqual(["action_items", "participants"]);
  });

  it("disallows additionalProperties (strict)", () => {
    expect(EXTRACTION_SCHEMA.additionalProperties).toBe(false);
  });
});

describe("extractFromSummary", () => {
  beforeEach(() => vi.resetAllMocks());

  it("extracts action items + participants from Bluedot summary text", async () => {
    const { client } = fakeOpenAI({});
    const result = await extractFromSummary(
      { summary: "Discussed Q2; Alice will send notes Friday." },
      { client },
    );
    expect(result).toEqual(fakeExtracted);
  });

  it("includes attendees + title in user message when provided", async () => {
    const { client, create } = fakeOpenAI({});
    await extractFromSummary(
      { summary: "x", title: "Weekly sync", attendees: ["alice@x.com"] },
      { client },
    );
    const msgs = ((create.mock.calls[0] as never[])[0] as { messages: Array<{ role: string; content: string }> }).messages;
    const userContent = msgs.find((m) => m.role === "user")?.content ?? "";
    expect(userContent).toContain("Weekly sync");
    expect(userContent).toContain("alice@x.com");
  });

  it("truncates summaries over 30K chars", async () => {
    const { client, create } = fakeOpenAI({});
    await extractFromSummary({ summary: "x".repeat(50_000) }, { client });
    const userContent = ((create.mock.calls[0] as never[])[0] as { messages: Array<{ content: string }> }).messages[1].content;
    expect(userContent).toContain("[truncated]");
  });

  it("retries on 5xx errors", async () => {
    const err = Object.assign(new Error("server"), { status: 503 });
    const create = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ action_items: [], participants: [] }) } }],
      });
    const client = { chat: { completions: { create } } } as never;
    const result = await extractFromSummary({ summary: "x" }, { client, retryDelayMs: 1 });
    expect(result.action_items).toEqual([]);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does not retry 4xx", async () => {
    const err = Object.assign(new Error("bad"), { status: 400 });
    const { client, create } = fakeOpenAI({}, { reject: err });
    await expect(extractFromSummary({ summary: "x" }, { client, retryDelayMs: 1 })).rejects.toThrow(/bad/);
    expect(create).toHaveBeenCalledOnce();
  });

  it("throws on invalid JSON from OpenAI", async () => {
    const { client } = fakeOpenAI("not json");
    await expect(extractFromSummary({ summary: "x" }, { client })).rejects.toThrow(/parse/i);
  });

  it("uses default model when not specified", async () => {
    const { client, create } = fakeOpenAI({});
    await extractFromSummary({ summary: "x" }, { client });
    expect(((create.mock.calls[0] as never[])[0] as { model: string }).model).toBe("gpt-5-mini");
  });
});
