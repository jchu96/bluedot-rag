import type { ActionItem, Participant } from "./schema";

export interface NotionDeps {
  pagesCreate: (args: Record<string, unknown>) => Promise<{ id: string; url: string }>;
}

export interface FollowupInput {
  dataSourceId: string;
  task: string;
  owner?: string;
  due_date?: string;
  meetingTitle: string;
  meetingUrl?: string;
  videoId: string;
}

export interface TranscriptPageInput {
  dataSourceId: string;
  title: string;
  summary: string;
  participants: Participant[];
  actionItems: ActionItem[];
  videoId: string;
  language?: string | null;
  createdAt: Date;
}

const NAME_MAX = 2000;
const RICH_TEXT_MAX = 2000;

function text(content: string) {
  return { type: "text", text: { content } };
}

/**
 * Notion's API caps each rich_text element's `text.content` at 2000 chars.
 * Long content must be split across multiple rich_text segments within a
 * single block. Prefer splitting on a nearby newline/space to avoid
 * breaking mid-word.
 */
function richTextSegments(content: string): Array<ReturnType<typeof text>> {
  if (content.length <= RICH_TEXT_MAX) return [text(content)];
  const segments: Array<ReturnType<typeof text>> = [];
  let cursor = 0;
  while (cursor < content.length) {
    let end = Math.min(cursor + RICH_TEXT_MAX, content.length);
    if (end < content.length) {
      const window = content.slice(cursor, end);
      const lastNewline = window.lastIndexOf("\n");
      const lastSpace = window.lastIndexOf(" ");
      const breakAt = lastNewline >= RICH_TEXT_MAX * 0.5
        ? lastNewline
        : lastSpace >= RICH_TEXT_MAX * 0.5
          ? lastSpace
          : -1;
      if (breakAt > 0) end = cursor + breakAt + 1;
    }
    segments.push(text(content.slice(cursor, end)));
    cursor = end;
  }
  return segments;
}

function paragraph(content: string) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: richTextSegments(content) },
  };
}

function heading(content: string) {
  return {
    object: "block",
    type: "heading_2",
    heading_2: { rich_text: [text(content)] },
  };
}

function heading3(content: string) {
  return {
    object: "block",
    type: "heading_3",
    heading_3: { rich_text: richTextSegments(content) },
  };
}

function bulletedItem(content: string) {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: richTextSegments(content) },
  };
}

/**
 * Convert Bluedot's markdown-ish summary into structured Notion blocks.
 *
 * Handles:
 * - `## heading` → heading_2
 * - `### heading` → heading_3
 * - `# heading` → heading_2 (Notion has heading_1 but we collapse for visual weight)
 * - `- item` / `* item` / `• item` → bulleted_list_item
 * - blank line → paragraph boundary
 * - everything else → paragraph (consecutive non-blank lines joined with space)
 *
 * Always safe: plain-text input with no markers produces paragraph blocks.
 */
function summaryToBlocks(summary: string): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const lines = summary.split("\n");
  let buffer: string[] = [];

  const flushParagraph = () => {
    if (buffer.length === 0) return;
    const joined = buffer.join(" ").trim();
    if (joined) blocks.push(paragraph(joined));
    buffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      continue;
    }
    const h3 = /^#{3}\s+(.+)$/.exec(line);
    const h2 = /^#{1,2}\s+(.+)$/.exec(line);
    const bullet = /^[-*•]\s+(.+)$/.exec(line);
    if (h3) {
      flushParagraph();
      blocks.push(heading3(h3[1]));
    } else if (h2) {
      flushParagraph();
      blocks.push(heading(h2[1]));
    } else if (bullet) {
      flushParagraph();
      blocks.push(bulletedItem(bullet[1]));
    } else {
      buffer.push(line);
    }
  }
  flushParagraph();
  return blocks;
}

/**
 * Notion Date property requires ISO 8601 (YYYY-MM-DD or full datetime).
 * OpenAI often returns natural language ("Friday", "next week") — drop those
 * in the structured Date field but keep the original text in the task name
 * so the human triaging the followup can see it.
 */
function parseIsoDate(input: string | undefined): { date: { start: string } | null } {
  if (!input) return { date: null };
  // Accept YYYY-MM-DD or full ISO 8601; reject anything else
  if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(input)) {
    return { date: { start: input } };
  }
  return { date: null };
}

function formatActionItem(item: ActionItem): string {
  const parts: string[] = [item.task];
  if (item.owner) parts.push(`— ${item.owner}`);
  if (item.due_date) parts.push(`(due ${item.due_date})`);
  return parts.join(" ");
}

/**
 * For followup row title: include due_date inline if it's natural language
 * (since the structured Date field rejects it), so the human triaging sees it.
 */
function followupTitle(task: string, due_date: string | undefined): string {
  if (!due_date) return task;
  if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(due_date)) return task; // ISO goes to Date field
  return `${task} (due ${due_date})`;
}

/**
 * Build a Notion row for the Followups DB.
 *
 * Schema assumed (created by setup script):
 *   Name (title), Status (select), Priority (select), Due (date),
 *   Owner (rich_text), Source (select), Source Link (url),
 *   Meeting Title (rich_text), Created (created_time, auto)
 */
export function buildFollowupRowBody(input: FollowupInput): {
  parent: { type: "data_source_id"; data_source_id: string };
  properties: Record<string, unknown>;
} {
  return {
    parent: { type: "data_source_id", data_source_id: input.dataSourceId },
    properties: {
      Name: { title: [text(followupTitle(input.task, input.due_date).slice(0, NAME_MAX))] },
      Status: { select: { name: "Inbox" } },
      Priority: { select: { name: "P2" } },
      Due: parseIsoDate(input.due_date),
      Owner: { rich_text: [text((input.owner ?? "").slice(0, RICH_TEXT_MAX))] },
      Source: { select: { name: "Bluedot" } },
      "Source Link": input.meetingUrl ? { url: input.meetingUrl } : { url: null },
      "Meeting Title": { rich_text: [text(input.meetingTitle.slice(0, RICH_TEXT_MAX))] },
      "Video ID": { rich_text: [text(input.videoId.slice(0, RICH_TEXT_MAX))] },
    },
  };
}

/**
 * Build a Notion page for the Call Transcripts DB.
 *
 * Schema assumed (created by setup script):
 *   Name (title), Date (date), Participants (multi_select),
 *   Summary (rich_text), Action Items (rich_text),
 *   Video ID (rich_text), Language (rich_text)
 */
export function buildTranscriptPageBody(input: TranscriptPageInput): {
  parent: { type: "data_source_id"; data_source_id: string };
  properties: Record<string, unknown>;
  children: Array<Record<string, unknown>>;
} {
  const date = input.createdAt.toISOString().slice(0, 10);
  const participantNames = input.participants
    .map((p) => p.name ?? p.email ?? "")
    .filter((n) => n.length > 0)
    .map((n) => ({ name: n.replace(/,/g, "").slice(0, 100) }));

  const actionItemsText =
    input.actionItems.length > 0
      ? input.actionItems.map((a) => `• ${formatActionItem(a)}`).join("\n")
      : "";

  const properties = {
    Name: { title: [text(input.title.slice(0, NAME_MAX))] },
    Date: { date: { start: date } },
    Participants: { multi_select: participantNames },
    Summary: { rich_text: [text(input.summary.slice(0, RICH_TEXT_MAX))] },
    "Action Items": { rich_text: [text(actionItemsText.slice(0, RICH_TEXT_MAX))] },
    "Video ID": { rich_text: [text(input.videoId.slice(0, RICH_TEXT_MAX))] },
    Language: { rich_text: [text((input.language ?? "").slice(0, RICH_TEXT_MAX))] },
  };

  const children: Array<Record<string, unknown>> = [...summaryToBlocks(input.summary)];

  if (input.actionItems.length > 0) {
    children.push(heading("Action Items"));
    for (const item of input.actionItems) {
      children.push(bulletedItem(formatActionItem(item)));
    }
  }

  if (input.participants.length > 0) {
    children.push(heading("Participants"));
    for (const p of input.participants) {
      const label = [p.name, p.email ? `<${p.email}>` : "", p.role ? `(${p.role})` : ""]
        .filter(Boolean)
        .join(" ");
      children.push(bulletedItem(label));
    }
  }

  return {
    parent: { type: "data_source_id", data_source_id: input.dataSourceId },
    properties,
    children,
  };
}

export async function createFollowupRow(
  input: FollowupInput,
  deps: NotionDeps,
): Promise<{ pageId: string; url: string }> {
  const body = buildFollowupRowBody(input);
  const resp = await deps.pagesCreate(body);
  return { pageId: resp.id, url: resp.url };
}

export async function createTranscriptPage(
  input: TranscriptPageInput,
  deps: NotionDeps,
): Promise<{ pageId: string; url: string }> {
  const body = buildTranscriptPageBody(input);
  const resp = await deps.pagesCreate(body);
  return { pageId: resp.id, url: resp.url };
}

/**
 * Build a NotionDeps from an integration token; uses direct fetch to
 * https://api.notion.com/v1/pages (NOT the @notionhq/client SDK, which
 * fails in CF Workers runtime — lesson learned from prior pipeline).
 */
export function createNotionDeps(integrationKey: string): NotionDeps {
  return {
    pagesCreate: async (body) => {
      const resp = await fetch("https://api.notion.com/v1/pages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${integrationKey}`,
          "Notion-Version": "2025-09-03",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`Notion API ${resp.status}: ${txt}`);
      }
      const data = (await resp.json()) as { id: string; url?: string };
      return { id: data.id, url: data.url ?? "" };
    },
  };
}
