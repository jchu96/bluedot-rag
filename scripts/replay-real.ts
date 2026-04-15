/**
 * One-off: replay a known-good Bluedot event pair (transcript + summary) to
 * the new worker, signing with the new endpoint's signing secret. Useful
 * before Bluedot UI gives you a way to replay to a specific endpoint.
 *
 * Run: SIGNING_SECRET="whsec_..." WORKER_URL="https://..." npx tsx scripts/replay-real.ts
 */
import { createHmac } from "node:crypto";

const TARGET_URL = process.env.WORKER_URL ?? "https://aftercall.jeremy-chu.workers.dev";
const SIGNING_SECRET = process.env.SIGNING_SECRET;

if (!SIGNING_SECRET) {
  console.error("SIGNING_SECRET env var required (whsec_...)");
  process.exit(1);
}

// Fixture: founder / "head coach" transcript captured from real Bluedot fire
const transcriptPayload = {
  type: "meeting.transcript.created",
  meetingId: "https://meet.google.com/replay-test-001",
  videoId: "67c6e631d25b5829e8f3d66c",
  title: "Replay test — Founder role evolution",
  createdAt: 1741088306,
  duration: 53.6,
  attendees: ["test@example.com"],
  language: "en",
  transcript: [
    { speaker: "Speaker: A", text: "How has your job role changed from being a team of about four to being a team of over 20 now in the last few years?" },
    { speaker: "Speaker: B", text: "Yeah, really interesting." },
    { speaker: "Speaker: B", text: "So on day one, you're doing everything okay, and then your goal as a founder should always be to become completely obsolete." },
    { speaker: "Speaker: A", text: "Yeah, right." },
    { speaker: "Speaker: B", text: "I should be getting less busy every single day. So my role really changed." },
    { speaker: "Speaker: B", text: "On day one, I started being doing everything, you know, writing copy, doing marketing, coming up with product roadmaps." },
    { speaker: "Speaker: B", text: "So now, I'm really a head coach. I keep saying I want to change my job title from CEO to head coach." },
    { speaker: "Speaker: B", text: "Ultimately, all I'm here to do is to try and make my staff perform to their absolute ability." },
  ],
};

const summaryPayload = {
  type: "meeting.summary.created",
  meetingId: transcriptPayload.meetingId,
  videoId: transcriptPayload.videoId,
  title: transcriptPayload.title,
  createdAt: 1741087081,
  attendees: ["test@example.com"],
  summary:
    "The discussion focuses on the evolution of a founder's role as their company grows from a small team to a larger organization. The speaker describes their transition from handling all aspects of the business initially to becoming more of a 'head coach' for a team of over 20 people. The founder's primary objective is to become 'obsolete' by empowering their team to perform at their best.\n\nAction Items:\n- Jeremy to draft updated job description for 'head coach' role\n- Andy to share leadership philosophy doc by Friday",
  summaryV2:
    "## Overview\n\nThe discussion focuses on the evolution of a founder's role as their company grows from a small team to a larger organization. The speaker describes their transition from handling all aspects of the business initially to becoming more of a 'head coach' for a team of over 20 people. The founder's primary objective is to become 'obsolete' by empowering their team to perform at their best.\n\n## Action Items\n\n- Jeremy to draft updated job description for 'head coach' role\n- Andy to share leadership philosophy doc by Friday\n- Schedule follow-up to discuss delegation framework",
};

function svixSign(secret: string, msgId: string, timestamp: number, body: string): string {
  // secret format: "whsec_<base64>"
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const toSign = `${msgId}.${timestamp}.${body}`;
  const sig = createHmac("sha256", secretBytes).update(toSign).digest("base64");
  return `v1,${sig}`;
}

async function fireOne(name: string, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  const id = `msg_replay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = svixSign(SIGNING_SECRET!, id, timestamp, body);

  console.log(`\n→ ${name} (${id})`);
  const resp = await fetch(TARGET_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(timestamp),
      "svix-signature": signature,
    },
    body,
  });
  const text = await resp.text();
  console.log(`  ← ${resp.status} ${text}`);
}

async function main() {
  console.log(`Target: ${TARGET_URL}`);
  await fireOne("transcript event", transcriptPayload);
  // Wait a moment to mimic Bluedot's real ~13s delay (shorter for a script)
  await new Promise((r) => setTimeout(r, 2000));
  await fireOne("summary event", summaryPayload);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
