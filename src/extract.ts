import OpenAI from "openai";
import type { ActionItem, Participant } from "./schema";

export interface ExtractedFromSummary {
  action_items: ActionItem[];
  participants: Participant[];
}

export interface ExtractInput {
  /** Bluedot's already-summarized text — much smaller than full transcript */
  summary: string;
  /** Optional: meeting title for context */
  title?: string;
  /** Optional: attendee emails from Bluedot */
  attendees?: string[];
  /** Optional: meeting date (used to resolve relative phrases like "Friday" into ISO) */
  meetingDate?: Date;
}

export interface ExtractOptions {
  client: OpenAI;
  model?: string;
  retries?: number;
  retryDelayMs?: number;
}

export const DEFAULT_MODEL = "gpt-5-mini";
const MAX_SUMMARY_CHARS = 30_000;

const SYSTEM_PROMPT = `You extract action items and participants from a meeting summary. Be precise and never invent information not present in the source.

# Action items
A concrete commitment someone made to do something after the meeting.

Include:
- Explicit commitments: "Andy will send the proposal", "I'll follow up next week"
- Assigned tasks: "Maria to review the draft by Friday"

Exclude:
- Topics discussed without a commitment
- Vague aspirations ("we should probably look into that")
- Decisions already finalized in the meeting
- Questions raised but not assigned to anyone

For each action item:
- task: one sentence, imperative voice, specific enough to check off ("Send Q2 forecast to Jen" not "handle forecast")
- owner: the person committed. Prefer the exact name used in the summary. If an attendees list is provided and a first-name-only reference unambiguously matches one attendee, use that full name. Use null for "we"/"the team"/unclear.
- due_date: if the summary states a date, return ISO "YYYY-MM-DD" when you can resolve it unambiguously using the provided meeting date as "today" (e.g. "Friday" → the next Friday after the meeting date; "next week" is NOT unambiguous — keep as phrase). If the summary already gives an ISO date, return it as-is. If unambiguous resolution isn't possible, preserve the original phrase verbatim. Use null if unstated. Never guess a year.

# Participants
People who took part, as identified in the summary. Use null for any field not stated. Never fabricate emails or titles.

If nothing qualifies, return empty arrays. Do not invent content to fill them.`;

export const EXTRACTION_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  required: ["action_items", "participants"],
  properties: {
    action_items: {
      type: "array" as const,
      items: {
        type: "object" as const,
        additionalProperties: false,
        required: ["task", "owner", "due_date"],
        properties: {
          task: { type: "string" as const },
          owner: { type: ["string", "null"] as const },
          due_date: { type: ["string", "null"] as const },
        },
      },
    },
    participants: {
      type: "array" as const,
      items: {
        type: "object" as const,
        additionalProperties: false,
        required: ["name", "email", "role"],
        properties: {
          name: { type: ["string", "null"] as const },
          email: { type: ["string", "null"] as const },
          role: { type: ["string", "null"] as const },
        },
      },
    },
  },
};

function buildUserMessage(input: ExtractInput): string {
  const titleBlock = input.title ? `Meeting title: ${input.title}\n\n` : "";
  const dateBlock = input.meetingDate
    ? `Meeting date: ${input.meetingDate.toISOString().slice(0, 10)}\n\n`
    : "";
  const attendeesBlock =
    input.attendees && input.attendees.length > 0
      ? `Attendees: ${input.attendees.join(", ")}\n\n`
      : "";

  let summary = input.summary;
  if (summary.length > MAX_SUMMARY_CHARS) {
    summary = summary.slice(0, MAX_SUMMARY_CHARS) + "\n\n[truncated]";
  }

  return `${titleBlock}${dateBlock}${attendeesBlock}Bluedot summary:
"""
${summary}
"""

Extract action items + participants per the schema. Use the attendees list to disambiguate owner names when a first-name reference unambiguously matches one attendee.`;
}

function cleanResult(raw: ExtractedFromSummary): ExtractedFromSummary {
  return {
    action_items: raw.action_items.map((a) => ({
      task: a.task,
      ...(a.owner != null && { owner: a.owner }),
      ...(a.due_date != null && { due_date: a.due_date }),
    })),
    participants: raw.participants.map((p) => ({
      ...(p.name != null && { name: p.name }),
      ...(p.email != null && { email: p.email }),
      ...(p.role != null && { role: p.role }),
    })),
  };
}

export async function extractFromSummary(
  input: ExtractInput,
  options: ExtractOptions,
): Promise<ExtractedFromSummary> {
  const model = options.model ?? DEFAULT_MODEL;
  const retries = options.retries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 500;

  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await options.client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserMessage(input) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "summary_extraction",
            strict: true,
            schema: EXTRACTION_SCHEMA,
          },
        },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error("OpenAI returned empty content");

      let parsed: ExtractedFromSummary;
      try {
        parsed = JSON.parse(content) as ExtractedFromSummary;
      } catch (err) {
        throw new Error(`Failed to parse OpenAI response as JSON: ${(err as Error).message}`);
      }

      return cleanResult(parsed);
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      const isRetryable = status === undefined || status === 429 || (status >= 500 && status < 600);
      if (!isRetryable || attempt === retries - 1) throw err;
      const delay = retryDelayMs * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastErr;
}
