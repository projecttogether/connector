import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../db/client";
import { activity } from "../db/schema";
import { resetConfigForTests } from "../config";
import { upsertItem } from "../sources/index-store";
import { logbookItem } from "../sources/logbook";
import { libraryItem } from "../sources/library";
import { bearerOf, startFakeApp, type FakeApp } from "../test/fake-app";
import {
  createAdminToken,
  createGroup,
  createSource,
  createToken,
  createUser,
  request,
  resetDatabase,
} from "../test/helpers";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

const PAGE_ID = "11111111-1111-4111-8111-111111111111";
const POLICY_ID = "22222222-2222-4222-8222-222222222222";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";

let handbook: FakeApp;
let crm: FakeApp;
let slow: FakeApp;

beforeAll(async () => {
  process.env.SOURCE_TIMEOUT_SECONDS = "1";
  resetConfigForTests();
  handbook = await startFakeApp((req) => {
    if (bearerOf(req) !== "kn_svc_handbook")
      return { status: 401, json: { error: { code: "unauthorized", message: "Sign in" } } };
    if (req.path === "/api/v1/search") {
      return {
        json: {
          results: [
            {
              pageId: PAGE_ID,
              space: { slug: "it", name: "IT" },
              path: "remote-work",
              title: "Remote work",
              description: "How we work from home",
              headingPath: ["Equipment"],
              anchor: "equipment",
              url: `${handbook.url}/s/it/remote-work#equipment`,
              snippet: "Staff work \u0002remote\u0003 two days a week.",
              tags: [],
              type: null,
              score: 1,
            },
            {
              pageId: POLICY_ID,
              space: { slug: "policies", name: "Policies" },
              path: "travel",
              title: "Travel policy",
              description: null,
              headingPath: [],
              anchor: null,
              url: `${handbook.url}/s/policies/travel`,
              snippet: "Travel by train when \u0002remote\u0003 work is not possible.",
              tags: [],
              type: "policy",
              score: 0.5,
            },
          ],
        },
      };
    }
    if (req.path === `/api/v1/pages/${PAGE_ID}`) {
      return {
        json: {
          id: PAGE_ID,
          space: "it",
          spaceName: "IT",
          path: "remote-work",
          title: "Remote work",
          description: "How we work from home",
          status: "active",
          type: null,
          tags: ["work"],
          revision: 3,
          updatedAt: "2026-10-01T10:00:00.000Z",
          body: "Staff work remote two days a week.",
          properties: { owner: "People team" },
          updatedBy: { name: "Ada" },
          breadcrumbs: [],
          backlinks: [],
        },
      };
    }
    if (req.path === `/api/v1/pages/${POLICY_ID}`) {
      return {
        json: {
          id: POLICY_ID,
          space: "policies",
          spaceName: "Policies",
          path: "travel",
          title: "Travel policy",
          description: null,
          status: "active",
          type: "policy",
          tags: [],
          revision: 1,
          updatedAt: "2026-09-01T10:00:00.000Z",
          body: "Travel by train.",
          properties: {},
          updatedBy: null,
          breadcrumbs: [],
          backlinks: [],
        },
      };
    }
    if (req.path === "/api/v1/recent") {
      return {
        json: {
          items: [
            {
              page: { id: PAGE_ID, space: "it", path: "remote-work", title: "Remote work" },
              revision: {
                kind: "save",
                createdAt: new Date().toISOString(),
                message: null,
                author: { name: "Ada" },
              },
            },
          ],
        },
      };
    }
    return { status: 404, json: { error: { code: "not_found", message: "Not found" } } };
  });
  crm = await startFakeApp((req) => {
    if (bearerOf(req) !== "crm_key") return { status: 401, json: {} };
    if (req.path === "/api/v1/search") {
      return {
        json: {
          results: [
            { type: "contact", id: CONTACT_ID, title: "Remy Remote", subtitle: "Example Foundation" },
          ],
        },
      };
    }
    if (req.path === `/api/v1/contacts/${CONTACT_ID}`) {
      return {
        json: {
          id: CONTACT_ID,
          version: 1,
          access: "read",
          name: "Remy Remote",
          email: "remy@example.net",
          jobTitle: "Program officer",
          organizations: [{ id: "o", name: "Example Foundation", role: "Staff" }],
          notes: "Prefers video calls.",
          tags: ["funder"],
          owner: { id: "u", label: "Ada" },
          team: null,
          customFields: {},
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      };
    }
    if (req.path === "/api/v1/activities") {
      return {
        json: {
          items: [
            {
              type: "note",
              title: "Call",
              body: "Talked about remote programs",
              occurredAt: "2026-11-02T00:00:00.000Z",
            },
          ],
        },
      };
    }
    return { status: 404, json: {} };
  });
  slow = await startFakeApp(() => ({ delayMs: 3000, json: { results: [] } }));
});

afterAll(async () => {
  await Promise.all([handbook.close(), crm.close(), slow.close()]);
  delete process.env.SOURCE_TIMEOUT_SECONDS;
  resetConfigForTests();
});

async function setup() {
  const handbookSource = await createSource({
    kind: "handbook",
    slug: "handbook",
    name: "Handbook",
    config: { baseUrl: handbook.url, ruleSpaces: ["policies"], allowLinking: true },
    secret: { serviceToken: "kn_svc_handbook" },
    serviceAccess: true,
  });
  await createSource({
    kind: "crm",
    slug: "crm",
    name: "CRM",
    config: { baseUrl: crm.url, types: ["contact", "organization"] },
    secret: { apiKey: "crm_key" },
    accessGroups: ["/staff/partners"],
  });
  const logbook = await createSource({
    kind: "logbook",
    slug: "logbook",
    name: "Logbook",
    config: { baseUrl: "https://logbook.example.org" },
    secret: { webhookSecret: "a-long-webhook-secret" },
    serviceAccess: true,
  });
  const library = await createSource({
    kind: "library",
    slug: "library",
    name: "Library",
    config: { baseUrl: "https://library.example.org", teamGroupPrefix: "/teams" },
    secret: { webhookSecret: "a-long-webhook-secret" },
    serviceAccess: true,
  });
  await upsertItem(
    getDb(),
    logbook.id,
    logbookItem({
      event: "entry.changed",
      entry: {
        id: "entry-12",
        ref: "LB-12",
        url: "https://logbook.example.org/e/LB-12",
        type: "decision",
        status: "decided",
        title: "Remote work three days a week",
        summary: "Staff may work remote three days a week.",
        details: "We tried two days.",
        rationale: "Fewer commutes.",
        impact: "medium",
        team: "People",
        affected_teams: [],
        tags: ["Ways of working"],
        author: "Ada",
        published_at: "2026-11-10T09:00:00.000Z",
        in_force: true,
        supersedes: "LB-3",
        superseded_by: null,
        decision: {
          result: "adopted",
          text: "Remote work three days a week.",
          reversibility: "two_way",
          how_decided: "integrative_process",
          decider: "Dan",
          decided_on: "2026-11-10",
          decided_at: "2026-11-10T09:00:00.000Z",
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
  await upsertItem(
    getDb(),
    logbook.id,
    logbookItem({
      event: "entry.changed",
      entry: {
        id: "entry-3",
        ref: "LB-3",
        url: "https://logbook.example.org/e/LB-3",
        type: "decision",
        status: "published",
        title: "Remote work two days a week",
        summary: "Two remote days.",
        details: "",
        rationale: "",
        impact: null,
        team: "People",
        affected_teams: [],
        tags: [],
        author: "Ada",
        published_at: "2025-01-10T09:00:00.000Z",
        in_force: false,
        supersedes: null,
        superseded_by: "LB-12",
        decision: {
          result: "recorded",
          text: "Two remote days.",
          reversibility: null,
          how_decided: "decider",
          decider: "Dan",
          decided_on: "2025-01-10",
          decided_at: "2025-01-10T09:00:00.000Z",
          objection_handling: null,
          open_objections: [],
          consent_givers: [],
          involved: [],
          proposal_version: null,
        },
        addenda: [],
      },
    }),
  );
  const note = (id: string, visibility: "all" | "team", title: string) =>
    libraryItem({
      id,
      ref: `LIB-${id}`,
      url: `https://library.example.org/n/${id}`,
      title,
      core: `${title}: remote volunteers stay longer.`,
      key_points: [],
      text: `${title}. Remote volunteers stay longer.`,
      visibility,
      team: visibility === "team" ? { name: "Programs", directory_id: null } : null,
      owner: "Erika",
      document_type: "Study",
      project: null,
      tags: [],
      source_url: null,
      doi: null,
      language: "en",
      checked: true,
      published_at: "2026-11-01T00:00:00.000Z",
      changed_at: "2026-11-01T00:00:00.000Z",
    });
  await upsertItem(getDb(), library.id, note("1", "all", "Volunteer study"));
  await upsertItem(getDb(), library.id, note("2", "team", "Programs team study"));
  return { handbookSource };
}

describe("federated search", () => {
  beforeEach(resetDatabase);

  it("asks every source the person may use and merges by rank, then the source order", async () => {
    await setup();
    const rita = await createUser({ signInGroups: ["/staff"] });
    const response = await request("GET", "/api/v1/search?q=remote", { userId: rita.id });
    expect(response.status).toBe(200);
    // The CRM is open to /staff/partners only; the team note to /teams/Programs only.
    expect(response.body.sources.map((source: { slug: string }) => source.slug)).toEqual([
      "handbook",
      "logbook",
      "library",
    ]);
    // Each source's best first; within a round the stronger source.
    expect(
      response.body.results.map((result: { id: string; authority: string }) => [result.id, result.authority]),
    ).toEqual([
      ["logbook:decision:entry-12", "decision"],
      [`handbook:page:${PAGE_ID}`, "knowledge"],
      ["library:note:1", "library"],
      [`handbook:page:${POLICY_ID}`, "rules"],
      ["logbook:decision:entry-3", "history"],
    ]);
    const decision = response.body.results[0];
    expect(decision).toMatchObject({
      title: "LB-12: Remote work three days a week",
      url: "https://logbook.example.org/e/LB-12",
      status: "in force",
      source: { slug: "logbook", name: "Logbook", kind: "logbook" },
    });
    expect(decision.snippet).toContain("\u0002");
    expect(response.body.results[4].status).toBe("superseded by LB-12");
    // Searches in the web app are not recorded.
    expect(await getDb().select().from(activity)).toHaveLength(0);
  });

  it("opens group-restricted sources and team notes to their groups only", async () => {
    await setup();
    const partner = await createUser({ signInGroups: ["/staff/partners/berlin"] });
    await createGroup("/teams/Programs", [partner.id]);
    const response = await request("GET", "/api/v1/search?q=remote&limit=50", { userId: partner.id });
    const ids = response.body.results.map((result: { id: string }) => result.id);
    expect(ids).toContain(`crm:contact:${CONTACT_ID}`);
    expect(ids).toContain("library:note:2");
    const contact = await request("GET", `/api/v1/items/${encodeURIComponent(`crm:contact:${CONTACT_ID}`)}`, {
      userId: partner.id,
    });
    expect(contact.status).toBe(200);
    expect(contact.body.text).toContain("- **Email:** remy@example.net");
    expect(contact.body.text).toContain("Example Foundation (Staff)");
    expect(contact.body.text).toContain("Talked about remote programs");
    expect(contact.body.url).toBe(`${crm.url}/contacts/${CONTACT_ID}`);

    const rita = await createUser({ signInGroups: ["/staff"] });
    expect(
      (
        await request("GET", `/api/v1/items/${encodeURIComponent(`crm:contact:${CONTACT_ID}`)}`, {
          userId: rita.id,
        })
      ).status,
    ).toBe(404);
    expect((await request("GET", "/api/v1/items/library:note:2", { userId: rita.id })).status).toBe(404);
    expect((await request("GET", "/api/v1/items/library:note:1", { userId: rita.id })).status).toBe(200);
  });

  it("reads items in full, with related decisions resolved", async () => {
    await setup();
    const rita = await createUser();
    const page = await request("GET", `/api/v1/items/${encodeURIComponent(`handbook:page:${PAGE_ID}`)}`, {
      userId: rita.id,
    });
    expect(page.body).toMatchObject({
      title: "Remote work",
      text: "Staff work remote two days a week.",
      date: "2026-10-01T10:00:00.000Z",
      metadata: expect.objectContaining({ space: "IT", owner: "People team", revision: 3 }),
    });
    const decision = await request("GET", "/api/v1/items/logbook:decision:entry-12", { userId: rita.id });
    expect(decision.body.text).toContain("## Decision");
    expect(decision.body.related).toEqual([
      { id: "logbook:decision:entry-3", title: "LB-3: Remote work two days a week", relation: "replaces" },
    ]);
    expect((await request("GET", "/api/v1/items/handbook:page:not-a-uuid", { userId: rita.id })).status).toBe(
      404,
    );
    expect((await request("GET", "/api/v1/items/nothing", { userId: rita.id })).status).toBe(404);
  });

  it("answers 404 or 422, never 500, for IDs and searches no source can hold", async () => {
    await setup();
    const rita = await createUser({ signInGroups: ["/staff"] });
    // A percent sign that is no escape, and half an escape.
    for (const id of ["logbook:decision:%25zz", "logbook:decision:%E0%A4%A", "logbook:decision:%00"]) {
      expect((await request("GET", `/api/v1/items/${id}`, { userId: rita.id })).status).toBe(404);
    }
    // PostgreSQL stores no NUL character: it is refused before a source is asked.
    const search = await request("GET", "/api/v1/search?q=a%00b", { userId: rita.id });
    expect(search.status).toBe(422);
    expect((await request("GET", "/api/v1/people?q=%00", { userId: rita.id })).status).toBe(422);
    const context = await request("POST", "/api/v1/context", {
      userId: rita.id,
      body: { topic: "a\u0000b" },
    });
    expect(context.status).toBe(422);
  });

  it("reports a slow or failing source and still answers", async () => {
    await setup();
    await createSource({
      kind: "handbook",
      slug: "slow",
      name: "Slow handbook",
      config: { baseUrl: slow.url },
      secret: { serviceToken: "x" },
    });
    await createSource({
      kind: "handbook",
      slug: "broken",
      name: "Broken handbook",
      config: { baseUrl: handbook.url },
      secret: { serviceToken: "wrong" },
    });
    const rita = await createUser();
    const started = Date.now();
    const response = await request("GET", "/api/v1/search?q=remote", { userId: rita.id });
    expect(Date.now() - started).toBeLessThan(2900);
    expect(response.body.results.length).toBeGreaterThan(0);
    const outcomes = Object.fromEntries(
      response.body.sources.map((source: { slug: string }) => [source.slug, source]),
    );
    expect(outcomes.slow).toMatchObject({ ok: false, error: "Slow handbook did not answer in time" });
    expect(outcomes.broken).toMatchObject({ ok: false });
    expect(outcomes.broken.error).toContain("refused the credentials");
    expect(outcomes.handbook).toMatchObject({ ok: true, count: 2 });
  });

  it("builds context by the source order, with hints about newer decisions and replaced ones", async () => {
    await setup();
    const rita = await createUser();
    const token = await createToken(rita.id, "Claude");
    const response = await request("POST", "/api/v1/context", { token, body: { topic: "remote work" } });
    expect(response.status).toBe(200);
    expect(response.body.sections.map((section: { authority: string }) => section.authority)).toEqual([
      "rules",
      "decision",
      "knowledge",
      "history",
    ]);
    expect(response.body.notes).toContain(
      "The decision “LB-12: Remote work three days a week” (2026-11-10) is newer than the page “Remote work › Equipment” (last changed 2026-10-01). Where they disagree, the decision wins: say so, and suggest updating the page.",
    );
    expect(response.body.notes.some((note: string) => note.includes("Travel policy"))).toBe(false);
    expect(response.body.notes).toContain(
      "“LB-3: Remote work two days a week” is superseded by LB-12: rely on the newer decision.",
    );
    // Agents are recorded, with the app they use.
    const [entry] = await getDb().select().from(activity);
    expect(entry).toMatchObject({
      action: "context",
      query: "remote work",
      channel: "token",
      client: "Claude",
    });
  });

  it("lists recent changes, newest first", async () => {
    await setup();
    const rita = await createUser();
    const response = await request("GET", "/api/v1/recent?days=90", { userId: rita.id });
    expect(response.body.items[0]).toMatchObject({
      id: `handbook:page:${PAGE_ID}`,
      snippet: "Changed by Ada",
    });
    const dates = response.body.items.map((item: { date: string }) => item.date);
    expect(dates).toEqual([...dates].sort().reverse());
    // The replaced decision of 2025 is older than 90 days.
    expect(response.body.items.map((item: { id: string }) => item.id)).not.toContain(
      "logbook:decision:entry-3",
    );
  });

  it("serves bots through the knowledge API: only sources opened to service tokens, only content for everyone", async () => {
    await setup();
    const bot = await createAdminToken("service", "Support Agent");
    const response = await request("POST", "/api/v1/knowledge/search", {
      token: bot,
      body: { query: "remote", limit: 6 },
    });
    expect(response.status).toBe(200);
    // Bots get each item's text, not only the snippet.
    expect(response.body.results[0]).toMatchObject({
      title: "LB-12: Remote work three days a week",
      section: "Logbook · in force",
    });
    expect(response.body.results[0].text).toContain("## Decision");
    expect(response.body.results).toContainEqual({
      title: "Remote work › Equipment",
      url: `${handbook.url}/s/it/remote-work#equipment`,
      text: "Staff work remote two days a week.",
      section: "Handbook",
    });
    const urls = response.body.results.map((result: { url: string }) => result.url);
    expect(urls).not.toContain("https://library.example.org/n/2");
    expect(urls.some((url: string) => url.startsWith(crm.url))).toBe(false);
    expect(
      response.body.results.find((result: { url: string }) => result.url.endsWith("LB-12")).section,
    ).toBe("Logbook · in force");
    const [entry] = await getDb().select().from(activity);
    expect(entry).toMatchObject({ action: "knowledge", actor: "Support Agent", channel: "service" });
    expect((await request("POST", "/api/v1/knowledge/search", { body: { query: "remote" } })).status).toBe(
      401,
    );
  });
});
