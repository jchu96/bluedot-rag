import type { Env } from "../../env";
import type { ToolResult } from "./recent_calls";

export interface ListFollowupsInput {
  status?: string;
  source?: string;
  limit?: number;
}

export interface ListFollowupsDeps {
  fetchFn?: typeof fetch;
}

const NOTION_VERSION = "2025-09-03";

interface NotionPage {
  id: string;
  url?: string;
  properties: Record<string, any>;
}

interface NotionQueryResponse {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
  message?: string;
}

function richText(prop: any): string {
  if (!prop) return "";
  if (Array.isArray(prop.title)) return prop.title.map((t: any) => t.plain_text ?? "").join("");
  if (Array.isArray(prop.rich_text)) return prop.rich_text.map((t: any) => t.plain_text ?? "").join("");
  return "";
}

function selectName(prop: any): string | null {
  return prop?.select?.name ?? null;
}

function dateStart(prop: any): string | null {
  return prop?.date?.start ?? null;
}

export async function listFollowups(
  input: ListFollowupsInput,
  env: Env,
  deps: ListFollowupsDeps = {},
): Promise<ToolResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));

  const filters: any[] = [];
  if (input.status) {
    filters.push({ property: "Status", select: { equals: input.status } });
  }
  if (input.source) {
    filters.push({ property: "Source", select: { equals: input.source } });
  }

  const body: Record<string, unknown> = { page_size: limit };
  if (filters.length === 1) {
    body.filter = filters[0];
  } else if (filters.length > 1) {
    body.filter = { and: filters };
  }

  const url = `https://api.notion.com/v1/data_sources/${env.NOTION_FOLLOWUPS_DATA_SOURCE_ID}/query`;
  const resp = await fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NOTION_INTEGRATION_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    return {
      content: [
        {
          type: "text",
          text: `Notion API error ${resp.status}: ${errText.slice(0, 400)}`,
        },
      ],
    };
  }

  const data = (await resp.json()) as NotionQueryResponse;
  if (!data.results || data.results.length === 0) {
    const filterDesc = [
      input.status ? `status=${input.status}` : null,
      input.source ? `source=${input.source}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    const suffix = filterDesc ? ` (${filterDesc})` : "";
    return {
      content: [{ type: "text", text: `No followups found${suffix}.` }],
    };
  }

  const lines = data.results.map((p) => {
    const name = richText(p.properties.Name) || "(untitled)";
    const status = selectName(p.properties.Status);
    const priority = selectName(p.properties.Priority);
    const due = dateStart(p.properties.Due);
    const owner = richText(p.properties.Owner);
    const meetingTitle = richText(p.properties["Meeting Title"]);

    const meta: string[] = [];
    if (status) meta.push(status);
    if (priority) meta.push(priority);
    if (owner) meta.push(`owner: ${owner}`);
    if (due) meta.push(`due ${due}`);
    if (meetingTitle) meta.push(`from: ${meetingTitle}`);

    const metaStr = meta.length ? ` — ${meta.join(" · ")}` : "";
    const link = p.url ? `\n   ${p.url}` : "";
    return `• **${name}**${metaStr}${link}`;
  });

  return {
    content: [
      {
        type: "text",
        text: `Found ${data.results.length} followup${data.results.length === 1 ? "" : "s"}:\n\n${lines.join("\n")}`,
      },
    ],
  };
}
