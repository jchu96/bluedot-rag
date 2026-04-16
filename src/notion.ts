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
  /** Notion page ID of the Transcripts row this followup belongs to (Meeting relation). */
  transcriptPageId: string;
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
  /** URL to the Bluedot recording / preview page. */
  meetingUrl?: string;
  /** URL to Bluedot's native Notion summary page, when found. Best-effort. */
  bluedotPageUrl?: string;
}

const NAME_MAX = 2000;
const RICH_TEXT_MAX = 2000;

function text(content: string) {
  return { type: "text", text: { content } };
}

function paragraphLink(label: string, url: string) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [
        {
          type: "text",
          text: { content: label, link: { url } },
          annotations: { bold: true },
        },
      ],
    },
  };
}

/**
 * Notion Date property requires ISO 8601 (YYYY-MM-DD or full datetime).
 * OpenAI often returns natural language ("Friday", "next week") — drop those
 * in the structured Date field but keep the original text in the task name
 * so the human triaging the followup can see it.
 */
function parseIsoDate(input: string | undefined): { date: { start: string } | null } {
  if (!input) return { date: null };
  if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(input)) {
    return { date: { start: input } };
  }
  return { date: null };
}

/**
 * For followup row title: include due_date inline if it's natural language
 * (since the structured Date field rejects it), so the human triaging sees it.
 */
function followupTitle(task: string, due_date: string | undefined): string {
  if (!due_date) return task;
  if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(due_date)) return task;
  return `${task} (due ${due_date})`;
}

/**
 * Build a Notion row for the Followups DB.
 *
 * Schema (set up by scripts/setup.ts):
 *   Name (title), Status (select), Priority (select), Due (date),
 *   Owner (rich_text), Source (select), Source Link (url),
 *   Meeting Title (rich_text), Video ID (rich_text),
 *   Meeting (relation → Transcripts DB)
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
      Meeting: { relation: [{ id: input.transcriptPageId }] },
    },
  };
}

/**
 * Build a slim Notion page for the Call Transcripts DB.
 *
 * aftercall's Transcripts page is a **metadata hub**, not a summary archive —
 * Bluedot's native Notion sync owns the rich summary content. This page
 * exists so Followups can relate to a single Notion row per meeting, and so
 * you get filterable DB views (Date, Participants) that Bluedot doesn't provide.
 *
 * Schema (set up by scripts/setup.ts):
 *   Name (title), Date (date), Participants (multi_select),
 *   Video ID (rich_text), Language (rich_text),
 *   Recording URL (url), Bluedot Page (url)
 *
 * Page body: at most one paragraph block linking to the Bluedot recording.
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

  const properties = {
    Name: { title: [text(input.title.slice(0, NAME_MAX))] },
    Date: { date: { start: date } },
    Participants: { multi_select: participantNames },
    "Video ID": { rich_text: [text(input.videoId.slice(0, RICH_TEXT_MAX))] },
    Language: { rich_text: [text((input.language ?? "").slice(0, RICH_TEXT_MAX))] },
    "Recording URL": input.meetingUrl ? { url: input.meetingUrl } : { url: null },
    "Bluedot Page": input.bluedotPageUrl ? { url: input.bluedotPageUrl } : { url: null },
  };

  const children: Array<Record<string, unknown>> = input.meetingUrl
    ? [paragraphLink("View on Bluedot", input.meetingUrl)]
    : [];

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
 * fails in CF Workers runtime).
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
