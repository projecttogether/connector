import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { AdminStatus } from "@connector/shared/api/status";
import { getDb } from "../db/client";
import { activity, credentials, oauthClients, oauthGrants, sources } from "../db/schema";
import { putSetting } from "../core/settings";
import { bearerOf, startFakeApp, type FakeApp } from "../test/fake-app";
import {
  createAdminToken,
  createSource,
  createToken,
  createUser,
  request,
  resetDatabase,
} from "../test/helpers";

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

async function status(adminId: string): Promise<AdminStatus> {
  const response = await request("GET", "/api/v1/admin/status", { userId: adminId });
  expect(response.status).toBe(200);
  return response.body as AdminStatus;
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

describe("admin status", () => {
  beforeEach(resetDatabase);

  it("is for admins only", async () => {
    const admin = await createUser({ isAdmin: true });
    const rita = await createUser();
    expect((await request("GET", "/api/v1/admin/status", { userId: rita.id })).status).toBe(403);
    expect(
      (await request("GET", "/api/v1/admin/status", { token: await createToken(admin.id) })).status,
    ).toBe(403);
    expect((await request("GET", "/api/v1/admin/status", { userId: admin.id })).status).toBe(200);
  });

  it("brings the sources, the directory, SCIM, tokens and agents together, errors first", async () => {
    const admin = await createUser({ isAdmin: true });
    // Source health (sources/health.int.test.ts) reaches the page: a failing CRM and a Logbook that waits.
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

    // People whose address clashed, tokens that end, and a failed SCIM request.
    await createUser({ email: "conflict-1@conflict.invalid" });
    await createAdminToken("service", "Support Agent");
    await getDb()
      .update(credentials)
      .set({ expiresAt: new Date(Date.now() + 5 * 86_400_000) })
      .where(eq(credentials.name, "Support Agent"));
    await createAdminToken("scim", "Old IAM token");
    await getDb()
      .update(credentials)
      .set({ revokedAt: minutesAgo(60), lastRejectedAt: minutesAgo(2) })
      .where(eq(credentials.name, "Old IAM token"));
    await putSetting(getDb(), "scim.last_error", {
      at: minutesAgo(3).toISOString(),
      ok: false,
      message: "PATCH /Groups failed (HTTP 400): A member is not a known user",
    });

    // Agents: two people connected Claude; one used a token this week, once with a failure.
    const rita = await createUser({ name: "Rita" });
    const [client] = await getDb()
      .insert(oauthClients)
      .values({
        clientId: "claude",
        registration: "dynamic",
        name: "Claude",
        redirectUris: ["https://claude.ai/cb"],
      })
      .returning();
    for (const userId of [admin.id, rita.id]) {
      await getDb()
        .insert(oauthGrants)
        .values({
          clientId: client!.id,
          userId,
          redirectUri: "https://claude.ai/cb",
          lastUsedAt: minutesAgo(1),
        });
    }
    await createToken(rita.id);
    for (const ok of [true, false]) {
      await getDb()
        .insert(activity)
        .values({
          userId: rita.id,
          actor: "Rita",
          channel: "oauth",
          client: "Claude",
          action: "search",
          query: "trains",
          results: ok ? 2 : 0,
          sources: [{ slug: "library", ok, count: ok ? 2 : 0 }],
        });
    }

    const body = await status(admin.id);
    expect(body.sources.map((source) => [source.slug, source.state])).toEqual([
      ["logbook", "waiting"],
      ["crm", "failing"],
    ]);
    const problems = Object.fromEntries(body.problems.map((problem) => [problem.key, problem]));
    expect(problems[`source:${crm.id}`]).toMatchObject({ severity: "error", title: "CRM is failing" });
    expect(problems[`source:${logbook.id}`]).toMatchObject({ severity: "warning", area: "source" });
    expect(problems["people:conflicts"]).toMatchObject({ area: "people", severity: "warning" });
    expect(Object.values(problems).find((p) => p.title.includes("Support Agent"))).toMatchObject({
      severity: "warning",
      title: "The service token “Support Agent” expires soon",
      area: "service-tokens",
    });
    expect(Object.values(problems).find((p) => p.title.includes("Old IAM token"))).toMatchObject({
      severity: "error",
      title: "Something still uses the SCIM token “Old IAM token”",
      area: "scim",
    });
    expect(problems.scim).toMatchObject({
      detail: "PATCH /Groups failed (HTTP 400): A member is not a known user",
    });
    // Errors come first.
    const severities = body.problems.map((problem) => problem.severity);
    expect(severities).toEqual([...severities].sort());

    expect(body.sourceChecks).toMatchObject({ minutes: 15 });
    expect(body.scim).toMatchObject({ tokens: 0, lastError: { ok: false } });
    expect(body.agents).toMatchObject({
      apps: [{ name: "Claude", people: 2 }],
      personalTokens: 1,
      serviceTokens: 1,
      week: { requests: 2, failed: 1, people: 1, bots: 0 },
    });
    expect(body.directory).toMatchObject({ mode: "oidc", people: 3, groups: 0 });
    expect(JSON.stringify(body)).not.toContain("crm_key");
    expect(JSON.stringify(body)).not.toContain("a-long-enough-webhook-secret");
  });

  it("lists Handbook's spaces for choosing the rule spaces", async () => {
    const admin = await createUser({ isAdmin: true });
    const source = await createSource({
      kind: "handbook",
      config: { baseUrl: handbook.url, ruleSpaces: [], allowLinking: true },
      secret: { serviceToken: "hb_right" },
    });
    const spaces = await request("GET", `/api/v1/admin/sources/${source.id}/spaces`, { userId: admin.id });
    expect(spaces.body).toEqual({
      items: [
        { slug: "purpose", name: "Purpose and rules" },
        { slug: "it", name: "IT" },
      ],
    });
    const rita = await createUser();
    expect(
      (await request("GET", `/api/v1/admin/sources/${source.id}/spaces`, { userId: rita.id })).status,
    ).toBe(403);
    await request("PATCH", `/api/v1/admin/sources/${source.id}`, {
      userId: admin.id,
      body: { secret: { serviceToken: "hb_wrong" } },
    });
    const refused = await request("GET", `/api/v1/admin/sources/${source.id}/spaces`, { userId: admin.id });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe("Handbook refused the credentials: Unknown token");
    const logbook = await createSource({
      kind: "logbook",
      config: { baseUrl: "https://logbook.example.org" },
    });
    expect(
      (await request("GET", `/api/v1/admin/sources/${logbook.id}/spaces`, { userId: admin.id })).status,
    ).toBe(409);
  });

  it("records how SCIM requests went, without IDs or filter values", async () => {
    const admin = await createUser({ isAdmin: true });
    const token = await createAdminToken("scim", "IAM");
    await request("GET", `/scim/v2/Users?filter=${encodeURIComponent('userName eq "rita@example.org"')}`, {
      token,
    });
    let body = await status(admin.id);
    expect(body.scim).toMatchObject({
      tokens: 1,
      lastRequest: { ok: true, message: "GET /Users" },
      lastError: null,
    });
    expect(body.scim.lastUsedAt).not.toBeNull();

    // A lookup of a missing person is normal; a failed change is not.
    await request("GET", "/scim/v2/Users/0b5a3e5e-3c1f-4d8e-9f3a-000000000000", { token });
    expect((await status(admin.id)).scim.lastError).toBeNull();
    await request("GET", `/scim/v2/Users?filter=${encodeURIComponent('nickName co "rita@example.org"')}`, {
      token,
    });
    body = await status(admin.id);
    expect(body.scim.lastError).toMatchObject({
      ok: false,
      message: "GET /Users failed (HTTP 400): the filter is not supported",
    });
    expect(JSON.stringify(body)).not.toContain("rita@example.org");
    // Unknown paths are not stored as sent.
    await request("POST", "/scim/v2/rita@example.org", { token, body: {} });
    body = await status(admin.id);
    expect(body.scim.lastError).toMatchObject({ message: "POST another path failed (HTTP 404)" });
    expect(JSON.stringify(body)).not.toContain("rita@example.org");
    await request("PATCH", "/scim/v2/Users/0b5a3e5e-3c1f-4d8e-9f3a-000000000000", {
      token,
      body: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", value: { active: false } }],
      },
    });
    body = await status(admin.id);
    expect(body.scim.lastError).toMatchObject({
      message: "PATCH /Users failed (HTTP 404): no such person or group",
    });
    expect(body.scim.lastRequest).toMatchObject({ ok: false });
    expect(body.problems.find((problem) => problem.key === "scim")).toMatchObject({
      area: "scim",
      detail: "PATCH /Users failed (HTTP 404): no such person or group",
    });
  });

  it("notices revoked service and SCIM tokens that are still sent", async () => {
    const admin = await createUser({ isAdmin: true });
    const scim = await createAdminToken("scim", "IAM");
    const bot = await createAdminToken("service", "Support Agent");
    // An unknown token with the right prefix changes nothing.
    expect((await request("GET", "/scim/v2/Users", { token: "cn_scim_unknown" })).status).toBe(401);
    expect((await status(admin.id)).problems).toEqual([]);

    await getDb().update(credentials).set({ revokedAt: new Date() });
    expect((await request("GET", "/scim/v2/Users", { token: scim })).status).toBe(401);
    expect(
      (await request("POST", "/api/v1/knowledge/search", { token: bot, body: { query: "vpn" } })).status,
    ).toBe(401);
    const rejected = await getDb()
      .select({ name: credentials.name, at: credentials.lastRejectedAt })
      .from(credentials);
    expect(rejected.every((row) => row.at !== null)).toBe(true);
    const titles = (await status(admin.id)).problems.map((problem) => problem.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        "Something still uses the SCIM token “IAM”",
        "Something still uses the service token “Support Agent”",
      ]),
    );
  });
});
