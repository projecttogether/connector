import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { items, sources } from "../db/schema";
import { testApp, createGroup, createSource, createUser, request, resetDatabase } from "../test/helpers";
import { signatureOf } from "./webhooks";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

const SECRET = "library-and-logbook-secret";

async function deliver(
  slug: string,
  payload: unknown,
  options: { app: "Logbook" | "Library"; secret?: string; at?: number },
) {
  const body = JSON.stringify(payload);
  const timestamp = String(options.at ?? Math.floor(Date.now() / 1000));
  const response = await testApp().request(`/hooks/${slug}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [`${options.app}-Timestamp`]: timestamp,
      [`${options.app}-Signature`]: signatureOf(options.secret ?? SECRET, timestamp, body),
      [`${options.app}-Delivery`]: crypto.randomUUID(),
    },
    body,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const entry = (overrides: Record<string, unknown> = {}) => ({
  event: "entry.changed",
  entry: {
    id: "0196f1e2-0000-7000-8000-000000000012",
    ref: "LB-12",
    url: "https://logbook.example.org/e/LB-12",
    type: "update",
    status: "published",
    title: "New office opening hours",
    summary: "The office opens at eight.",
    details: "Starting in December.",
    rationale: "",
    impact: "low",
    team: "Operations",
    affected_teams: ["Everyone"],
    tags: ["Office"],
    author: "Olga",
    published_at: "2026-11-15T09:00:00.000Z",
    in_force: true,
    supersedes: null,
    superseded_by: null,
    decision: null,
    addenda: [],
    ...overrides,
  },
});

const note = (visibility: "all" | "team", team: { name: string; directory_id: string | null } | null) => ({
  event: "note.changed",
  note: {
    id: "0196f1e2-0000-7000-8000-000000000003",
    ref: "LIB-3",
    url: "https://library.example.org/n/3",
    title: "Keeping Volunteers",
    core: "Most volunteers who leave do so in their first six months.",
    key_points: ["Survey of 412 organizations"],
    quotes: [],
    citation: "Example Institute (2026).",
    language: "en",
    text: "Most volunteers who leave do so in their first six months.\n\nSummary drafted by an AI model and confirmed by Erika Example.",
    visibility,
    team,
    owner: "Erika Example",
    document_type: "Study",
    project: null,
    tags: ["Volunteering"],
    source_url: null,
    doi: "10.1234/example",
    checked: false,
    ai_drafted: true,
    published_at: "2026-11-04T09:00:00.000Z",
    changed_at: "2026-11-06T14:30:00.000Z",
  },
});

describe("webhooks", () => {
  beforeEach(resetDatabase);

  it("store Logbook entries with a valid signature and refuse everything else", async () => {
    const logbook = await createSource({
      kind: "logbook",
      config: { baseUrl: "https://logbook.example.org" },
      secret: { webhookSecret: SECRET },
    });
    expect(
      (await deliver("logbook", entry(), { app: "Logbook", secret: "a-wrong-secret-value" })).status,
    ).toBe(401);
    expect(
      (await deliver("logbook", entry(), { app: "Logbook", at: Math.floor(Date.now() / 1000) - 600 })).status,
    ).toBe(401);
    const [failed] = await getDb().select().from(sources).where(eq(sources.id, logbook.id));
    expect(failed!.status).toMatchObject({ ok: false });
    expect(
      (await deliver("logbook", { event: "entry.changed", entry: { id: "x" } }, { app: "Logbook" })).status,
    ).toBe(400);
    expect((await deliver("nothing", entry(), { app: "Logbook" })).status).toBe(404);

    expect((await deliver("logbook", entry(), { app: "Logbook" })).body).toEqual({
      ok: true,
      message: "Stored LB-12",
    });
    // A repeated delivery replaces the item.
    await deliver(
      "logbook",
      entry({
        title: "New opening hours",
        addenda: [{ text: "Also on Saturdays.", author: "Olga", created_at: "2026-11-18T10:00:00.000Z" }],
      }),
      { app: "Logbook" },
    );
    const stored = await getDb().select().from(items).where(eq(items.sourceId, logbook.id));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      type: "update",
      ref: "LB-12",
      title: "New opening hours",
      visibility: "all",
      inForce: null,
    });
    expect(stored[0]!.body).toContain("## Addenda");
    expect(stored[0]!.changedAt?.toISOString()).toBe("2026-11-18T10:00:00.000Z");
    const [delivered] = await getDb().select().from(sources).where(eq(sources.id, logbook.id));
    expect(delivered!.status).toMatchObject({ ok: true, message: "Received LB-12" });
    expect(delivered!.lastDeliveryAt).not.toBeNull();

    const rita = await createUser();
    const found = await request("GET", "/api/v1/search?q=opening%20hours", { userId: rita.id });
    expect(found.body.results.map((result: { title: string }) => result.title)).toEqual([
      "LB-12: New opening hours",
    ]);
    expect((await request("GET", "/api/v1/search?q=lb-12", { userId: rita.id })).body.results).toHaveLength(
      1,
    );
  });

  it("accept the old Logbuch header names", async () => {
    await createSource({
      kind: "logbook",
      config: { baseUrl: "https://logbook.example.org" },
      secret: { webhookSecret: SECRET },
    });
    const body = JSON.stringify(entry());
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await testApp().request("/hooks/logbook", {
      method: "POST",
      headers: { "Logbuch-Timestamp": timestamp, "Logbuch-Signature": signatureOf(SECRET, timestamp, body) },
      body,
    });
    expect(response.status).toBe(200);
  });

  it("store Library notes, show team notes to the team only, and remove notes", async () => {
    const library = await createSource({
      kind: "library",
      config: { baseUrl: "https://library.example.org", teamGroupPrefix: "/teams" },
      secret: { webhookSecret: SECRET },
    });
    expect(
      (
        await deliver("library", note("team", { name: "Programs", directory_id: "kc-programs" }), {
          app: "Library",
        })
      ).status,
    ).toBe(200);
    const [stored] = await getDb().select().from(items).where(eq(items.sourceId, library.id));
    expect(stored).toMatchObject({
      visibility: "groups",
      visibilityGroups: ["kc:kc-programs", "team:Programs"],
      status: "confirmed by its owner",
    });

    const outsider = await createUser({ signInGroups: ["/staff"] });
    const byName = await createUser({ signInGroups: ["/teams/Programs"] });
    const byId = await createUser();
    await createGroup("/programs-team", [byId.id], { source: "keycloak", externalId: "kc-programs" });
    const search = async (userId: string) =>
      (await request("GET", "/api/v1/search?q=volunteers", { userId })).body.results.map(
        (result: { id: string }) => result.id,
      );
    expect(await search(outsider.id)).toEqual([]);
    // A SCIM group with the same external ID is not the Keycloak group.
    await createGroup("Lookalike", [outsider.id], { source: "scim", externalId: "kc-programs" });
    expect(await search(outsider.id)).toEqual([]);
    expect(await search(byName.id)).toEqual([`library:note:${stored!.externalId}`]);
    expect(await search(byId.id)).toEqual([`library:note:${stored!.externalId}`]);

    // The prefix counts as set now: without it, only the Keycloak group ID admits.
    await getDb()
      .update(sources)
      .set({ config: { baseUrl: "https://library.example.org", teamGroupPrefix: null } })
      .where(eq(sources.id, library.id));
    expect(await search(byName.id)).toEqual([]);
    expect(await search(byId.id)).toEqual([`library:note:${stored!.externalId}`]);

    // Now for everyone.
    await deliver("library", note("all", null), { app: "Library" });
    expect(await search(outsider.id)).toHaveLength(1);
    const item = await request("GET", `/api/v1/items/library:note:${stored!.externalId}`, {
      userId: outsider.id,
    });
    expect(item.body.metadata).toMatchObject({
      owner: "Erika Example",
      documentType: "Study",
      doi: "10.1234/example",
      aiDrafted: true,
    });

    expect(
      (
        await deliver(
          "library",
          { event: "note.removed", note: { id: stored!.externalId } },
          { app: "Library" },
        )
      ).body,
    ).toEqual({ ok: true, message: "Removed" });
    expect(await search(outsider.id)).toEqual([]);
    // A removal of an unknown note is fine.
    expect(
      (await deliver("library", { event: "note.removed", note: { id: "unknown" } }, { app: "Library" }))
        .status,
    ).toBe(200);
  });

  it("refuse deliveries while the source has no secret", async () => {
    await createSource({ kind: "library", config: { baseUrl: "https://library.example.org" } });
    expect((await deliver("library", note("all", null), { app: "Library" })).status).toBe(503);
  });
});
