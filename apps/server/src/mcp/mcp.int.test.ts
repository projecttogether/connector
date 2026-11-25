import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../db/client";
import { activity } from "../db/schema";
import { upsertItem } from "../sources/index-store";
import { logbookItem } from "../sources/logbook";
import {
  createAdminToken,
  createSource,
  createToken,
  createUser,
  request,
  resetDatabase,
} from "../test/helpers";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

const MCP_HEADERS = { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
let sequence = 0;

async function rpc(token: string | undefined, method: string, params: Record<string, unknown> = {}) {
  return request("POST", "/mcp", {
    token,
    body: { jsonrpc: "2.0", id: ++sequence, method, params },
    headers: MCP_HEADERS,
  });
}

type ToolResult = {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
};

async function call(token: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const response = await rpc(token, "tools/call", { name, arguments: args });
  expect(response.status).toBe(200);
  expect(response.body.error).toBeUndefined();
  return response.body.result as ToolResult;
}

/** The structured result of a successful tool call. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read results loosely
async function data(token: string, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await call(token, name, args);
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  return result.structuredContent;
}

async function setup() {
  const reader = await createUser({ name: "Rea Reader", signInGroups: ["/staff"], title: "Program lead" });
  const logbook = await createSource({
    kind: "logbook",
    name: "Logbook",
    config: { baseUrl: "https://logbook.example.org" },
    secret: { webhookSecret: "webhook-secret-value" },
    serviceAccess: true,
  });
  await upsertItem(
    getDb(),
    logbook.id,
    logbookItem({
      event: "entry.changed",
      entry: {
        id: "entry-4",
        ref: "LB-4",
        url: "https://logbook.example.org/e/LB-4",
        type: "decision",
        status: "decided",
        title: "Laptops are replaced after four years",
        summary: "Every laptop is replaced after four years.",
        details: "",
        rationale: "",
        impact: "low",
        team: "IT",
        affected_teams: [],
        tags: [],
        author: "Ada",
        published_at: "2026-11-01T09:00:00.000Z",
        in_force: true,
        supersedes: null,
        superseded_by: null,
        decision: {
          result: "adopted",
          text: "Replace laptops after four years.",
          reversibility: "two_way",
          how_decided: "integrative_process",
          decider: "Ada",
          decided_on: "2026-11-01",
          decided_at: "2026-11-01T09:00:00.000Z",
          objection_handling: null,
          open_objections: [],
          consent_givers: [],
          involved: [],
          proposal_version: 1,
        },
        addenda: [],
      },
    }),
  );
  return { reader, token: await createToken(reader.id, "Claude") };
}

describe("MCP server", () => {
  beforeEach(resetDatabase);

  it("asks for sign-in with the resource metadata, and is stateless", async () => {
    const missing = await rpc(undefined, "initialize");
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"',
    );
    expect(missing.headers.get("access-control-allow-origin")).toBe("*");
    expect((await rpc("cn_pat_not-a-real-token", "initialize")).status).toBe(401);
    // Bearer tokens only: a signed-in browser's session does not count.
    const { reader } = await setup();
    const withSession = await request("POST", "/mcp", {
      userId: reader.id,
      body: { jsonrpc: "2.0", id: ++sequence, method: "tools/list", params: {} },
      headers: MCP_HEADERS,
    });
    expect(withSession.status).toBe(401);
    expect((await request("GET", "/mcp", { headers: MCP_HEADERS })).status).toBe(405);
  });

  it("initializes and lists the tools with annotations", async () => {
    const { token } = await setup();
    const init = await rpc(token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe("connector");
    expect(init.body.result.instructions).toContain("Source order");
    const list = await rpc(token, "tools/list");
    const tools = list.body.result.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[];
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "fetch",
        "find_people",
        "get_context",
        "list_sources",
        "propose_handbook_change",
        "recent_changes",
        "search",
      ].sort(),
    );
    expect(tools.filter((tool) => !tool.annotations?.readOnlyHint).map((tool) => tool.name)).toEqual([
      "propose_handbook_change",
    ]);
  });

  it("searches and fetches in the shape ChatGPT expects, without highlight marks", async () => {
    const { token } = await setup();
    const found = await data(token, "search", { query: "laptops" });
    expect(found.results).toEqual([
      expect.objectContaining({
        id: "logbook:decision:entry-4",
        title: "LB-4: Laptops are replaced after four years",
        url: "https://logbook.example.org/e/LB-4",
        source: "Logbook",
        authority: "Decisions in force",
        status: "in force",
      }),
    ]);
    expect(found.results[0].text).not.toContain("\u0002");
    expect(found.results[0].text).not.toContain("\u0003");
    expect(found.unavailable).toEqual([]);
    const item = await data(token, "fetch", { id: "logbook:decision:entry-4" });
    expect(Object.keys(item)).toEqual(["id", "title", "text", "url", "metadata"]);
    expect(item.text).toContain("Replace laptops after four years.");
    expect(item.metadata).toMatchObject({
      source: "Logbook",
      type: "decision",
      status: "in force",
      decider: "Ada",
    });
    const missing = await call(token, "fetch", { id: "logbook:decision:nothing" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain("404");
    const rows = await getDb().select().from(activity);
    expect(rows.map((row) => [row.action, row.client])).toEqual(
      expect.arrayContaining([
        ["search", "Claude"],
        ["fetch", "Claude"],
      ]),
    );
  });

  it("gives context, recent changes, sources and people", async () => {
    const { token } = await setup();
    await createUser({
      name: "Olga Operations",
      email: "olga@example.org",
      title: "Office manager",
      signInGroups: ["/staff/ops"],
    });
    const context = await data(token, "get_context", { topic: "laptop replacement" });
    expect(context.sections).toEqual([
      expect.objectContaining({
        level: "Decisions in force",
        items: [expect.objectContaining({ id: "logbook:decision:entry-4" })],
      }),
    ]);
    const recent = await data(token, "recent_changes", { days: 90 });
    expect(Array.isArray(recent.items)).toBe(true);
    const sources = await data(token, "list_sources");
    expect(sources.sources).toEqual([
      // The status page's state: items came in, but no delivery yet.
      expect.objectContaining({ slug: "logbook", name: "Logbook", state: "waiting", linkedAccount: null }),
    ]);
    expect(sources.sourceOrder[0]).toBe(
      "1. Purpose and rules: Handbook pages in the spaces that hold the purpose and the rules",
    );
    const people = await data(token, "find_people", { query: "office" });
    expect(people.people).toEqual([
      { name: "Olga Operations", email: "olga@example.org", title: "Office manager", groups: ["/staff/ops"] },
    ]);
  });

  it("lets service tokens read but not look up people or propose", async () => {
    await setup();
    const bot = await createAdminToken("service", "Bot");
    expect((await data(bot, "search", { query: "laptops" })).results).toHaveLength(1);
    expect((await call(bot, "find_people", { query: "a" })).isError).toBe(true);
    const proposal = await call(bot, "propose_handbook_change", {
      title: "x",
      description: "y",
      new_page: { space: "it", path: "x", title: "X", body: "" },
    });
    expect(proposal.isError).toBe(true);
  });
});
