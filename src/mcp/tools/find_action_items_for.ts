import type { Env } from "../../env";
import type { ToolResult } from "./recent_calls";

export interface FindActionItemsInput {
  person: string;
  since?: string; // ISO date (YYYY-MM-DD) — optional lower bound on created_at
}

interface Row {
  video_id: string;
  title: string;
  created_at: string;
  task: string;
  owner: string | null;
  due_date: string | null;
}

export async function findActionItemsFor(
  input: FindActionItemsInput,
  env: Env,
): Promise<ToolResult> {
  const personLower = input.person.trim().toLowerCase();
  if (!personLower) {
    return {
      content: [{ type: "text", text: "Missing `person` argument." }],
    };
  }

  // SQLite json_each expands each array element; json_extract pulls fields.
  // We case-fold the owner with LOWER() and substring-match with LIKE.
  const sinceClause = input.since ? "AND t.created_at >= ?2" : "";
  const bindings: (string | number)[] = [`%${personLower}%`];
  if (input.since) bindings.push(input.since);

  const sql = `
    SELECT
      t.video_id,
      t.title,
      t.created_at,
      json_extract(ai.value, '$.task')     AS task,
      json_extract(ai.value, '$.owner')    AS owner,
      json_extract(ai.value, '$.due_date') AS due_date
    FROM transcripts t, json_each(t.action_items) ai
    WHERE LOWER(COALESCE(json_extract(ai.value, '$.owner'), '')) LIKE ?1
    ${sinceClause}
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT 100
  `;

  const { results } = await env.DB.prepare(sql)
    .bind(...bindings)
    .all<Row>();

  if (!results || results.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No action items found for "${input.person}"${input.since ? ` since ${input.since}` : ""}.`,
        },
      ],
    };
  }

  const lines = results.map((r) => {
    const date = r.created_at.split(" ")[0];
    const due = r.due_date ? ` — due ${r.due_date}` : "";
    const owner = r.owner ? ` *(owner: ${r.owner})*` : "";
    return `• [${date}] **${r.title}** — ${r.task}${owner}${due}`;
  });

  return {
    content: [
      {
        type: "text",
        text: `Found ${results.length} action item${results.length === 1 ? "" : "s"} for "${input.person}":\n\n${lines.join("\n")}`,
      },
    ],
  };
}
