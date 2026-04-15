/**
 * Bluedot webhook payload shapes (observed empirically — no public schema).
 *
 * Bluedot fires multiple event types per meeting, distinguished by `type`.
 * We currently only act on `transcript` (it has the full text we need to
 * embed) and skip `summary` (Bluedot's own summary, not used — Claude
 * generates structured output from the transcript).
 */

export type BluedotEventType = "transcript" | "summary" | string;

export interface BluedotTranscriptUtterance {
  speaker: string;
  text: string;
}

export interface BluedotWebhookPayload {
  type: BluedotEventType;
  meetingId: string;
  videoId: string;
  title: string;
  createdAt?: number;
  duration?: number;
  attendees?: string[];
  transcript?: BluedotTranscriptUtterance[];
  summary?: string;
  language?: string;
}

export interface NormalizedBluedotEvent {
  videoId: string;
  title: string;
  transcriptText: string;
  attendees: Array<{ email?: string; name?: string }>;
  language?: string;
  createdAt?: Date;
}

/**
 * Convert Bluedot's nested transcript array into a single labeled string
 * suitable for Claude summarization and OpenAI embeddings.
 */
export function flattenTranscript(utterances: BluedotTranscriptUtterance[]): string {
  return utterances
    .map((u) => {
      const speaker = (u.speaker ?? "").replace(/^Speaker:\s*/, "").trim();
      return speaker ? `${speaker}: ${u.text}` : u.text;
    })
    .join("\n");
}

/**
 * Map Bluedot's payload to our internal pipeline format.
 *
 * Uses `meetingId` as the canonical id (one row per meeting). Falls back
 * to `videoId` if meetingId is missing (defensive — unlikely in practice).
 */
export function normalizeTranscriptEvent(payload: BluedotWebhookPayload): NormalizedBluedotEvent {
  if (!payload.transcript || payload.transcript.length === 0) {
    throw new Error("Bluedot transcript event missing transcript[] array");
  }

  return {
    videoId: payload.meetingId || payload.videoId,
    title: payload.title || "Untitled meeting",
    transcriptText: flattenTranscript(payload.transcript),
    attendees: (payload.attendees ?? []).map((email) => ({ email })),
    language: payload.language,
    createdAt: payload.createdAt ? new Date(payload.createdAt * 1000) : undefined,
  };
}

/**
 * Bluedot's event type field has varied across sources (empirically observed):
 *   - `transcript` (dashboard test-webhook button)
 *   - `video.transcript.created` (Svix replays of older events)
 *   - `meeting.transcript.created` (real live events today)
 *
 * We accept any of these, and explicitly reject the summary counterparts
 * (which lack the transcript[] field we need to embed).
 */
export function isTranscriptEvent(payload: BluedotWebhookPayload): boolean {
  const t = payload.type ?? "";
  if (t.includes("summary")) return false;
  return t === "transcript" || t.endsWith(".transcript.created");
}
