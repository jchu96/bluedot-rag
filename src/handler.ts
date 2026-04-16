import OpenAI from "openai";
import * as Sentry from "@sentry/cloudflare";
import type { Env } from "./env";
import { verifyBluedotWebhook, WebhookVerificationError } from "./webhook-verify";
import {
  isTranscriptEvent,
  isSummaryEvent,
  normalizeTranscriptEvent,
  normalizeSummaryEvent,
  type BluedotWebhookPayload,
} from "./bluedot";
import { extractFromSummary, DEFAULT_MODEL } from "./extract";
import { chunkTranscript, generateEmbeddings } from "./embeddings";
import {
  upsertFromTranscriptEvent,
  upsertFromSummaryEvent,
  markNotionSynced,
} from "./d1";
import { upsertChunkEmbeddings, type EmbeddedChunk } from "./vectorize";
import {
  createTranscriptPage,
  createFollowupRow,
  type NotionDeps,
  createNotionDeps,
} from "./notion";
import { log } from "./logger";
import type { ActionItem, Participant } from "./schema";

export interface HandlerDeps {
  openai: OpenAI;
  notion: NotionDeps;
  env: Env;
}

export async function handleWebhook(
  request: Request,
  deps: HandlerDeps,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const body = await request.text();

  let payload: BluedotWebhookPayload;
  try {
    payload = verifyBluedotWebhook<BluedotWebhookPayload>(
      body,
      request.headers,
      deps.env.BLUEDOT_WEBHOOK_SECRET,
    );
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      log("warn", "webhook_verify_failed", { error: err.message });
      return new Response("Unauthorized", { status: 401 });
    }
    throw err;
  }

  const svixId = request.headers.get("svix-id") ?? "";
  log("info", "webhook_received", {
    type: payload.type,
    meeting_id: payload.meetingId,
    title: payload.title,
    svix_id: svixId,
  });

  if (isTranscriptEvent(payload)) {
    return handleTranscriptEvent(payload, svixId, deps);
  }
  if (isSummaryEvent(payload)) {
    return handleSummaryEvent(payload, svixId, deps);
  }

  log("info", "webhook_skipped_unknown_event", { type: payload.type });
  return new Response("OK (event ignored)", { status: 200 });
}

/**
 * Transcript event: write raw_text + embeddings. No Notion writes here —
 * those wait until summary event arrives (or notion_synced_at is null
 * when summary event runs).
 */
async function handleTranscriptEvent(
  payload: BluedotWebhookPayload,
  svixId: string,
  deps: HandlerDeps,
): Promise<Response> {
  let normalized;
  try {
    normalized = normalizeTranscriptEvent(payload);
  } catch (err) {
    log("error", "normalize_failed", {
      event: "transcript",
      error: err instanceof Error ? err.message : String(err),
      meeting_id: payload.meetingId,
    });
    return new Response("Bad payload", { status: 400 });
  }

  try {
    return await Sentry.startSpan(
      { name: "bluedot.pipeline.transcript", op: "pipeline", attributes: { video_id: normalized.videoId } },
      async () => {
        const upsert = await Sentry.startSpan(
          { name: "bluedot.d1.upsert_transcript", op: "db.write" },
          () => upsertFromTranscriptEvent(deps.env.DB, {
            videoId: normalized.videoId,
            svixId,
            title: normalized.title,
            rawText: normalized.transcriptText,
            participants: normalized.attendees.map((a) => ({ email: a.email })),
            language: normalized.language,
          }),
        );
        log("info", "transcript_event_upserted", {
          video_id: normalized.videoId,
          transcript_id: upsert.transcriptId,
          inserted: upsert.inserted,
          both_events_present: upsert.bothEventsPresent,
        });

        const chunks = chunkTranscript(normalized.transcriptText, { maxTokens: 500, overlapTokens: 50 });
        const embedded = await Sentry.startSpan(
          { name: "bluedot.openai.embed", op: "ai.embeddings", attributes: { chunks: chunks.length } },
          () => generateEmbeddings(chunks, { client: deps.openai }),
        );
        const vectorChunks: EmbeddedChunk[] = embedded.map((e) => ({
          transcriptId: upsert.transcriptId,
          chunkIndex: e.chunkIndex,
          text: e.text,
          embedding: e.embedding,
        }));
        await Sentry.startSpan(
          { name: "bluedot.vectorize.upsert", op: "db.write", attributes: { count: vectorChunks.length } },
          () => upsertChunkEmbeddings(deps.env.VECTORIZE, vectorChunks),
        );
        log("info", "vectors_upserted", { video_id: normalized.videoId, count: vectorChunks.length });

        if (upsert.bothEventsPresent && !upsert.alreadyNotionSynced) {
          await syncToNotion(deps, upsert.transcriptId, normalized.videoId);
        }

        return new Response("OK", { status: 200 });
      },
    );
  } catch (err) {
    Sentry.captureException(err, {
      tags: { pipeline: "transcript" },
      extra: { video_id: normalized.videoId, svix_id: svixId },
    });
    log("error", "pipeline_failed", {
      event: "transcript",
      video_id: normalized.videoId,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response("Processing failed", { status: 500 });
  }
}

/**
 * Summary event: extract action items from Bluedot's summary, upsert row,
 * trigger Notion writes if both events now present and not yet synced.
 */
async function handleSummaryEvent(
  payload: BluedotWebhookPayload,
  svixId: string,
  deps: HandlerDeps,
): Promise<Response> {
  let normalized;
  try {
    normalized = normalizeSummaryEvent(payload);
  } catch (err) {
    log("error", "normalize_failed", {
      event: "summary",
      error: err instanceof Error ? err.message : String(err),
      meeting_id: payload.meetingId,
    });
    return new Response("Bad payload", { status: 400 });
  }

  try {
    return await Sentry.startSpan(
      { name: "bluedot.pipeline.summary", op: "pipeline", attributes: { video_id: normalized.videoId } },
      async () => {
        const extracted = await Sentry.startSpan(
          { name: "bluedot.openai.extract", op: "ai.chat", attributes: { model: deps.env.OPENAI_EXTRACTION_MODEL || DEFAULT_MODEL } },
          () => extractFromSummary(
            {
              summary: normalized.summaryText,
              title: normalized.title,
              attendees: normalized.attendees,
              meetingDate: normalized.createdAt,
            },
            {
              client: deps.openai,
              model: deps.env.OPENAI_EXTRACTION_MODEL || DEFAULT_MODEL,
            },
          ),
        );
        log("info", "extract_ready", {
          video_id: normalized.videoId,
          action_items: extracted.action_items.length,
          participants: extracted.participants.length,
        });

        const participants =
          extracted.participants.length > 0
            ? extracted.participants
            : normalized.attendees.map((email) => ({ email }));

        const upsert = await Sentry.startSpan(
          { name: "bluedot.d1.upsert_summary", op: "db.write" },
          () => upsertFromSummaryEvent(deps.env.DB, {
            videoId: normalized.videoId,
            svixId,
            title: normalized.title,
            summary: normalized.summaryText,
            bluedotSummary: normalized.summaryText,
            participants,
            actionItems: extracted.action_items,
          }),
        );
        log("info", "summary_event_upserted", {
          video_id: normalized.videoId,
          transcript_id: upsert.transcriptId,
          inserted: upsert.inserted,
          both_events_present: upsert.bothEventsPresent,
        });

        if (upsert.bothEventsPresent && !upsert.alreadyNotionSynced) {
          await syncToNotion(deps, upsert.transcriptId, normalized.videoId);
        } else if (!upsert.bothEventsPresent) {
          log("info", "notion_deferred_awaiting_other_event", { video_id: normalized.videoId });
        }

        return new Response("OK", { status: 200 });
      },
    );
  } catch (err) {
    Sentry.captureException(err, {
      tags: { pipeline: "summary" },
      extra: { video_id: normalized.videoId, svix_id: svixId },
    });
    log("error", "pipeline_failed", {
      event: "summary",
      video_id: normalized.videoId,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response("Processing failed", { status: 500 });
  }
}

/**
 * Read the now-complete row and create Notion transcript page + Followups.
 * Marked as synced via markNotionSynced — won't run twice.
 */
async function syncToNotion(
  deps: HandlerDeps,
  transcriptId: number,
  videoId: string,
): Promise<void> {
  const row = await deps.env.DB
    .prepare(
      `SELECT title, summary, participants, action_items, language, notion_synced_at, created_at
       FROM transcripts WHERE id = ?1`,
    )
    .bind(transcriptId)
    .first<{
      title: string;
      summary: string;
      participants: string;
      action_items: string;
      language: string | null;
      notion_synced_at: string | null;
      created_at: string;
    }>();

  if (!row) {
    log("error", "notion_sync_row_missing", { transcript_id: transcriptId });
    return;
  }
  if (row.notion_synced_at) {
    log("info", "notion_sync_skipped_already_done", { transcript_id: transcriptId });
    return;
  }

  const participants = JSON.parse(row.participants) as Participant[];
  const actionItems = JSON.parse(row.action_items) as ActionItem[];
  const meetingUrl =
    videoId.startsWith("http") ? videoId : videoId.includes("meet.google.com/") || videoId.includes("zoom.us/") ? `https://${videoId}` : undefined;

  let pageId: string | undefined;
  try {
    const page = await Sentry.startSpan(
      { name: "bluedot.notion.create_transcript_page", op: "http.client" },
      () => createTranscriptPage(
        {
          dataSourceId: deps.env.NOTION_TRANSCRIPTS_DATA_SOURCE_ID,
          title: row.title,
          summary: row.summary,
          participants,
          actionItems,
          videoId,
          language: row.language,
          createdAt: new Date(row.created_at + "Z"),
        },
        deps.notion,
      ),
    );
    pageId = page.pageId;
    log("info", "transcript_page_created", { transcript_id: transcriptId, page_id: pageId });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { notion: "transcript_page" },
      extra: { transcript_id: transcriptId, video_id: videoId },
    });
    log("error", "transcript_page_failed", {
      transcript_id: transcriptId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let followupsCreated = 0;
  if (!pageId) {
    log("warn", "followups_skipped_no_transcript_page", {
      transcript_id: transcriptId,
      action_items: actionItems.length,
    });
  } else {
    for (const item of actionItems) {
      try {
        await Sentry.startSpan(
          { name: "bluedot.notion.create_followup", op: "http.client" },
          () => createFollowupRow(
            {
              dataSourceId: deps.env.NOTION_FOLLOWUPS_DATA_SOURCE_ID,
              task: item.task,
              owner: item.owner,
              due_date: item.due_date,
              meetingTitle: row.title,
              meetingUrl,
              videoId,
              transcriptPageId: pageId,
            },
            deps.notion,
          ),
        );
        followupsCreated++;
      } catch (err) {
        Sentry.captureException(err, {
          tags: { notion: "followup" },
          extra: { transcript_id: transcriptId, task: item.task, video_id: videoId },
        });
        log("error", "followup_failed", {
          transcript_id: transcriptId,
          task: item.task,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  log("info", "followups_created", {
    transcript_id: transcriptId,
    count: followupsCreated,
    total: actionItems.length,
  });

  // Mark synced so concurrent retries don't double-post
  if (pageId || followupsCreated > 0) {
    await markNotionSynced(deps.env.DB, transcriptId, pageId ?? "no-page");
  }
}

export function buildHandlerDeps(env: Env): HandlerDeps {
  return {
    openai: new OpenAI({ apiKey: env.OPENAI_API_KEY }),
    notion: createNotionDeps(env.NOTION_INTEGRATION_KEY),
    env,
  };
}
