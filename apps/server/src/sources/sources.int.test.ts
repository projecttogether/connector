import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { auditLog, sources } from "../db/schema";
import { decryptJson } from "../core/crypto";
import { bearerOf, startFakeApp, type FakeApp } from "../test/fake-app";
import { createToken, createUser, request, resetDatabase } from "../test/helpers";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

let handbook: FakeApp;

beforeAll(async () => {
  handbook = await startFakeApp((req) => {
    if (bearerOf(req) !== "kn_svc_right")
      return { status: 401, json: { error: { code: "unauthorized", message: "Unknown token" } } };
    if (req.path === "/api/v1/spaces") return { json: { items: [{ slug: "it" }, { slug: "policies" }] } };
    return { status: 404, json: {} };
  });
});
afterAll(() => handbook.close());

describe("sources", () => {
  beforeEach(resetDatabase);

  it("let admins connect, check, change and remove sources; secrets never leave the server", async () => {
    const admin = await createUser({ isAdmin: true });
    const rita = await createUser({ signInGroups: ["/staff"] });
    const body = {
      kind: "handbook",
      slug: "handbook",
      name: "Handbook",
      config: { baseUrl: `${handbook.url}/`, ruleSpaces: ["policies"] },
      secret: { serviceToken: "kn_svc_wrong" },
    };
    expect((await request("POST", "/api/v1/admin/sources", { userId: rita.id, body })).status).toBe(403);
    expect(
      (await request("POST", "/api/v1/admin/sources", { token: await createToken(admin.id), body })).status,
    ).toBe(403);
    const created = await request("POST", "/api/v1/admin/sources", { userId: admin.id, body });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      slug: "handbook",
      kind: "handbook",
      enabled: true,
      accessGroups: [],
      serviceAccess: false,
      config: { baseUrl: handbook.url, ruleSpaces: ["policies"], allowLinking: true },
      secrets: { serviceToken: "…rong" },
      webhookUrl: null,
    });
    expect(JSON.stringify(created.body)).not.toContain("kn_svc_wrong");
    const [row] = await getDb().select().from(sources).where(eq(sources.id, created.body.id));
    expect(row!.secretEncrypted).not.toContain("kn_svc_wrong");
    expect(decryptJson(row!.secretEncrypted)).toEqual({ serviceToken: "kn_svc_wrong" });
    expect((await request("POST", "/api/v1/admin/sources", { userId: admin.id, body })).status).toBe(422);

    const failed = await request("POST", `/api/v1/admin/sources/${created.body.id}/check`, {
      userId: admin.id,
    });
    expect(failed.body).toEqual({ ok: false, message: "Handbook refused the credentials: Unknown token" });

    const changed = await request("PATCH", `/api/v1/admin/sources/${created.body.id}`, {
      userId: admin.id,
      body: { secret: { serviceToken: "kn_svc_right" }, accessGroups: ["/staff"], serviceAccess: true },
    });
    expect(changed.body).toMatchObject({
      secrets: { serviceToken: "…ight" },
      accessGroups: ["/staff"],
      serviceAccess: true,
    });
    const checked = await request("POST", `/api/v1/admin/sources/${created.body.id}/check`, {
      userId: admin.id,
    });
    expect(checked.body).toEqual({ ok: true, message: "Reached Handbook: 2 spaces" });
    // A blank secret keeps the stored one; a bad setting is a field error.
    await request("PATCH", `/api/v1/admin/sources/${created.body.id}`, {
      userId: admin.id,
      body: { secret: { serviceToken: "" } },
    });
    const invalid = await request("PATCH", `/api/v1/admin/sources/${created.body.id}`, {
      userId: admin.id,
      body: { config: { baseUrl: "not a url" } },
    });
    expect(invalid.status).toBe(422);
    expect(Object.keys(invalid.body.error.fields)).toEqual(["config.baseUrl"]);

    const summaries = await request("GET", "/api/v1/sources", { userId: rita.id });
    expect(summaries.body.items).toEqual([
      expect.objectContaining({
        slug: "handbook",
        state: "ok",
        linkable: true,
        linked: false,
        delivery: "live",
      }),
    ]);
    const outsider = await createUser({ signInGroups: ["/guests"] });
    expect((await request("GET", "/api/v1/sources", { userId: outsider.id })).body.items).toEqual([]);

    // Tokens are pasted without line breaks.
    const broken = await request("PATCH", `/api/v1/admin/sources/${created.body.id}`, {
      userId: admin.id,
      body: { secret: { serviceToken: "kn_svc_a\nb" } },
    });
    expect(Object.keys(broken.body.error.fields)).toEqual(["secret.serviceToken"]);
    // Another address: the credentials of the old one are removed.
    const moved = await request("PATCH", `/api/v1/admin/sources/${created.body.id}`, {
      userId: admin.id,
      body: { config: { baseUrl: "https://handbook.example.net", ruleSpaces: [] } },
    });
    expect(moved.body).toMatchObject({ secrets: {}, status: null });
    const [stored] = await getDb().select().from(sources).where(eq(sources.id, created.body.id));
    expect(stored!.secretEncrypted).toBeNull();

    expect(
      (await request("DELETE", `/api/v1/admin/sources/${created.body.id}`, { userId: admin.id })).status,
    ).toBe(204);
    expect((await request("GET", "/api/v1/admin/sources", { userId: admin.id })).body.items).toEqual([]);
    const actions = (await getDb().select().from(auditLog)).map((entry) => entry.action).sort();
    expect(actions).toEqual(["source.create", "source.delete", "source.update", "source.update"]);
  });

  it("generate webhook secrets for webhook sources and show the webhook URL", async () => {
    const admin = await createUser({ isAdmin: true });
    const created = await request("POST", "/api/v1/admin/sources", {
      userId: admin.id,
      body: {
        kind: "logbook",
        slug: "logbook",
        name: "Logbook",
        config: { baseUrl: "https://logbook.example.org" },
      },
    });
    expect(created.body).toMatchObject({
      webhookUrl: "http://localhost:3000/hooks/logbook",
      stats: { items: 0, lastDeliveryAt: null },
      secrets: {},
    });
    const pending = await request("POST", `/api/v1/admin/sources/${created.body.id}/check`, {
      userId: admin.id,
    });
    expect(pending.body.ok).toBe(false);
    const secret = await request("POST", `/api/v1/admin/sources/${created.body.id}/webhook-secret`, {
      userId: admin.id,
    });
    expect(secret.body.webhookSecret).toMatch(/^[\w-]{40,}$/);
    const checked = await request("POST", `/api/v1/admin/sources/${created.body.id}/check`, {
      userId: admin.id,
    });
    expect(checked.body).toEqual({
      ok: true,
      message: "Waiting for the first delivery: enter the webhook's URL and secret in the app",
    });
    const handbook = await request("POST", "/api/v1/admin/sources", {
      userId: admin.id,
      body: { kind: "handbook", slug: "hb", name: "HB", config: { baseUrl: "https://handbook.example.org" } },
    });
    expect(
      (
        await request("POST", `/api/v1/admin/sources/${handbook.body.id}/webhook-secret`, {
          userId: admin.id,
        })
      ).status,
    ).toBe(409);
  });
});
