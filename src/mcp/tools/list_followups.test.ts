import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { listFollowups } from "./list_followups";

function mockNotionFetch(response: any): typeof fetch {
  return vi.fn(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    expect(url).toContain("/v1/data_sources/");
    expect(url).toContain("/query");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${env.NOTION_INTEGRATION_KEY}`);
    expect(init.headers["Notion-Version"]).toBeTruthy();
    return new Response(JSON.stringify(response), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("listFollowups", () => {
  it("returns formatted followups from Notion with no filters", async () => {
    const fetchMock = mockNotionFetch({
      results: [
        {
          id: "page-1",
          url: "https://notion.so/page-1",
          properties: {
            Name: { title: [{ plain_text: "Send proposal to Pierce" }] },
            Status: { select: { name: "Inbox" } },
            Priority: { select: { name: "P1" } },
            Due: { date: { start: "2026-04-21" } },
            Owner: { rich_text: [{ plain_text: "Jeremy" }] },
            Source: { select: { name: "Bluedot" } },
            "Meeting Title": { rich_text: [{ plain_text: "Weekly sync" }] },
          },
        },
      ],
      has_more: false,
      next_cursor: null,
    });

    const out = await listFollowups({}, env, { fetchFn: fetchMock });

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse((fetchMock as any).mock.calls[0][1].body as string);
    expect(body.filter).toBeUndefined();
    expect(body.page_size).toBeGreaterThan(0);

    const text = out.content[0].text;
    expect(text).toContain("Send proposal to Pierce");
    expect(text).toContain("Inbox");
    expect(text).toContain("2026-04-21");
    expect(text).toContain("https://notion.so/page-1");
  });

  it("builds a status filter when provided", async () => {
    const fetchMock = mockNotionFetch({ results: [], has_more: false, next_cursor: null });

    await listFollowups({ status: "In Progress" }, env, { fetchFn: fetchMock });

    const body = JSON.parse((fetchMock as any).mock.calls[0][1].body as string);
    expect(body.filter).toEqual({
      property: "Status",
      select: { equals: "In Progress" },
    });
  });

  it("builds a combined status+source filter via and-composition", async () => {
    const fetchMock = mockNotionFetch({ results: [], has_more: false, next_cursor: null });

    await listFollowups(
      { status: "Inbox", source: "Bluedot" },
      env,
      { fetchFn: fetchMock },
    );

    const body = JSON.parse((fetchMock as any).mock.calls[0][1].body as string);
    expect(body.filter.and).toHaveLength(2);
    expect(body.filter.and).toContainEqual({
      property: "Status",
      select: { equals: "Inbox" },
    });
    expect(body.filter.and).toContainEqual({
      property: "Source",
      select: { equals: "Bluedot" },
    });
  });

  it("respects limit (page_size)", async () => {
    const fetchMock = mockNotionFetch({ results: [], has_more: false, next_cursor: null });
    await listFollowups({ limit: 3 }, env, { fetchFn: fetchMock });
    const body = JSON.parse((fetchMock as any).mock.calls[0][1].body as string);
    expect(body.page_size).toBe(3);
  });

  it("surfaces Notion API errors with status code", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 }),
    ) as unknown as typeof fetch;

    const out = await listFollowups({}, env, { fetchFn: fetchMock });
    const text = out.content[0].text.toLowerCase();
    expect(text).toContain("error");
    expect(text).toContain("401");
  });

  it("returns empty message when Notion returns zero results", async () => {
    const fetchMock = mockNotionFetch({ results: [], has_more: false, next_cursor: null });
    const out = await listFollowups({}, env, { fetchFn: fetchMock });
    expect(out.content[0].text.toLowerCase()).toContain("no followups");
  });
});
