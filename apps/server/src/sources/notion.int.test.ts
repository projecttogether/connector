import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "../config";
import { bearerOf, startFakeApp, type FakeApp, type FakeRequest } from "../test/fake-app";
import { createSource, createUser, request, resetDatabase } from "../test/helpers";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

/*
 * A stand-in for Notion's API: two databases shared with the integration
 * (a wiki and meeting notes), a third that is shared but not chosen in
 * Connector, and one that is not shared at all. Queries apply their filters
 * to the pages, as Notion does.
 */

const WIKI = "1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6";
const MEETINGS = "2b3c4d5e-6f7a-48b9-80d1-e2f3a4b5c6d7";
const OTHER = "3c4d5e6f-7a8b-49c0-91e2-f3a4b5c6d7e8";
const UNSHARED = "4d5e6f7a-8b9c-40d1-a2f3-a4b5c6d7e8f9";
/** Each database has one table (data source). */
/** Empty databases, for a source with many. */
const PROJECTS = "5e6f7a8b-9c0d-41e2-b3f4-a5b6c7d8e9f0";
const PARTNERS = "6f7a8b9c-0d1e-42f3-84a5-b6c7d8e9f0a1";
const EVENTS = "7a8b9c0d-1e2f-43a4-95b6-c7d8e9f0a1b2";
const TABLE: Record<string, string> = {
  [WIKI]: "aaaaaaaa-0000-4000-8000-00000000000a",
  [MEETINGS]: "aaaaaaaa-0000-4000-8000-00000000000b",
  [OTHER]: "aaaaaaaa-0000-4000-8000-00000000000c",
  [PROJECTS]: "aaaaaaaa-0000-4000-8000-00000000000d",
  [PARTNERS]: "aaaaaaaa-0000-4000-8000-00000000000e",
  [EVENTS]: "aaaaaaaa-0000-4000-8000-00000000000f",
};

const POLICY = "bbbbbbbb-0000-4000-8000-000000000001";
const OLD_POLICY = "bbbbbbbb-0000-4000-8000-000000000002";
const MEETING = "bbbbbbbb-0000-4000-8000-000000000003";
const OUTSIDE = "bbbbbbbb-0000-4000-8000-000000000004";
const TRASHED = "bbbbbbbb-0000-4000-8000-000000000005";
const MOVED = "bbbbbbbb-0000-4000-8000-000000000006";

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const text = (value: string) => [{ type: "text", plain_text: value }];

type FakePage = {
  id: string;
  database: string;
  edited: string;
  trashed?: boolean;
  /** The database Notion names as its parent, when the table moved there since Connector read it. */
  movedTo?: string;
  properties: Record<string, { id: string; type: string; [key: string]: unknown }>;
};

const PAGES: FakePage[] = [
  {
    id: POLICY,
    database: WIKI,
    edited: daysAgo(40),
    properties: {
      Name: { id: "title", type: "title", title: text("Travel policy") },
      Summary: {
        id: "sum",
        type: "rich_text",
        rich_text: text("How we book trains and hotels for work trips."),
      },
      Status: { id: "sts", type: "status", status: { id: "s1", name: "Published", color: "green" } },
      Owner: { id: "own", type: "people", people: [{ object: "user", id: "u1", name: "Rita Reader" }] },
      Related: { id: "rel", type: "relation", relation: [{ id: OLD_POLICY }], has_more: false },
    },
  },
  {
    id: OLD_POLICY,
    database: WIKI,
    edited: daysAgo(90),
    properties: {
      Name: { id: "title", type: "title", title: text("Expenses") },
      Summary: { id: "sum", type: "rich_text", rich_text: text("Claim travel costs within a month.") },
      Status: { id: "sts", type: "status", status: { id: "s2", name: "Draft", color: "gray" } },
    },
  },
  {
    id: MEETING,
    database: MEETINGS,
    edited: daysAgo(1),
    properties: {
      Title: { id: "title", type: "title", title: text("Team meeting") },
      Notes: {
        id: "nts",
        type: "rich_text",
        rich_text: text("We agreed on the travel budget for the spring."),
      },
      Date: { id: "dat", type: "date", date: { start: "2026-11-20", end: null } },
    },
  },
  {
    id: OUTSIDE,
    database: OTHER,
    edited: daysAgo(1),
    properties: {
      Name: { id: "title", type: "title", title: text("Travel salaries") },
      Notes: { id: "nts", type: "rich_text", rich_text: text("Not for everyone.") },
    },
  },
  {
    id: TRASHED,
    database: WIKI,
    edited: daysAgo(2),
    trashed: true,
    properties: { Name: { id: "title", type: "title", title: text("Old travel policy") } },
  },
  {
    id: MOVED,
    database: WIKI,
    movedTo: OTHER,
    edited: daysAgo(3),
    properties: { Name: { id: "title", type: "title", title: text("Travel allowances") } },
  },
];

const PROPERTIES: Record<string, Record<string, { id: string; name: string; type: string }>> = {
  [WIKI]: {
    Name: { id: "title", name: "Name", type: "title" },
    Summary: { id: "sum", name: "Summary", type: "rich_text" },
    Status: { id: "sts", name: "Status", type: "status" },
    Owner: { id: "own", name: "Owner", type: "people" },
    Related: { id: "rel", name: "Related", type: "relation" },
  },
  [MEETINGS]: {
    Title: { id: "title", name: "Title", type: "title" },
    Notes: { id: "nts", name: "Notes", type: "rich_text" },
    Date: { id: "dat", name: "Date", type: "date" },
  },
  [OTHER]: {
    Name: { id: "title", name: "Name", type: "title" },
    Notes: { id: "nts", name: "Notes", type: "rich_text" },
  },
};
const TITLES: Record<string, string> = {
  [WIKI]: "Wiki",
  [MEETINGS]: "Meeting notes",
  [OTHER]: "Salaries",
  [PROJECTS]: "Projects",
  [PARTNERS]: "Partners",
  [EVENTS]: "Events",
};

const notFound = {
  status: 404,
  json: { object: "error", status: 404, code: "object_not_found", message: "Could not find it." },
};

function pageJson(page: FakePage) {
  return {
    object: "page",
    id: page.id,
    url: `https://www.notion.so/${page.id.replaceAll("-", "")}`,
    last_edited_time: page.edited,
    in_trash: page.trashed ?? false,
    is_archived: false,
    parent: {
      type: "data_source_id",
      data_source_id: TABLE[page.database],
      database_id: page.movedTo ?? page.database,
    },
    properties: page.properties,
  };
}

/** Notion's filters on the fake pages: compound groups, text contains, last edited. */
function matches(page: FakePage, filter: Record<string, unknown> | undefined): boolean {
  if (!filter) return true;
  if (Array.isArray(filter.or))
    return filter.or.some((part) => matches(page, part as Record<string, unknown>));
  if (Array.isArray(filter.and))
    return filter.and.every((part) => matches(page, part as Record<string, unknown>));
  if (filter.timestamp === "last_edited_time") {
    return page.edited >= (filter.last_edited_time as { on_or_after: string }).on_or_after;
  }
  const property = Object.values(page.properties).find((candidate) => candidate.id === filter.property);
  const condition = (filter.title ?? filter.rich_text) as { contains: string } | undefined;
  if (!property || !condition) return false;
  const value = (property[property.type] as { plain_text: string }[]).map((part) => part.plain_text).join("");
  return value.toLowerCase().includes(condition.contains.toLowerCase());
}

let notion: FakeApp;
const queries: { table: string; body: Record<string, unknown>; at: number }[] = [];
/** How long Notion takes to describe a database or a table. */
let metadataDelayMs = 0;

function answer(req: FakeRequest) {
  if (bearerOf(req) !== "ntn_secret")
    return {
      status: 401,
      json: { object: "error", status: 401, code: "unauthorized", message: "API token is invalid." },
    };
  if (req.headers["notion-version"] !== "2026-03-11")
    return {
      status: 400,
      json: { object: "error", status: 400, code: "missing_version", message: "No version" },
    };
  let match = /^\/v1\/databases\/([0-9a-f-]+)$/.exec(req.path);
  if (match && TITLES[match[1]!]) {
    const id = match[1]!;
    return {
      delayMs: metadataDelayMs,
      json: {
        object: "database",
        id,
        title: text(TITLES[id]!),
        data_sources: [{ id: TABLE[id], name: TITLES[id] }],
      },
    };
  }
  match = /^\/v1\/data_sources\/([0-9a-f-]+)(\/query)?$/.exec(req.path);
  const database = match ? Object.keys(TABLE).find((id) => TABLE[id] === match![1]) : undefined;
  if (match && database && !match[2]) {
    return {
      delayMs: metadataDelayMs,
      json: {
        object: "data_source",
        id: match[1],
        title: text(TITLES[database]!),
        properties: PROPERTIES[database] ?? { Name: { id: "title", name: "Name", type: "title" } },
      },
    };
  }
  if (match && database && req.method === "POST") {
    const body = JSON.parse(req.body) as Record<string, unknown>;
    queries.push({ table: match[1]!, body, at: Date.now() });
    const results = PAGES.filter(
      (page) =>
        page.database === database && !page.trashed && matches(page, body.filter as Record<string, unknown>),
    ).sort((a, b) => b.edited.localeCompare(a.edited));
    return { json: { object: "list", results: results.map(pageJson), next_cursor: null, has_more: false } };
  }
  match = /^\/v1\/pages\/([0-9a-f-]+)(\/markdown)?$/.exec(req.path);
  const page = match ? PAGES.find((candidate) => candidate.id === match![1]) : undefined;
  if (page && match![2]) {
    return {
      json: {
        object: "page_markdown",
        id: page.id,
        markdown: "## Booking\n\nBook trains at least two weeks ahead.",
        truncated: false,
        unknown_block_ids: [],
      },
    };
  }
  if (page) return { json: pageJson(page) };
  return notFound;
}

beforeAll(async () => {
  notion = await startFakeApp(answer);
});
afterAll(() => notion.close());

async function connect(databases: unknown[], options: { secret?: string; accessGroups?: string[] } = {}) {
  return createSource({
    kind: "notion",
    slug: "notion",
    name: "Notion",
    config: { baseUrl: "https://www.notion.so/example-org", databases, apiUrl: notion.url },
    secret: { integrationSecret: options.secret ?? "ntn_secret" },
    accessGroups: options.accessGroups,
  });
}

describe("Notion", () => {
  beforeEach(async () => {
    await resetDatabase();
    queries.length = 0;
    metadataDelayMs = 0;
    notion.requests.length = 0;
  });

  it("lets admins connect several databases by link or ID and checks each", async () => {
    const admin = await createUser({ isAdmin: true });
    const created = await request("POST", "/api/v1/admin/sources", {
      userId: admin.id,
      body: {
        kind: "notion",
        slug: "notion",
        name: "Notion",
        config: {
          databases: [
            {
              id: `https://www.notion.so/example-org/Wiki-${WIKI.replaceAll("-", "")}?v=0123456789abcdef0123456789abcdef`,
            },
            { id: MEETINGS.replaceAll("-", "").toUpperCase(), authority: "history" },
          ],
          apiUrl: notion.url,
        },
        secret: { integrationSecret: "ntn_wrong" },
      },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      kind: "notion",
      config: {
        baseUrl: "https://www.notion.so",
        databases: [
          { id: WIKI, authority: "knowledge" },
          { id: MEETINGS, authority: "history" },
        ],
        apiUrl: notion.url,
      },
      secrets: { integrationSecret: "…rong" },
      webhookUrl: null,
    });
    const id = created.body.id as string;
    const check = () => request("POST", `/api/v1/admin/sources/${id}/check`, { userId: admin.id });

    expect((await check()).body).toEqual({
      ok: false,
      message: "Notion refused the credentials: API token is invalid.",
    });
    await request("PATCH", `/api/v1/admin/sources/${id}`, {
      userId: admin.id,
      body: { secret: { integrationSecret: "ntn_secret" } },
    });
    expect((await check()).body).toEqual({
      ok: true,
      message: "Reached Notion; searching Wiki, Meeting notes",
    });

    // A database the integration may not read fails the check, by its ID.
    const changed = await request("PATCH", `/api/v1/admin/sources/${id}`, {
      userId: admin.id,
      body: {
        config: { ...created.body.config, databases: [...created.body.config.databases, { id: UNSHARED }] },
      },
    });
    expect(changed.body.secrets).toEqual({ integrationSecret: "…cret" });
    expect((await check()).body).toEqual({
      ok: false,
      message: `Notion has no database ${UNSHARED} for the integration: share the database with it, or check its link`,
    });

    // Bad settings are field errors.
    const bad = await request("PATCH", `/api/v1/admin/sources/${id}`, {
      userId: admin.id,
      body: { config: { databases: [{ id: "not a link" }, { id: WIKI }, { id: WIKI }] } },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.fields).toMatchObject({
      "config.databases.0.id": "Paste the database's link or ID",
    });
    const none = await request("PATCH", `/api/v1/admin/sources/${id}`, {
      userId: admin.id,
      body: { config: { databases: [] } },
    });
    expect(none.body.error.fields).toEqual({ "config.databases": "Add a database" });

    // A new API address drops the secret: it is not sent anywhere unasked.
    const moved = await request("PATCH", `/api/v1/admin/sources/${id}`, {
      userId: admin.id,
      body: { config: { ...created.body.config, apiUrl: "https://notion-proxy.example.org" } },
    });
    expect(moved.body.secrets).toEqual({});
  });

  it("searches every chosen database for all words, each at its level, and only those", async () => {
    await connect([
      { id: WIKI, authority: "knowledge" },
      { id: MEETINGS, authority: "history" },
    ]);
    const rita = await createUser();
    const response = await request("GET", "/api/v1/search?q=the%20travel%20policy", { userId: rita.id });
    expect(response.status).toBe(200);
    expect(response.body.results).toEqual([
      {
        id: `notion:page:${POLICY}`,
        title: "Travel policy",
        url: `https://www.notion.so/${POLICY.replaceAll("-", "")}`,
        snippet: "How we book trains and hotels for work trips.",
        type: "page",
        source: { slug: "notion", name: "Notion", kind: "notion" },
        authority: "knowledge",
        date: expect.any(String),
        status: "Published",
      },
    ]);
    expect(response.body.sources).toEqual([expect.objectContaining({ slug: "notion", ok: true, count: 1 })]);
    // Each word must match the title or a text property; "the" is too common to count.
    expect(queries.find((query) => query.table === TABLE[WIKI])?.body.filter).toEqual({
      and: ["travel", "policy"].map((term) => ({
        or: [
          { property: "title", title: { contains: term } },
          { property: "sum", rich_text: { contains: term } },
        ],
      })),
    });

    const travel = await request("GET", "/api/v1/search?q=travel", { userId: rita.id });
    const found = travel.body.results.map((result: { id: string; authority: string }) => [
      result.id,
      result.authority,
    ]);
    // Title matches first; the database outside the source, a page whose table moved
    // to another database and the trashed page never appear.
    expect(found).toEqual([
      [`notion:page:${POLICY}`, "knowledge"],
      [`notion:page:${MEETING}`, "history"],
      [`notion:page:${OLD_POLICY}`, "knowledge"],
    ]);
    expect(queries.some((query) => query.table === TABLE[OTHER])).toBe(false);
    const meeting = travel.body.results.find(
      (result: { id: string }) => result.id === `notion:page:${MEETING}`,
    );
    expect(meeting.snippet).toBe("We agreed on the travel budget for the spring.");
  });

  it("reads pages of the chosen databases in full, and no others", async () => {
    await connect([{ id: WIKI }, { id: MEETINGS, authority: "history" }]);
    const rita = await createUser();
    const read = (id: string) =>
      request("GET", `/api/v1/items/${encodeURIComponent(`notion:page:${id}`)}`, { userId: rita.id });
    const policy = await read(POLICY);
    expect(policy.status).toBe(200);
    expect(policy.body).toMatchObject({
      id: `notion:page:${POLICY}`,
      title: "Travel policy",
      url: `https://www.notion.so/${POLICY.replaceAll("-", "")}`,
      authority: "knowledge",
      status: "Published",
      metadata: { database: "Wiki" },
    });
    expect(policy.body.text).toBe(
      [
        "# Travel policy",
        "",
        "- **Summary:** How we book trains and hotels for work trips.",
        "- **Status:** Published",
        "- **Owner:** Rita Reader",
        "",
        "## Booking",
        "",
        "Book trains at least two weeks ahead.",
      ].join("\n"),
    );
    const markdown = notion.requests.find((req) => req.path === `/v1/pages/${POLICY}/markdown`);
    expect(markdown?.url.searchParams.get("markdown_version")).toBe("v2");

    // A page the integration sees in another database, a trashed page and an unknown one are not found.
    expect((await read(OUTSIDE)).status).toBe(404);
    expect(notion.requests.some((req) => req.path === `/v1/pages/${OUTSIDE}/markdown`)).toBe(false);
    expect((await read(TRASHED)).status).toBe(404);
    expect((await read("cccccccc-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await read("not-an-id")).status).toBe(404);
  });

  it("keeps searching the databases that answer when one fails", async () => {
    await connect([{ id: WIKI }, { id: UNSHARED }]);
    const rita = await createUser();
    const response = await request("GET", "/api/v1/search?q=travel", { userId: rita.id });
    expect(response.body.results.map((result: { id: string }) => result.id)).toEqual([
      `notion:page:${POLICY}`,
      `notion:page:${OLD_POLICY}`,
    ]);
    expect(response.body.sources).toEqual([expect.objectContaining({ slug: "notion", ok: true })]);
  });

  it("fails as a source when no database answers, without failing the search", async () => {
    await connect([{ id: WIKI }], { secret: "ntn_wrong" });
    const rita = await createUser();
    const response = await request("GET", "/api/v1/search?q=travel", { userId: rita.id });
    expect(response.status).toBe(200);
    expect(response.body.results).toEqual([]);
    expect(response.body.sources).toEqual([
      expect.objectContaining({
        slug: "notion",
        ok: false,
        error: "Notion refused the credentials: API token is invalid.",
      }),
    ]);
  });

  it("asks three tables at once and the rest a third of a second apart", async () => {
    await connect([{ id: WIKI }, { id: MEETINGS }, { id: OTHER }, { id: PROJECTS }, { id: PARTNERS }]);
    const rita = await createUser();
    const response = await request("GET", "/api/v1/search?q=travel", { userId: rita.id });
    expect(response.body.sources).toEqual([expect.objectContaining({ slug: "notion", ok: true })]);
    expect(queries).toHaveLength(5);
    const first = Math.min(...queries.map((query) => query.at));
    const startOf = (database: string) =>
      queries.find((query) => query.table === TABLE[database])!.at - first;
    expect(startOf(PROJECTS)).toBeGreaterThanOrEqual(300);
    expect(startOf(PARTNERS)).toBeGreaterThanOrEqual(650);
  });

  it("answers within a short source time when reading the tables was slow, from all six databases", async () => {
    process.env.SOURCE_TIMEOUT_SECONDS = "1";
    resetConfigForTests();
    // Reading the databases and their tables takes half the time already.
    metadataDelayMs = 250;
    try {
      await connect([WIKI, MEETINGS, OTHER, PROJECTS, PARTNERS, EVENTS].map((id) => ({ id })));
      const rita = await createUser();
      const response = await request("GET", "/api/v1/search?q=policy", { userId: rita.id });
      expect(response.body.sources).toEqual([
        expect.objectContaining({ slug: "notion", ok: true, count: 1 }),
      ]);
      expect(queries).toHaveLength(6);
    } finally {
      delete process.env.SOURCE_TIMEOUT_SECONDS;
      resetConfigForTests();
    }
  });

  it("lists recent changes of the chosen databases, newest first", async () => {
    await connect([{ id: WIKI }, { id: MEETINGS, authority: "history" }]);
    const rita = await createUser();
    const response = await request("GET", "/api/v1/recent?days=7", { userId: rita.id });
    expect(response.body.items.map((item: { id: string }) => item.id)).toEqual([`notion:page:${MEETING}`]);
    const filter = queries[0]!.body.filter as {
      timestamp: string;
      last_edited_time: { on_or_after: string };
    };
    expect(filter.timestamp).toBe("last_edited_time");
    expect(Date.now() - Date.parse(filter.last_edited_time.on_or_after)).toBeGreaterThan(6.9 * 86_400_000);
    expect(queries[0]!.body.sorts).toEqual([{ timestamp: "last_edited_time", direction: "descending" }]);
  });

  it("is open only to its access groups", async () => {
    await connect([{ id: WIKI }], { accessGroups: ["/staff"] });
    const outsider = await createUser();
    const response = await request("GET", "/api/v1/search?q=travel", { userId: outsider.id });
    expect(response.body.results).toEqual([]);
    expect(notion.requests).toHaveLength(0);
    expect(
      (
        await request("GET", `/api/v1/items/${encodeURIComponent(`notion:page:${POLICY}`)}`, {
          userId: outsider.id,
        })
      ).status,
    ).toBe(404);
  });
});
