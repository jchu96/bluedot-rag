import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { setupD1 } from "../../../test/setup-d1";
import { findActionItemsFor } from "./find_action_items_for";

async function seed(
  title: string,
  videoId: string,
  actionItems: any[],
  createdAt?: string,
) {
  if (createdAt) {
    await env.DB.prepare(
      `INSERT INTO transcripts (video_id, title, raw_text, summary, action_items, created_at)
       VALUES (?1, ?2, 'raw', 'summary', ?3, ?4)`,
    )
      .bind(videoId, title, JSON.stringify(actionItems), createdAt)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO transcripts (video_id, title, raw_text, summary, action_items)
       VALUES (?1, ?2, 'raw', 'summary', ?3)`,
    )
      .bind(videoId, title, JSON.stringify(actionItems))
      .run();
  }
}

describe("findActionItemsFor", () => {
  beforeEach(async () => {
    await setupD1();
  });

  it("filters action items by owner (case-insensitive substring match)", async () => {
    await seed("Sync A", "v-a", [
      { task: "Draft email", owner: "Andy Ross" },
      { task: "Review contract", owner: "Pierce" },
    ]);
    await seed("Sync B", "v-b", [
      { task: "Send summary", owner: "andy" },
    ]);

    const out = await findActionItemsFor({ person: "andy" }, env);
    const text = out.content[0].text;

    expect(text).toContain("Draft email");
    expect(text).toContain("Send summary");
    expect(text).not.toContain("Review contract");
  });

  it("respects the since filter", async () => {
    await seed("Old", "v-old", [{ task: "Old task", owner: "Andy" }], "2020-01-01 00:00:00");
    await seed("New", "v-new", [{ task: "New task", owner: "Andy" }]);

    const out = await findActionItemsFor(
      { person: "Andy", since: "2025-01-01" },
      env,
    );
    const text = out.content[0].text;

    expect(text).toContain("New task");
    expect(text).not.toContain("Old task");
  });

  it("returns an empty message when no matches", async () => {
    const out = await findActionItemsFor({ person: "NoSuchOne" }, env);
    expect(out.content[0].text.toLowerCase()).toContain("no action items");
  });
});
