import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { activity, items, sources } from "../db/schema";
import { putSetting } from "../core/settings";
import { bearerOf, startFakeApp, type FakeApp } from "../test/fake-app";
import { createSource, createToken, createUser, request, resetDatabase } from "../test/helpers";
import { checkLiveSources, checkSource, recordDelivery, sourcesHealth } from "./health";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

let handbook: FakeApp;

beforeAll(async () => {
  handbook = await startFakeApp((req) => {
    if (bearerOf(req) !== "hb_right")
      return { status: 401, json: { error: { code: "unauthorized", message: "Unknown token" } } };
    if (req.path === "/api/v1/spaces")
      return {
        json: {
          items: [
            { slug: "purpose", name: "Purpose and rules" },
            { slug: "it", name: "IT" },
          ],
        },
      };
    if (req.path === "/api/v1/search") return { json: { results: [] } };
    return { status: 404, json: {} };
  });
});
afterAll(() => handbook.close());

const health = () => sourcesHealth(getDb());
/** The state of each source as people (the home page) and agents (`list_sources`) see it. */
const seen = async (who: { userId?: string; token?: string }): Promise<Record<string, string>> =>
  Object.fromEntries(
    (await request("GET", "/api/v1/sources", who)).body.items.map((item: { slug: string; state: string }) => [
      item.slug,
      item.state,
    ]),
  );
const rowOf = async (id: string) => (await getDb().select().from(sources).where(eq(sources.id, id)))[0]!;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

describe("source health", () => {
  beforeEach(resetDatabase);

  it("tells how each source is doing and what needs an admin", async () => {
    const noToken = await createSource({
      kind: "handbook",
      slug: "handbook",
      name: "Handbook",
      config: { baseUrl: handbook.url, ruleSpaces: [], allowLinking: true },
    });
    const crm = await createSource({
      kind: "crm",
      name: "CRM",
      config: { baseUrl: "https://crm.example.org", types: ["contact"] },
      secret: { apiKey: "crm_key" },
    });
    await getDb()
      .update(sources)
      .set({ status: { at: minutesAgo(5).toISOString(), ok: false, message: "CRM refused the credentials" } })
      .where(eq(sources.id, crm.id));
    const logbook = await createSource({
      kind: "logbook",
      name: "Logbook",
      config: { baseUrl: "https://logbook.example.org" },
      secret: { webhookSecret: "a-long-enough-webhook-secret" },
    });
    const library = await createSource({
      kind: "library",
      name: "Library",
      config: { baseUrl: "https://library.example.org", teamGroupPrefix: null },
      secret: { webhookSecret: "a-long-enough-webhook-secret" },
    });
    await getDb()
      .update(sources)
      .set({
        lastDeliveryAt: minutesAgo(10),
        status: { at: minutesAgo(10).toISOString(), ok: true, message: "Received LIB-1" },
      })
      .where(eq(sources.id, library.id));
    for (const externalId of ["n1", "n2"]) {
      await getDb().insert(items).values({
        sourceId: library.id,
        externalId,
        type: "note",
        title: externalId,
        url: "https://library.example.org/n/1",
      });
    }
    const off = await createSource({
      kind: "crm",
      slug: "old-crm",
      name: "Old CRM",
      config: { baseUrl: "https://old.example.org", types: ["contact"] },
      enabled: false,
    });
    const unreadable = await createSource({
      kind: "handbook",
      slug: "wiki",
      name: "Wiki",
      config: { baseUrl: "https://wiki.example.org", ruleSpaces: [], allowLinking: false },
    });
    await getDb()
      .update(sources)
      .set({ secretEncrypted: "not-encrypted" })
      .where(eq(sources.id, unreadable.id));
    const rita = await createUser({ name: "Rita" });
    await getDb()
      .insert(activity)
      .values({
        userId: rita.id,
        actor: "Rita",
        channel: "oauth",
        client: "Claude",
        action: "search",
        query: "trains",
        results: 2,
        sources: [{ slug: "library", ok: true, count: 2 }],
      });

    const body = await health();
    const bySlug = Object.fromEntries(body.sources.map((source) => [source.slug, source]));
    expect(bySlug.handbook).toMatchObject({ state: "setup", delivery: "live" });
    expect(bySlug.crm).toMatchObject({ state: "failing", status: { ok: false } });
    expect(bySlug.logbook).toMatchObject({ state: "waiting", delivery: "webhook", items: 0 });
    expect(bySlug.library).toMatchObject({
      state: "ok",
      items: 2,
      requests: { total: 1, failed: 0, lastError: null },
    });
    expect(bySlug["old-crm"]).toMatchObject({ state: "off" });
    expect(bySlug.wiki).toMatchObject({ state: "setup" });
    // The source order: Handbook first, the Library last.
    expect(body.sources.map((source) => source.kind)).toEqual([
      "handbook",
      "handbook",
      "logbook",
      "crm",
      "crm",
      "library",
    ]);

    const problems = Object.fromEntries(body.problems.map((problem) => [problem.key, problem]));
    expect(problems[`source:${noToken.id}`]).toMatchObject({
      severity: "warning",
      title: "Handbook has no service token",
      area: "source",
      sourceId: noToken.id,
    });
    expect(problems[`source:${crm.id}`]).toMatchObject({
      severity: "error",
      title: "CRM is failing",
      detail: "CRM refused the credentials",
    });
    expect(problems[`source:${logbook.id}`]).toMatchObject({
      severity: "warning",
      title: "Waiting for the first delivery from Logbook",
    });
    expect(problems[`source:${unreadable.id}`]).toMatchObject({
      severity: "error",
      title: "Connector cannot read the credentials of Wiki",
    });
    expect(problems[`source:${library.id}`]).toBeUndefined();
    expect(problems[`source:${off.id}`]).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("crm_key");
    expect(JSON.stringify(body)).not.toContain("a-long-enough-webhook-secret");

    // People and agents see the same state of every source they may use.
    expect(await seen({ userId: rita.id })).toEqual({
      handbook: "setup",
      wiki: "setup",
      logbook: "waiting",
      crm: "failing",
      library: "ok",
    });
  });

  it("records deliveries and refused deliveries in the database's time", async () => {
    const logbook = await createSource({
      kind: "logbook",
      name: "Logbook",
      config: { baseUrl: "https://logbook.example.org" },
      secret: { webhookSecret: "a-long-enough-webhook-secret" },
    });
    const library = await createSource({
      kind: "library",
      name: "Library",
      config: { baseUrl: "https://library.example.org", teamGroupPrefix: null },
      secret: { webhookSecret: "a-long-enough-webhook-secret" },
    });

    await recordDelivery(getDb(), logbook, { ok: false, refused: "signature" });
    let row = await rowOf(logbook.id);
    expect(row.status).toMatchObject({
      ok: false,
      message: "A delivery had a wrong signature: check that both sides use the same secret",
    });
    expect(row.lastDeliveryAt).toBeNull();
    expect((await health()).sources[0]).toMatchObject({ slug: logbook.slug, state: "failing" });

    await recordDelivery(getDb(), logbook, { ok: true, message: "Received LB-12" });
    row = await rowOf(logbook.id);
    expect(row.status).toMatchObject({ ok: true, message: "Received LB-12" });
    expect(row.lastDeliveryAt).not.toBeNull();
    // One clock: the status carries the database's time of the delivery.
    expect(Math.abs(Date.parse(row.status!.at) - row.lastDeliveryAt!.getTime())).toBeLessThan(1000);
    expect((await health()).sources[0]).toMatchObject({ slug: logbook.slug, state: "ok" });

    await recordDelivery(getDb(), logbook, { ok: false, refused: "payload" });
    expect((await rowOf(logbook.id)).status).toMatchObject({
      ok: false,
      message: "A delivery did not look like a Logbook entry",
    });
    await recordDelivery(getDb(), library, { ok: false, refused: "payload" });
    expect((await rowOf(library.id)).status).toMatchObject({
      ok: false,
      message: "A delivery did not look like a Library note",
    });
  });

  it("notices a source that fails an agent's fetch", async () => {
    const rita = await createUser({ name: "Rita" });
    await createSource({
      kind: "handbook",
      config: { baseUrl: handbook.url, ruleSpaces: [], allowLinking: false },
      secret: { serviceToken: "hb_wrong" },
    });
    const id = encodeURIComponent("handbook:page:0b7c1f2e-8a4d-4c3b-9e5f-1a2b3c4d5e6f");
    const fetched = await request("GET", `/api/v1/items/${id}`, { token: await createToken(rita.id) });
    expect(fetched.status).toBe(502);
    const [logged] = await getDb().select().from(activity);
    expect(logged).toMatchObject({
      action: "fetch",
      results: 0,
      sources: [{ slug: "handbook", ok: false, count: 0, error: "Handbook refused the credentials" }],
    });
    expect((await health()).sources[0]).toMatchObject({
      state: "failing",
      requests: { total: 1, failed: 1, lastError: { message: "Handbook refused the credentials" } },
    });
  });

  it("logs a failed proposal without counting it against the source", async () => {
    const rita = await createUser({ name: "Rita" });
    await createSource({
      kind: "handbook",
      config: { baseUrl: handbook.url, ruleSpaces: [], allowLinking: false },
      secret: { serviceToken: "hb_right" },
    });
    // Rita has no linked account: the proposal fails before Handbook is asked.
    const proposal = {
      title: "New page",
      description: "The VPN has no page yet",
      newPage: { space: "it", path: "vpn", title: "VPN", body: "How to connect" },
    };
    const proposed = await request("POST", "/api/v1/proposals", {
      token: await createToken(rita.id),
      body: proposal,
    });
    expect(proposed.status).toBe(409);
    const [logged] = await getDb().select().from(activity);
    expect(logged).toMatchObject({
      action: "propose",
      results: 0,
      sources: [
        {
          slug: "handbook",
          ok: false,
          error:
            "Link your Handbook account first: open Connector, Settings → Linked accounts (the agent proposes as you)",
        },
      ],
    });
    expect((await health()).sources[0]).toMatchObject({ state: "unchecked", requests: { total: 0 } });
  });

  it("notices sources that fail agents' requests, until a request works again", async () => {
    const admin = await createUser({ isAdmin: true });
    const rita = await createUser({ name: "Rita" });
    const source = await createSource({
      kind: "handbook",
      config: { baseUrl: handbook.url, ruleSpaces: [], allowLinking: false },
      secret: { serviceToken: "hb_wrong" },
    });
    const token = await createToken(rita.id);
    expect((await request("GET", "/api/v1/search?q=vpn", { token })).status).toBe(200);
    const [logged] = await getDb().select().from(activity);
    expect(logged!.sources).toEqual([
      // Connector's words only: the app's own error text is not kept.
      { slug: "handbook", ok: false, count: 0, error: "Handbook refused the credentials" },
    ]);

    let body = await health();
    expect(body.sources[0]).toMatchObject({
      state: "failing",
      requests: {
        total: 1,
        failed: 1,
        lastError: { message: "Handbook refused the credentials" },
      },
    });
    expect(body.problems[0]).toMatchObject({
      key: `source:${source.id}`,
      severity: "error",
      title: "handbook failed its latest requests",
    });
    // People and agents see what admins see.
    expect(await seen({ token })).toEqual({ handbook: "failing" });

    // The admin fixes the token. A working check alone does not clear it (it may
    // test another path); the next request that works does.
    await request("PATCH", `/api/v1/admin/sources/${source.id}`, {
      userId: admin.id,
      body: { secret: { serviceToken: "hb_right" } },
    });
    expect(await checkSource(getDb(), source.id)).toMatchObject({ ok: true });
    expect((await health()).sources[0]).toMatchObject({ state: "failing" });
    expect(await seen({ token })).toEqual({ handbook: "failing" });
    expect((await request("GET", "/api/v1/search?q=vpn", { token })).status).toBe(200);
    body = await health();
    expect(body.sources[0]).toMatchObject({ state: "ok", requests: { total: 2, failed: 1 } });
    expect(await seen({ token })).toEqual({ handbook: "ok" });
    expect(body.problems.find((problem) => problem.key === `source:${source.id}`)).toBeUndefined();

    // A new source with the same short name starts without the old one's requests.
    await getDb()
      .update(activity)
      .set({ sources: [{ slug: "handbook", ok: false, count: 0 }] });
    await request("DELETE", `/api/v1/admin/sources/${source.id}`, { userId: admin.id });
    await createSource({
      kind: "handbook",
      config: { baseUrl: handbook.url, ruleSpaces: [], allowLinking: false },
      secret: { serviceToken: "hb_right" },
    });
    body = await health();
    expect(body.sources[0]).toMatchObject({ state: "unchecked", requests: { total: 0, failed: 0 } });
  });

  it("the worker checks live sources and leaves webhook sources alone", async () => {
    const good = await createSource({
      kind: "handbook",
      config: { baseUrl: handbook.url, ruleSpaces: ["purpose"], allowLinking: true },
      secret: { serviceToken: "hb_right" },
    });
    const bad = await createSource({
      kind: "handbook",
      slug: "other",
      config: { baseUrl: handbook.url, ruleSpaces: [], allowLinking: true },
      secret: { serviceToken: "hb_revoked" },
    });
    const logbook = await createSource({
      kind: "logbook",
      config: { baseUrl: "https://logbook.example.org" },
    });
    expect(await checkLiveSources(getDb())).toBe(2);
    const rows = Object.fromEntries((await getDb().select().from(sources)).map((row) => [row.id, row]));
    expect(rows[good.id]!.status).toMatchObject({ ok: true, message: "Reached Handbook: 2 spaces" });
    expect(rows[bad.id]!.status).toMatchObject({
      ok: false,
      message: "Handbook refused the credentials: Unknown token",
    });
    expect(rows[logbook.id]!.status).toBeNull();
    const body = await health();
    expect(body.sourceChecks).toMatchObject({ minutes: 15 });
    expect(Date.now() - Date.parse(body.sourceChecks.lastRunAt!)).toBeLessThan(60_000);
    expect(body.problems.find((problem) => problem.key === "worker")).toBeUndefined();

    // Checks that stopped long ago point at the worker.
    await putSetting(getDb(), "source_checks", { at: minutesAgo(120).toISOString() });
    expect((await health()).problems.find((problem) => problem.key === "worker")).toMatchObject({
      title: "The worker seems to be stopped",
    });
  });
});
