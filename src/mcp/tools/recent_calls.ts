import type { Env } from "../../env";

export interface RecentCallsInput {
  days?: number;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}

interface Row {
  video_id: string;
  title: string;
  created_at: string;
  summary: string | null;
}

export async function recentCalls(input: RecentCallsInput, env: Env): Promise<ToolResult> {
  const days = input.days ?? 7;

  const { results } = await env.DB.prepare(
    `SELECT video_id, title, created_at, summary
     FROM transcripts
     WHERE created_at >= datetime('now', ?1)
     ORDER BY created_at DESC
     LIMIT 50`,
  )
    .bind(`-${days} days`)
    .all<Row>();

  if (!results || results.length === 0) {
    return {
      content: [
        { type: "text", text: `No calls found in the last ${days} day(s).` },
      ],
    };
  }

  const lines = results.map((r) => {
    const date = r.created_at.split(" ")[0];
    const snippet = r.summary
      ? ` — ${r.summary.slice(0, 120).replace(/\s+/g, " ")}${r.summary.length > 120 ? "…" : ""}`
      : "";
    return `• [${date}] ${r.title} (\`${r.video_id}\`)${snippet}`;
  });

  return {
    content: [
      {
        type: "text",
        text: `Found ${results.length} call${results.length === 1 ? "" : "s"} in the last ${days} day(s):\n\n${lines.join("\n")}`,
      },
    ],
  };
}
