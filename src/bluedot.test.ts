import { describe, it, expect } from "vitest";
import {
  flattenTranscript,
  normalizeTranscriptEvent,
  isTranscriptEvent,
  type BluedotWebhookPayload,
} from "./bluedot";

const SAMPLE: BluedotWebhookPayload = {
  type: "transcript",
  meetingId: "meet.google.com/vtf-wvmj-utp",
  videoId: "v1",
  title: "Founder chat",
  createdAt: 1741088306,
  duration: 53.6,
  attendees: ["alice@example.com", "bob@example.com"],
  transcript: [
    { speaker: "Speaker: A", text: "How are you?" },
    { speaker: "Speaker: B", text: "Doing well." },
  ],
};

describe("flattenTranscript", () => {
  it("joins utterances with speaker labels", () => {
    expect(
      flattenTranscript([
        { speaker: "Speaker: A", text: "Hi" },
        { speaker: "Speaker: B", text: "Hello" },
      ]),
    ).toBe("A: Hi\nB: Hello");
  });

  it("handles missing speaker", () => {
    expect(flattenTranscript([{ speaker: "", text: "lonely" }])).toBe("lonely");
  });
});

describe("normalizeTranscriptEvent", () => {
  it("maps Bluedot fields to internal model", () => {
    const result = normalizeTranscriptEvent(SAMPLE);

    expect(result.videoId).toBe("meet.google.com/vtf-wvmj-utp");
    expect(result.title).toBe("Founder chat");
    expect(result.transcriptText).toBe("A: How are you?\nB: Doing well.");
    expect(result.attendees).toEqual([
      { email: "alice@example.com" },
      { email: "bob@example.com" },
    ]);
    expect(result.createdAt?.toISOString()).toBe("2025-03-04T11:38:26.000Z");
  });

  it("falls back to videoId if meetingId missing", () => {
    const r = normalizeTranscriptEvent({ ...SAMPLE, meetingId: "" });
    expect(r.videoId).toBe("v1");
  });

  it("throws when transcript is empty", () => {
    expect(() =>
      normalizeTranscriptEvent({ ...SAMPLE, transcript: [] }),
    ).toThrow(/missing transcript/i);
  });
});

describe("isTranscriptEvent", () => {
  it("returns true for test 'transcript' type", () => {
    expect(isTranscriptEvent(SAMPLE)).toBe(true);
  });

  it("returns true for 'video.transcript.created' (older Svix replays)", () => {
    expect(isTranscriptEvent({ ...SAMPLE, type: "video.transcript.created" })).toBe(true);
  });

  it("returns true for 'meeting.transcript.created' (real live events)", () => {
    expect(isTranscriptEvent({ ...SAMPLE, type: "meeting.transcript.created" })).toBe(true);
  });

  it("returns false for summary events in any namespace", () => {
    expect(isTranscriptEvent({ ...SAMPLE, type: "summary" })).toBe(false);
    expect(isTranscriptEvent({ ...SAMPLE, type: "video.summary.created" })).toBe(false);
    expect(isTranscriptEvent({ ...SAMPLE, type: "meeting.summary.created" })).toBe(false);
  });

  it("returns false for unknown event types", () => {
    expect(isTranscriptEvent({ ...SAMPLE, type: "something.else" })).toBe(false);
  });
});
