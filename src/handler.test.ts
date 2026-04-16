import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { handleWebhook, type HandlerDeps } from "./handler";
import { setupD1 } from "../test/setup-d1";

beforeEach(async () => {
  await setupD1();
});

const TEST_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const VIDEO_ID = "https://meet.google.com/test-mtg";

async function signedRequest(payload: unknown): Promise<Request> {
  const body = JSON.stringify(payload);
  const svixId = "msg_" + Math.random().toString(36).slice(2);
  const timestamp = Math.floor(Date.now() / 1000);
  const toSign = `${svixId}.${timestamp}.${body}`;
  const secretBytes = Uint8Array.from(
    atob(TEST_SECRET.replace(/^whsec_/, "")),
    (c) => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(toSign));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return new Request("http://localhost/", {
    method: "POST",
    body,
    headers: {
      "svix-id": svixId,
      "svix-timestamp": String(timestamp),
      "svix-signature": `v1,${b64}`,
    },
  });
}

function transcriptPayload() {
  return {
    type: "meeting.transcript.created",
    meetingId: VIDEO_ID,
    videoId: "v1",
    title: "Test sync",
    createdAt: 1741088306,
    attendees: ["alice@example.com"],
    transcript: [{ speaker: "Speaker: A", text: "Hi" }, { speaker: "Speaker: B", text: "Hello" }],
  };
}

function summaryPayload() {
  return {
    type: "meeting.summary.created",
    meetingId: VIDEO_ID,
    videoId: "v1",
    title: "Test sync",
    createdAt: 1741087081,
    attendees: ["alice@example.com"],
    summary: "Brief discussion about Q2.",
    summaryV2: "## Overview\n\nBrief discussion about Q2 priorities.",
  };
}

const fakeExtraction = {
  action_items: [
    { task: "Send notes", owner: "Alice", due_date: null },
    { task: "Book room", owner: null, due_date: null },
  ],
  participants: [
    { name: "Alice", email: null, role: null },
    { name: "Bob", email: null, role: "PM" },
  ],
};

function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  const openai = {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: JSON.stringify(fakeExtraction) } }],
        }),
      },
    },
    embeddings: {
      create: vi.fn().mockResolvedValue({
        data: [{ embedding: new Array(1536).fill(0.1), index: 0 }],
      }),
    },
  } as never;

  const notion = {
    pagesCreate: vi.fn().mockResolvedValue({ id: "page_1", url: "https://notion.so/page_1" }),
  };

  env.VECTORIZE = {
    upsert: vi.fn().mockResolvedValue({ mutationId: "m1" }),
  } as unknown as VectorizeIndex;

  return { openai, notion, env, ...overrides };
}

describe("handleWebhook — single event arrival", () => {
  it("transcript event alone: writes raw_text + embeddings, no Notion writes", async () => {
    const deps = makeDeps();
    const res = await handleWebhook(await signedRequest(transcriptPayload()), deps);
    expect(res.status).toBe(200);

    expect(env.VECTORIZE.upsert).toHaveBeenCalledOnce();
    expect(deps.notion.pagesCreate).not.toHaveBeenCalled();
    expect(deps.openai.chat.completions.create).not.toHaveBeenCalled(); // no extraction yet

    const row = await env.DB
      .prepare("SELECT raw_text, summary, notion_synced_at FROM transcripts WHERE video_id = ?")
      .bind(VIDEO_ID)
      .first<{ raw_text: string; summary: string | null; notion_synced_at: string | null }>();
    expect(row?.raw_text).toBeTruthy();
    expect(row?.summary).toBeNull();
    expect(row?.notion_synced_at).toBeNull();
  });

  it("summary event alone: extracts via OpenAI, writes summary, no Notion (transcript missing)", async () => {
    const deps = makeDeps();
    const res = await handleWebhook(await signedRequest(summaryPayload()), deps);
    expect(res.status).toBe(200);

    expect(deps.openai.chat.completions.create).toHaveBeenCalledOnce();
    expect(deps.notion.pagesCreate).not.toHaveBeenCalled(); // transcript not yet
    expect(env.VECTORIZE.upsert).not.toHaveBeenCalled();

    const row = await env.DB
      .prepare("SELECT raw_text, summary, action_items FROM transcripts WHERE video_id = ?")
      .bind(VIDEO_ID)
      .first<{ raw_text: string | null; summary: string; action_items: string }>();
    expect(row?.raw_text).toBeNull();
    expect(row?.summary).toBeTruthy();
    expect(JSON.parse(row!.action_items)).toHaveLength(2);
  });
});

describe("handleWebhook — both events arrive", () => {
  it("transcript first then summary: triggers Notion writes on summary event", async () => {
    const deps1 = makeDeps();
    await handleWebhook(await signedRequest(transcriptPayload()), deps1);
    expect(deps1.notion.pagesCreate).not.toHaveBeenCalled();

    const deps2 = makeDeps();
    await handleWebhook(await signedRequest(summaryPayload()), deps2);
    // 1 transcript page + 2 followups = 3 Notion calls
    expect(deps2.notion.pagesCreate).toHaveBeenCalledTimes(3);

    const row = await env.DB
      .prepare("SELECT notion_synced_at FROM transcripts WHERE video_id = ?")
      .bind(VIDEO_ID)
      .first<{ notion_synced_at: string }>();
    expect(row?.notion_synced_at).toBeTruthy();
  });

  it("summary first then transcript: triggers Notion writes on transcript event", async () => {
    const deps1 = makeDeps();
    await handleWebhook(await signedRequest(summaryPayload()), deps1);
    expect(deps1.notion.pagesCreate).not.toHaveBeenCalled();

    const deps2 = makeDeps();
    await handleWebhook(await signedRequest(transcriptPayload()), deps2);
    expect(deps2.notion.pagesCreate).toHaveBeenCalledTimes(3);
  });

  it("threads transcript page id into every Followup Meeting relation", async () => {
    const deps1 = makeDeps();
    await handleWebhook(await signedRequest(transcriptPayload()), deps1);

    const deps2 = makeDeps();
    await handleWebhook(await signedRequest(summaryPayload()), deps2);

    // Call 0 is createTranscriptPage → mock returns { id: "page_1" }
    // Calls 1+ are createFollowupRow → should carry Meeting: { relation: [{ id: "page_1" }] }
    const calls = (deps2.notion.pagesCreate as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(3);
    const followupBodies = calls.slice(1).map((c) => c[0] as { properties: Record<string, unknown> });
    for (const body of followupBodies) {
      expect(body.properties.Meeting).toEqual({
        relation: [{ id: "page_1" }],
      });
    }
  });

  it("skips followup creation when transcript page creation fails (no Meeting relation target)", async () => {
    const deps1 = makeDeps();
    await handleWebhook(await signedRequest(transcriptPayload()), deps1);

    const pagesCreate = vi.fn()
      .mockRejectedValueOnce(new Error("Notion 400: bad schema")) // transcript page fails
      .mockResolvedValue({ id: "should_not_be_called", url: "" });
    const deps2 = makeDeps({ notion: { pagesCreate } });

    const res = await handleWebhook(await signedRequest(summaryPayload()), deps2);
    expect(res.status).toBe(200); // Notion failure is non-fatal

    // Only 1 call (the failing transcript page), no followups
    expect(pagesCreate).toHaveBeenCalledTimes(1);
  });

  it("retried summary event after Notion already synced does not double-post", async () => {
    const deps1 = makeDeps();
    await handleWebhook(await signedRequest(transcriptPayload()), deps1);
    const deps2 = makeDeps();
    await handleWebhook(await signedRequest(summaryPayload()), deps2);
    expect(deps2.notion.pagesCreate).toHaveBeenCalledTimes(3);

    const deps3 = makeDeps();
    await handleWebhook(await signedRequest(summaryPayload()), deps3);
    expect(deps3.notion.pagesCreate).not.toHaveBeenCalled();
  });
});

describe("handleWebhook — error handling", () => {
  it("returns 405 for non-POST", async () => {
    const res = await handleWebhook(
      new Request("http://localhost/", { method: "GET" }),
      makeDeps(),
    );
    expect(res.status).toBe(405);
  });

  it("returns 401 for invalid signature", async () => {
    const req = new Request("http://localhost/", {
      method: "POST",
      body: JSON.stringify({ id: "x" }),
      headers: {
        "svix-id": "msg_x",
        "svix-timestamp": String(Math.floor(Date.now() / 1000)),
        "svix-signature": "v1,invalid",
      },
    });
    expect((await handleWebhook(req, makeDeps())).status).toBe(401);
  });

  it("ignores unknown event types with 200", async () => {
    const res = await handleWebhook(
      await signedRequest({ type: "video.recording.started", meetingId: "x", videoId: "v", title: "x" }),
      makeDeps(),
    );
    expect(res.status).toBe(200);
  });

  it("returns 500 when extraction fails on summary event", async () => {
    const deps = makeDeps();
    (deps.openai.chat.completions.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("openai down"), { status: 500 }),
    );
    expect((await handleWebhook(await signedRequest(summaryPayload()), deps)).status).toBe(500);
  });
});
