import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { setupD1 } from "../../../test/setup-d1";
import { recentCalls } from "./recent_calls";

async function seed(rows: Array<{ video_id: string; title: string; created_at?: string }>) {
  for (const r of rows) {
    const createdAt = r.created_at ?? "datetime('now')";
    const isLiteral = r.created_at !== undefined;
    if (isLiteral) {
      await env.DB.prepare(
        `INSERT INTO transcripts (video_id, title, raw_text, summary, created_at)
         VALUES (?1, ?2, 'raw', 'summary', ?3)`,
      )
        .bind(r.video_id, r.title, r.created_at)
        .run();
    } else {
      await env.DB.prepare(
        `INSERT INTO transcripts (video_id, title, raw_text, summary)
         VALUES (?1, ?2, 'raw', 'summary')`,
      )
        .bind(r.video_id, r.title)
        .run();
    }
  }
}

describe("recentCalls", () => {
  beforeEach(async () => {
    await setupD1();
  });

  it("returns calls within the default 7-day window ordered newest first", async () => {
    await seed([
      { video_id: "v-old", title: "Old", created_at: "2025-01-01 00:00:00" },
      { video_id: "v-new", title: "New" },
    ]);

    const out = await recentCalls({}, env);
    expect(out.content).toHaveLength(1);
    const text = out.content[0].text;
    expect(text).toContain("New");
    expect(text).not.toContain("Old");
  });

  it("respects a custom days window", async () => {
    const longAgo = "2020-01-01 00:00:00";
    await seed([
      { video_id: "v-1", title: "Ancient", created_at: longAgo },
      { video_id: "v-2", title: "Recent" },
    ]);

    const out = await recentCalls({ days: 365 * 10 }, env);
    expect(out.content[0].text).toContain("Ancient");
    expect(out.content[0].text).toContain("Recent");
  });

  it("returns an empty-result message when no calls match", async () => {
    const out = await recentCalls({ days: 7 }, env);
    expect(out.content[0].text.toLowerCase()).toContain("no");
  });
});
