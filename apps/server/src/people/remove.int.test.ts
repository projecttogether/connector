import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { REMOVED_PERSON_NAME } from "@connector/shared/api/users";
import { getDb } from "../db/client";
import {
  accounts,
  auditLog,
  credentials,
  groupMembers,
  oauthClients,
  oauthGrants,
  oauthRequests,
  sessions,
  sourceLinks,
  users,
} from "../db/schema";
import { issueCredential } from "../auth/credentials";
import { encryptJson } from "../core/crypto";
import { createGroup, createSource, createToken, createUser, request, resetDatabase } from "../test/helpers";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

const RITA = "rita@example.org";

/** Everything a person leaves behind: sign-ins, tokens, a connected app, a linked account, groups, history. */
async function setup() {
  const admin = await createUser({ isAdmin: true, email: "ada@example.org" });
  const rita = await createUser({ email: RITA, name: "Rita Reader", signInGroups: ["/staff"] });
  const db = getDb();
  await db.insert(sessions).values({ userId: rita.id, token: "t", expiresAt: new Date(Date.now() + 60_000) });
  await db.insert(accounts).values({ userId: rita.id, providerId: "oidc", accountId: "kc-rita" });
  const token = await createToken(rita.id);
  const [client] = await db
    .insert(oauthClients)
    .values({
      clientId: "app",
      registration: "dynamic",
      name: "Agent",
      redirectUris: ["https://example.org/cb"],
    })
    .returning();
  const [grant] = await db
    .insert(oauthGrants)
    .values({ clientId: client!.id, userId: rita.id, redirectUri: "https://example.org/cb" })
    .returning();
  const app = await issueCredential(db, {
    kind: "oauth_access",
    name: "Agent",
    userId: rita.id,
    grantId: grant!.id,
    expiresAt: null,
  });
  await db.insert(oauthRequests).values({
    clientId: client!.id,
    redirectUri: "https://example.org/cb",
    codeChallenge: "challenge",
    userId: rita.id,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const source = await createSource({
    kind: "handbook",
    config: { baseUrl: "https://handbook.example.org" },
  });
  await db.insert(sourceLinks).values({
    sourceId: source.id,
    userId: rita.id,
    tokensEncrypted: encryptJson({ accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 60_000 }),
  });
  await createGroup("Programs", [rita.id]);
  await request("PATCH", `/api/v1/admin/people/${rita.id}`, { userId: admin.id, body: { isAdmin: true } });
  return { admin, rita, token, appToken: app.secret };
}

describe("removing a person", () => {
  beforeEach(resetDatabase);

  it("keeps the logs under a placeholder and deletes everything else", async () => {
    const { admin, rita, token, appToken } = await setup();

    expect((await request("DELETE", `/api/v1/admin/people/${rita.id}`, { userId: admin.id })).status).toBe(
      204,
    );

    const [row] = await getDb().select().from(users).where(eq(users.id, rita.id));
    expect(row).toMatchObject({
      email: `removed-${rita.id}@removed.invalid`,
      name: REMOVED_PERSON_NAME,
      isAdmin: false,
      adminSource: null,
      lastSignInAt: null,
      signInGroups: [],
    });
    expect(row!.blockedAt).not.toBeNull();
    for (const [table, column] of [
      [sessions, sessions.userId],
      [accounts, accounts.userId],
      [credentials, credentials.userId],
      [oauthGrants, oauthGrants.userId],
      [oauthRequests, oauthRequests.userId],
      [sourceLinks, sourceLinks.userId],
      [groupMembers, groupMembers.userId],
    ] as const) {
      expect(await getDb().select().from(table).where(eq(column, rita.id))).toHaveLength(0);
    }
    expect((await request("GET", "/api/v1/me", { token })).status).toBe(401);
    expect((await request("GET", "/api/v1/me", { token: appToken })).status).toBe(401);

    const entries = await getDb().select().from(auditLog);
    expect(entries.some((entry) => entry.summary.includes(RITA))).toBe(false);
    expect(entries.map((entry) => entry.summary)).toContain("Removed a person");
    expect((await request("GET", "/api/v1/admin/people", { userId: admin.id })).body.items).toHaveLength(1);
  });

  it("keeps the person's activity without their name, email or token names", async () => {
    const LOOKALIKES = "marita@example.org Margarita Reader";
    const admin = await createUser({ isAdmin: true, email: "ada@example.org" });
    const rita = await createUser({ email: RITA, name: "Rita Reader" });
    const ben = await createUser({ email: "ben@example.org", name: "Ben Baker" });
    const ritasToken = await createToken(rita.id, "Rita's laptop");
    const bensToken = await createToken(ben.id, "Ben's agent");
    // Rita's agent asks; then, without a name, the log names her by her email.
    expect((await request("GET", "/api/v1/people?q=budget", { token: ritasToken })).status).toBe(200);
    await getDb().update(users).set({ name: "" }).where(eq(users.id, rita.id));
    expect((await request("GET", "/api/v1/people?q=travel", { token: ritasToken })).status).toBe(200);
    await getDb().update(users).set({ name: "Rita Reader" }).where(eq(users.id, rita.id));
    // Someone else's agent looks her up by her address and her name, and looks up others who only look alike.
    for (const q of ["Rita@Example.org", "rita reader budget", LOOKALIKES]) {
      const asked = await request("GET", `/api/v1/people?q=${encodeURIComponent(q)}`, { token: bensToken });
      expect(asked.status).toBe(200);
    }

    expect((await request("DELETE", `/api/v1/admin/people/${rita.id}`, { userId: admin.id })).status).toBe(
      204,
    );

    const log = (await request("GET", "/api/v1/admin/activity", { userId: admin.id })).body;
    expect(log.total).toBe(5);
    const others = log.items.filter((entry: { query: string | null }) => entry.query !== LOOKALIKES);
    expect(JSON.stringify(others)).not.toMatch(/rita/i);
    expect(
      log.items.map((entry: { actor: string; client: string | null; query: string | null }) => [
        entry.actor,
        entry.client,
        entry.query,
      ]),
    ).toEqual([
      ["Ben Baker", "Ben's agent", LOOKALIKES],
      ["Ben Baker", "Ben's agent", "a removed person budget"],
      ["Ben Baker", "Ben's agent", "a removed person"],
      [REMOVED_PERSON_NAME, null, "travel"],
      [REMOVED_PERSON_NAME, null, "budget"],
    ]);
  });

  it("leaves others' search words alone when the person has a one-word name", async () => {
    const admin = await createUser({ isAdmin: true, email: "ada@example.org" });
    const max = await createUser({ email: "max@example.org", name: "Max" });
    const ben = await createUser({ email: "ben@example.org", name: "Ben Baker" });
    const bensToken = await createToken(ben.id, "Ben's agent");
    // "Max" is also an everyday word; only Max's address names him for sure.
    for (const q of ["max travel budget", "max@example.org"]) {
      expect(
        (await request("GET", `/api/v1/people?q=${encodeURIComponent(q)}`, { token: bensToken })).status,
      ).toBe(200);
    }

    expect((await request("DELETE", `/api/v1/admin/people/${max.id}`, { userId: admin.id })).status).toBe(
      204,
    );

    const log = (await request("GET", "/api/v1/admin/activity", { userId: admin.id })).body;
    expect(log.items.map((entry: { query: string | null }) => entry.query)).toEqual([
      "a removed person",
      "max travel budget",
    ]);
  });

  it("refuses to remove oneself or people from ADMIN_EMAILS", async () => {
    const admin = await createUser({ isAdmin: true, email: "ada@example.org" });
    const root = await createUser({ email: "root@example.org", isAdmin: true });
    await getDb().update(users).set({ adminSource: "environment" }).where(eq(users.id, root.id));
    expect((await request("DELETE", `/api/v1/admin/people/${admin.id}`, { userId: admin.id })).status).toBe(
      409,
    );
    expect((await request("DELETE", `/api/v1/admin/people/${root.id}`, { userId: admin.id })).status).toBe(
      409,
    );
  });
});
