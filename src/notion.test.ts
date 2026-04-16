import { describe, it, expect, vi } from "vitest";
import {
  buildTranscriptPageBody,
  buildFollowupRowBody,
  createTranscriptPage,
  createFollowupRow,
  type NotionDeps,
} from "./notion";

describe("buildFollowupRowBody", () => {
  it("builds a Notion row payload with all fields", () => {
    const body = buildFollowupRowBody({
      dataSourceId: "ds_followups",
      task: "Send the deck",
      owner: "Alice",
      due_date: "Friday",
      meetingTitle: "Weekly sync",
      meetingUrl: "https://meet.google.com/abc",
      videoId: "vid_123",
      transcriptPageId: "transcript_page_abc",
    });

    expect(body.parent).toEqual({ type: "data_source_id", data_source_id: "ds_followups" });
    const props = body.properties as Record<string, unknown>;
    expect((props.Name as { title: Array<{ text: { content: string } }> }).title[0].text.content)
      .toBe("Send the deck (due Friday)");
    expect(props.Status).toEqual({ select: { name: "Inbox" } });
    expect(props.Source).toEqual({ select: { name: "Bluedot" } });
  });

  it("omits owner/due_date when not provided", () => {
    const body = buildFollowupRowBody({
      dataSourceId: "ds",
      task: "Just a task",
      meetingTitle: "x",
      videoId: "v",
      transcriptPageId: "t",
    });
    const props = body.properties as Record<string, { rich_text?: Array<{ text: { content: string } }>; date?: unknown }>;
    expect(props.Owner.rich_text?.[0]?.text.content ?? "").toBe("");
    expect(props.Due.date).toBeNull();
  });

  it("preserves natural-language due_date in title, sets Date field to null", () => {
    const body = buildFollowupRowBody({
      dataSourceId: "ds",
      task: "Send notes",
      due_date: "Friday",
      meetingTitle: "x",
      videoId: "v",
      transcriptPageId: "t",
    });
    const title = (body.properties as { Name: { title: Array<{ text: { content: string } }> } }).Name.title[0].text.content;
    expect(title).toBe("Send notes (due Friday)");
    expect((body.properties as { Due: { date: unknown } }).Due.date).toBeNull();
  });

  it("uses ISO due_date in Date field, omits from title", () => {
    const body = buildFollowupRowBody({
      dataSourceId: "ds",
      task: "Send notes",
      due_date: "2026-05-01",
      meetingTitle: "x",
      videoId: "v",
      transcriptPageId: "t",
    });
    const title = (body.properties as { Name: { title: Array<{ text: { content: string } }> } }).Name.title[0].text.content;
    expect(title).toBe("Send notes");
    expect((body.properties as { Due: { date: { start: string } } }).Due.date.start).toBe("2026-05-01");
  });

  it("escapes very long task names to fit Notion limits", () => {
    const longTask = "x".repeat(3000);
    const body = buildFollowupRowBody({
      dataSourceId: "ds",
      task: longTask,
      meetingTitle: "x",
      videoId: "v",
      transcriptPageId: "t",
    });
    const title = (body.properties as { Name: { title: Array<{ text: { content: string } }> } })
      .Name.title[0].text.content;
    expect(title.length).toBeLessThanOrEqual(2000);
  });

  it("requires transcriptPageId and returns Meeting relation pointing to it", () => {
    const body = buildFollowupRowBody({
      dataSourceId: "ds",
      task: "Do a thing",
      meetingTitle: "x",
      videoId: "v",
      transcriptPageId: "transcript_page_42",
    });
    const props = body.properties as Record<string, unknown>;
    expect(props.Meeting).toEqual({
      relation: [{ id: "transcript_page_42" }],
    });
  });
});

describe("buildTranscriptPageBody", () => {
  it("builds slim page with <= 2 children blocks (bluedot link only)", () => {
    const body = buildTranscriptPageBody({
      dataSourceId: "ds_transcripts",
      title: "Weekly sync",
      summary: "## Overview\n\nLong summary content goes here — we no longer render it.",
      participants: [{ name: "Alice" }, { name: "Bob", email: "b@x.com" }],
      actionItems: [
        { task: "Send notes", owner: "Alice", due_date: "Friday" },
        { task: "Book room" },
      ],
      videoId: "vid_123",
      language: "en",
      createdAt: new Date("2026-04-14T12:00:00Z"),
      meetingUrl: "https://app.bluedothq.com/preview/abc",
    });

    expect(body.children.length).toBeLessThanOrEqual(2);
    // The summary should NOT appear anywhere in the children (Bluedot owns it)
    const childrenJson = JSON.stringify(body.children);
    expect(childrenJson).not.toContain("Long summary content");
  });

  it("renders a 'View on Bluedot' link paragraph when meetingUrl is set", () => {
    const body = buildTranscriptPageBody({
      dataSourceId: "ds_transcripts",
      title: "Meeting",
      summary: "ignored",
      participants: [],
      actionItems: [],
      videoId: "vid",
      createdAt: new Date("2026-04-16T19:00:00Z"),
      meetingUrl: "https://app.bluedothq.com/preview/xyz",
    });

    const childrenJson = JSON.stringify(body.children);
    expect(childrenJson).toContain("app.bluedothq.com/preview/xyz");
  });

  it("produces empty children array when meetingUrl is not set", () => {
    const body = buildTranscriptPageBody({
      dataSourceId: "ds_transcripts",
      title: "Meeting",
      summary: "ignored",
      participants: [],
      actionItems: [],
      videoId: "vid",
      createdAt: new Date("2026-04-16T19:00:00Z"),
    });

    expect(body.children).toEqual([]);
  });

  it("omits Summary and Action Items rich_text properties", () => {
    const body = buildTranscriptPageBody({
      dataSourceId: "ds_transcripts",
      title: "Meeting",
      summary: "some summary",
      participants: [],
      actionItems: [{ task: "do it" }],
      videoId: "vid",
      createdAt: new Date("2026-04-16T19:00:00Z"),
    });

    const props = body.properties as Record<string, unknown>;
    expect(props.Summary).toBeUndefined();
    expect(props["Action Items"]).toBeUndefined();
  });

  it("includes Recording URL property when meetingUrl is set", () => {
    const body = buildTranscriptPageBody({
      dataSourceId: "ds_transcripts",
      title: "Meeting",
      summary: "ignored",
      participants: [],
      actionItems: [],
      videoId: "vid",
      createdAt: new Date("2026-04-16T19:00:00Z"),
      meetingUrl: "https://app.bluedothq.com/preview/xyz",
    });

    const props = body.properties as Record<string, unknown>;
    expect(props["Recording URL"]).toEqual({ url: "https://app.bluedothq.com/preview/xyz" });
  });

  it("Recording URL is null when meetingUrl is not provided", () => {
    const body = buildTranscriptPageBody({
      dataSourceId: "ds_transcripts",
      title: "Meeting",
      summary: "ignored",
      participants: [],
      actionItems: [],
      videoId: "vid",
      createdAt: new Date("2026-04-16T19:00:00Z"),
    });

    const props = body.properties as Record<string, unknown>;
    expect(props["Recording URL"]).toEqual({ url: null });
  });

  it("includes Bluedot Page URL property when provided", () => {
    const body = buildTranscriptPageBody({
      dataSourceId: "ds_transcripts",
      title: "Meeting",
      summary: "ignored",
      participants: [],
      actionItems: [],
      videoId: "vid",
      createdAt: new Date("2026-04-16T19:00:00Z"),
      bluedotPageUrl: "https://www.notion.so/344ec0045028812b9c55df763e02e92c",
    });

    const props = body.properties as Record<string, unknown>;
    expect(props["Bluedot Page"]).toEqual({
      url: "https://www.notion.so/344ec0045028812b9c55df763e02e92c",
    });
  });

  it("Bluedot Page URL is null when not provided", () => {
    const body = buildTranscriptPageBody({
      dataSourceId: "ds_transcripts",
      title: "Meeting",
      summary: "ignored",
      participants: [],
      actionItems: [],
      videoId: "vid",
      createdAt: new Date("2026-04-16T19:00:00Z"),
    });

    const props = body.properties as Record<string, unknown>;
    expect(props["Bluedot Page"]).toEqual({ url: null });
  });

  it("still includes Participants multi_select (used for filtering DB views)", () => {
    const body = buildTranscriptPageBody({
      dataSourceId: "ds_transcripts",
      title: "Meeting",
      summary: "ignored",
      participants: [{ name: "Alice" }, { email: "bob@x.com" }],
      actionItems: [],
      videoId: "vid",
      createdAt: new Date("2026-04-16T19:00:00Z"),
    });

    const props = body.properties as Record<string, unknown>;
    expect(props.Participants).toEqual({
      multi_select: [{ name: "Alice" }, { name: "bob@x.com" }],
    });
  });
});

describe("createFollowupRow", () => {
  it("calls pagesCreate with the row body including Meeting relation", async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: "page_xyz", url: "https://notion.so/page_xyz" });
    const deps: NotionDeps = { pagesCreate };

    const result = await createFollowupRow(
      {
        dataSourceId: "ds_f",
        task: "Do thing",
        meetingTitle: "Sync",
        videoId: "v",
        transcriptPageId: "transcript_page_99",
      },
      deps,
    );

    expect(result).toEqual({ pageId: "page_xyz", url: "https://notion.so/page_xyz" });
    expect(pagesCreate).toHaveBeenCalledOnce();
    const passedBody = pagesCreate.mock.calls[0][0] as { properties: Record<string, unknown> };
    expect(passedBody.properties.Meeting).toEqual({
      relation: [{ id: "transcript_page_99" }],
    });
  });
});

describe("createTranscriptPage", () => {
  it("calls pagesCreate with the page body and returns the page id", async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: "p1", url: "https://notion.so/p1" });
    const deps: NotionDeps = { pagesCreate };

    const result = await createTranscriptPage(
      {
        dataSourceId: "ds_t",
        title: "x",
        summary: "y",
        participants: [],
        actionItems: [],
        videoId: "v",
        createdAt: new Date(),
      },
      deps,
    );

    expect(result.pageId).toBe("p1");
    expect(pagesCreate).toHaveBeenCalledOnce();
  });
});
