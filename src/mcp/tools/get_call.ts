import type { Env } from "../../env";
import type { ActionItem, Participant } from "../../schema";
import type { ToolResult } from "./recent_calls";

export interface GetCallInput {
  video_id: string;
}

interface Row {
  id: number;
  video_id: string;
  title: string;
  summary: string | null;
  bluedot_summary: string | null;
  participants: string;
  action_items: string;
  created_at: string;
}

function safeParseArray<T>(json: string | null | undefined): T[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function getCall(input: GetCallInput, env: Env): Promise<ToolResult> {
  const row = await env.DB.prepare(
    `SELECT id, video_id, title, summary, bluedot_summary, participants, action_items, created_at
     FROM transcripts WHERE video_id = ?1 LIMIT 1`,
  )
    .bind(input.video_id)
    .first<Row>();

  if (!row) {
    return {
      content: [
        { type: "text", text: `Call not found: ${input.video_id}` },
      ],
    };
  }

  const participants = safeParseArray<Participant>(row.participants);
  const actionItems = safeParseArray<ActionItem>(row.action_items);

  const parts = [
    `# ${row.title}`,
    `**Source:** ${row.video_id}`,
    `**Recorded:** ${row.created_at}`,
    "",
    "## Summary",
    row.summary ?? row.bluedot_summary ?? "_(no summary available)_",
  ];

  if (participants.length > 0) {
    parts.push("", "## Participants");
    for (const p of participants) {
      const name = p.name ?? p.email ?? "(unknown)";
      const email = p.email && p.email !== p.name ? ` <${p.email}>` : "";
      const role = p.role ? ` — ${p.role}` : "";
      parts.push(`- ${name}${email}${role}`);
    }
  }

  if (actionItems.length > 0) {
    parts.push("", "## Action items");
    for (const a of actionItems) {
      const owner = a.owner ? ` *(owner: ${a.owner})*` : "";
      const due = a.due_date ? ` — due ${a.due_date}` : "";
      parts.push(`- ${a.task}${owner}${due}`);
    }
  }

  return {
    content: [{ type: "text", text: parts.join("\n") }],
  };
}
