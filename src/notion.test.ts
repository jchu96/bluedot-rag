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
    });
    const title = (body.properties as { Name: { title: Array<{ text: { content: string } }> } })
      .Name.title[0].text.content;
    expect(title.length).toBeLessThanOrEqual(2000);
  });
});

describe("buildTranscriptPageBody", () => {
  it("builds page with summary heading + bullet list of action items", () => {
    const body = buildTranscriptPageBody({
      dataSourceId: "ds_transcripts",
      title: "Weekly sync",
      summary: "We discussed Q2 priorities.",
      participants: [{ name: "Alice" }, { name: "Bob", email: "b@x.com" }],
      actionItems: [
        { task: "Send notes", owner: "Alice", due_date: "Friday" },
        { task: "Book room" },
      ],
      videoId: "vid_123",
      language: "en",
      createdAt: new Date("2026-04-14T12:00:00Z"),
    });

    const json = JSON.stringify(body);
    expect(json).toContain("Weekly sync");
    expect(json).toContain("We discussed Q2 priorities");
    expect(json).toContain("Send notes");
    expect(json).toContain("Alice");
  });

  it("parses ## headings in summary into Notion heading_2 blocks", () => {
    const body = buildTranscriptPageBody({
      dataSourceId: "ds_transcripts",
      title: "Meeting",
      summary: "## Overview\n\nWe reviewed Q2.\n\n## Next Steps\n\nFollow up with sales.",
      participants: [],
      actionItems: [],
      videoId: "vid_md",
      createdAt: new Date("2026-04-16T19:00:00Z"),
    });

    const blocks = body.children as Array<{ type: string; heading_2?: { rich_text: Array<{ text: { content: string } }> }; paragraph?: { rich_text: Array<{ text: { content: string } }> } }>;
    const headings = blocks.filter((b) => b.type === "heading_2").map((b) => b.heading_2!.rich_text[0].text.content);
    expect(headings).toContain("Overview");
    expect(headings).toContain("Next Steps");
    const paragraphs = blocks.filter((b) => b.type === "paragraph").map((b) => b.paragraph!.rich_text[0].text.content);
    expect(paragraphs).toContain("We reviewed Q2.");
    expect(paragraphs).toContain("Follow up with sales.");
  });

  it("parses - bullets in summary into bulleted_list_item blocks", () => {
    const body = buildTranscriptPageBody({
      dataSourceId: "ds_transcripts",
      title: "Meeting",
      summary: "## Action Items\n\n- Draft spec\n- Review with team\n- Ship by Friday",
      participants: [],
      actionItems: [],
      videoId: "vid_bul",
      createdAt: new Date("2026-04-16T19:00:00Z"),
    });

    const blocks = body.children as Array<{ type: string; bulleted_list_item?: { rich_text: Array<{ text: { content: string } }> } }>;
    const bullets = blocks
      .filter((b) => b.type === "bulleted_list_item")
      .map((b) => b.bulleted_list_item!.rich_text[0].text.content);
    expect(bullets).toEqual(expect.arrayContaining(["Draft spec", "Review with team", "Ship by Friday"]));
  });

  it("parses ### into heading_3 blocks", () => {
    const body = buildTranscriptPageBody({
      dataSourceId: "ds_transcripts",
      title: "Meeting",
      summary: "### Detail\n\nSome text.",
      participants: [],
      actionItems: [],
      videoId: "vid_h3",
      createdAt: new Date("2026-04-16T19:00:00Z"),
    });

    const h3 = (body.children as Array<{ type: string; heading_3?: { rich_text: Array<{ text: { content: string } }> } }>)
      .find((b) => b.type === "heading_3");
    expect(h3?.heading_3?.rich_text[0].text.content).toBe("Detail");
  });

  it("treats plain-text summaries with no markdown as paragraph blocks", () => {
    const body = buildTranscriptPageBody({
      dataSourceId: "ds_transcripts",
      title: "Meeting",
      summary: "Paragraph one.\n\nParagraph two.",
      participants: [],
      actionItems: [],
      videoId: "vid_plain",
      createdAt: new Date("2026-04-16T19:00:00Z"),
    });

    const paragraphs = (body.children as Array<{ type: string; paragraph?: { rich_text: Array<{ text: { content: string } }> } }>)
      .filter((b) => b.type === "paragraph")
      .map((b) => b.paragraph!.rich_text[0].text.content);
    expect(paragraphs).toContain("Paragraph one.");
    expect(paragraphs).toContain("Paragraph two.");
  });

  it("splits long summaries across multiple rich_text segments (Notion 2000-char cap)", () => {
    const longSummary = "sentence. ".repeat(1200); // ~12,000 chars
    const body = buildTranscriptPageBody({
      dataSourceId: "ds_transcripts",
      title: "Long meeting",
      summary: longSummary,
      participants: [],
      actionItems: [],
      videoId: "vid_long",
      createdAt: new Date("2026-04-16T19:00:00Z"),
    });

    const summaryParagraph = (body.children as Array<{
      type: string;
      paragraph?: { rich_text: Array<{ text: { content: string } }> };
    }>).find((c) => c.type === "paragraph");
    expect(summaryParagraph).toBeDefined();
    const segments = summaryParagraph!.paragraph!.rich_text;
    expect(segments.length).toBeGreaterThan(1);
    for (const seg of segments) {
      expect(seg.text.content.length).toBeLessThanOrEqual(2000);
    }
    const rejoined = segments.map((s) => s.text.content).join("");
    expect(rejoined).toBe(longSummary.trim());
  });
});

describe("createFollowupRow", () => {
  it("calls pagesCreate with the row body", async () => {
    const pagesCreate = vi.fn().mockResolvedValue({ id: "page_xyz", url: "https://notion.so/page_xyz" });
    const deps: NotionDeps = { pagesCreate };

    const result = await createFollowupRow(
      {
        dataSourceId: "ds_f",
        task: "Do thing",
        meetingTitle: "Sync",
        videoId: "v",
      },
      deps,
    );

    expect(result).toEqual({ pageId: "page_xyz", url: "https://notion.so/page_xyz" });
    expect(pagesCreate).toHaveBeenCalledOnce();
  });
});

describe("createTranscriptPage", () => {
  it("calls pagesCreate with the page body", async () => {
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
