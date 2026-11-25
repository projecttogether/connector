import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { resetConfigForTests } from "../config";
import { auditLog, credentials, sessions, users } from "../db/schema";
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

const SCIM = { accept: "application/scim+json" };

describe("SCIM 2.0", () => {
  beforeEach(resetDatabase);

  it("needs a SCIM token and describes itself", async () => {
    const admin = await createUser({ isAdmin: true });
    expect((await request("GET", "/scim/v2/Users")).status).toBe(401);
    expect((await request("GET", "/scim/v2/Users", { token: await createToken(admin.id) })).status).toBe(401);
    expect(
      (await request("GET", "/scim/v2/Users", { token: await createAdminToken("service") })).status,
    ).toBe(401);
    const token = await createAdminToken("scim", "IAM");
    const config = await request("GET", "/scim/v2/ServiceProviderConfig", { token, headers: SCIM });
    expect(config.status).toBe(200);
    expect(config.headers.get("content-type")).toBe("application/scim+json");
    expect(config.body).toMatchObject({ patch: { supported: true }, filter: { supported: true } });
    expect((await request("GET", "/scim/v2/Nothing", { token })).status).toBe(404);
  });

  it("provisions people the way an identity system does: find, create, update, deactivate, remove", async () => {
    const token = await createAdminToken("scim", "IAM");
    // Someone who signed in before is found and taken over.
    const existing = await createUser({ email: "rita@example.org", name: "Rita" });
    const found = await request(
      "GET",
      `/scim/v2/Users?filter=${encodeURIComponent('userName eq "Rita@example.org"')}&startIndex=1&count=100`,
      { token },
    );
    expect(found.body).toMatchObject({ totalResults: 1, startIndex: 1, itemsPerPage: 1 });
    expect(found.body.Resources[0]).toMatchObject({
      id: existing.id,
      userName: "rita@example.org",
      active: true,
    });
    const none = await request(
      "GET",
      `/scim/v2/Users?filter=${encodeURIComponent('emails.value eq "nobody@example.org"')}`,
      { token },
    );
    expect(none.body.totalResults).toBe(0);
    expect(
      (await request("GET", `/scim/v2/Users?filter=${encodeURIComponent('nickName co "x"')}`, { token }))
        .status,
    ).toBe(400);

    const created = await request("POST", "/scim/v2/Users", {
      token,
      body: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "olga@example.org",
        externalId: "iam-17",
        name: { givenName: "Olga", familyName: "Operations" },
        displayName: "Olga Operations",
        active: true,
        title: "Office manager",
        emails: [{ value: "olga@example.org", type: "work", primary: true }],
      },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      externalId: "iam-17",
      userName: "olga@example.org",
      displayName: "Olga Operations",
      title: "Office manager",
      active: true,
      groups: [],
      meta: { resourceType: "User" },
    });
    const id = created.body.id as string;
    const [olga] = await getDb().select().from(users).where(eq(users.id, id));
    expect(olga).toMatchObject({ directorySource: "scim", directoryId: "iam-17" });

    // Path form and value form of PATCH, as IAM tries them.
    const renamed = await request("PATCH", `/scim/v2/Users/${id}`, {
      token,
      body: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "title", value: "Head of operations" }],
      },
    });
    expect(renamed.body.title).toBe("Head of operations");

    // Olga signs in once; then her agents work.
    await getDb().update(users).set({ lastSignInAt: new Date() }).where(eq(users.id, id));
    const agent = await createToken(id, "Claude");
    await getDb()
      .insert(sessions)
      .values({ userId: id, token: "s", expiresAt: new Date(Date.now() + 60_000) });
    expect((await request("GET", "/api/v1/me", { token: agent })).status).toBe(200);
    const deactivated = await request("PATCH", `/scim/v2/Users/${id}`, {
      token,
      body: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", value: { active: false } }],
      },
    });
    expect(deactivated.body.active).toBe(false);
    expect((await request("GET", "/api/v1/me", { token: agent })).status).toBe(401);
    expect(await getDb().select().from(sessions).where(eq(sessions.userId, id))).toHaveLength(0);
    const [revoked] = await getDb().select().from(credentials).where(eq(credentials.userId, id));
    expect(revoked!.revokedAt).not.toBeNull();
    const reactivated = await request("PATCH", `/scim/v2/Users/${id}`, {
      token,
      body: { Operations: [{ op: "replace", path: "active", value: "True" }] },
    });
    expect(reactivated.body.active).toBe(true);
    // An admin's block stays when the directory says active.
    const admin = await createUser({ isAdmin: true });
    await request("PATCH", `/api/v1/admin/people/${id}`, { userId: admin.id, body: { blocked: true } });
    await request("PUT", `/scim/v2/Users/${id}`, {
      token,
      body: { userName: "olga@example.org", active: true, displayName: "Olga O." },
    });
    const [blocked] = await getDb().select().from(users).where(eq(users.id, id));
    expect(blocked).toMatchObject({ name: "Olga O.", blockedBy: "app" });
    expect(blocked!.blockedAt).not.toBeNull();

    // Another user's address is taken.
    const clash = await request("PATCH", `/scim/v2/Users/${id}`, {
      token,
      body: { Operations: [{ op: "replace", path: "userName", value: "rita@example.org" }] },
    });
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({ status: "409", scimType: "uniqueness" });

    expect((await request("DELETE", `/scim/v2/Users/${id}`, { token })).status).toBe(204);
    expect((await request("GET", `/scim/v2/Users/${id}`, { token })).status).toBe(404);
    const [removed] = await getDb().select().from(users).where(eq(users.id, id));
    expect(removed!.email).toBe(`removed-${id}@removed.invalid`);
  });

  it("records in the audit log whom the directory blocks and unblocks", async () => {
    const token = await createAdminToken("scim", "IAM");
    const created = await request("POST", "/scim/v2/Users", {
      token,
      body: { userName: "olga@example.org", displayName: "Olga" },
    });
    const id = created.body.id as string;
    const setActive = (value: boolean) =>
      request("PATCH", `/scim/v2/Users/${id}`, {
        token,
        body: { Operations: [{ op: "replace", path: "active", value }] },
      });
    await setActive(false);
    // Saying it again changes nothing and records nothing.
    await setActive(false);
    await setActive(true);
    const entries = await getDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, id))
      .orderBy(asc(auditLog.createdAt), asc(auditLog.id));
    expect(
      entries.map(({ actorUserId, action, entityType, summary }) => ({
        actorUserId,
        action,
        entityType,
        summary,
      })),
    ).toEqual([
      {
        actorUserId: null,
        action: "scim.user_created",
        entityType: "user",
        summary: "The directory (SCIM) added a person",
      },
      {
        actorUserId: null,
        action: "person.blocked",
        entityType: "user",
        summary: "The directory blocked olga@example.org",
      },
      {
        actorUserId: null,
        action: "person.unblocked",
        entityType: "user",
        summary: "The directory unblocked olga@example.org",
      },
    ]);

    // Renamed, then removed: the log keeps neither address.
    await request("PATCH", `/scim/v2/Users/${id}`, {
      token,
      body: { Operations: [{ op: "replace", path: "userName", value: "olga.new@example.org" }] },
    });
    expect((await request("DELETE", `/scim/v2/Users/${id}`, { token })).status).toBe(204);
    const summaries = (await getDb().select().from(auditLog)).map((entry) => entry.summary).join("\n");
    expect(summaries).not.toContain("olga");
    expect(summaries).toContain("The directory blocked a removed person");
  });

  it("keeps admin rights from ADMIN_EMAILS only while the new address is in ADMIN_EMAILS", async () => {
    const previousAdmins = process.env.ADMIN_EMAILS;
    process.env.ADMIN_EMAILS = "root@example.org,boss@example.org";
    resetConfigForTests();
    onTestFinished(() => {
      process.env.ADMIN_EMAILS = previousAdmins;
      resetConfigForTests();
    });
    const token = await createAdminToken("scim", "IAM");
    const root = await createUser({ email: "root@example.org", isAdmin: true });
    await getDb().update(users).set({ adminSource: "environment" }).where(eq(users.id, root.id));
    const person = async () => (await getDb().select().from(users).where(eq(users.id, root.id)))[0];

    const replaced = await request("PUT", `/scim/v2/Users/${root.id}`, {
      token,
      body: { userName: "boss@example.org", displayName: "Root" },
    });
    expect(replaced.status).toBe(200);
    expect(await person()).toMatchObject({
      email: "boss@example.org",
      isAdmin: true,
      adminSource: "environment",
    });

    const patched = await request("PATCH", `/scim/v2/Users/${root.id}`, {
      token,
      body: { Operations: [{ op: "replace", path: "userName", value: "former.root@example.org" }] },
    });
    expect(patched.status).toBe(200);
    expect(await person()).toMatchObject({
      email: "former.root@example.org",
      isAdmin: false,
      adminSource: null,
    });
  });

  it("does not remove or block an admin from ADMIN_EMAILS", async () => {
    const token = await createAdminToken("scim", "IAM");
    // In ADMIN_EMAILS, but not yet made admin by a start.
    const root = await createUser({ email: "root@example.org" });
    const person = async () => (await getDb().select().from(users).where(eq(users.id, root.id)))[0];
    const refused = {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "409",
      detail: "This person is an admin through ADMIN_EMAILS; change it there",
    };

    const byAddress = await request("DELETE", `/scim/v2/Users/${root.id}`, { token });
    expect(byAddress.status).toBe(409);
    expect(byAddress.body).toEqual(refused);
    expect(await person()).toMatchObject({ email: "root@example.org", blockedAt: null });

    // Made admin by the last start under an address ADMIN_EMAILS no longer lists.
    await getDb()
      .update(users)
      .set({ email: "former.root@example.org", isAdmin: true, adminSource: "environment" })
      .where(eq(users.id, root.id));
    const byStart = await request("DELETE", `/scim/v2/Users/${root.id}`, { token });
    expect(byStart.status).toBe(409);
    expect(byStart.body).toEqual(refused);
    const deactivated = await request("PATCH", `/scim/v2/Users/${root.id}`, {
      token,
      body: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "active", value: false }],
      },
    });
    expect(deactivated.status).toBe(200);
    expect(await person()).toMatchObject({
      email: "former.root@example.org",
      isAdmin: true,
      adminSource: "environment",
      blockedAt: null,
    });
  });

  it("fills groups that decide who may use which source", async () => {
    const token = await createAdminToken("scim", "IAM");
    const rita = await createUser({ email: "rita@example.org" });
    const olga = await createUser({ email: "olga@example.org" });
    await createSource({
      kind: "logbook",
      config: { baseUrl: "https://logbook.example.org" },
      accessGroups: ["Operations"],
    });
    // IAM imports existing groups, then fills them.
    await createGroup("Operations");
    const listed = await request("GET", "/scim/v2/Groups?attributes=displayName&startIndex=1&count=100", {
      token,
    });
    expect(listed.body.Resources).toEqual([expect.objectContaining({ displayName: "Operations" })]);
    expect(listed.body.Resources[0].members).toBeUndefined();
    const groupId = listed.body.Resources[0].id as string;

    expect((await request("GET", "/api/v1/sources", { userId: olga.id })).body.items).toEqual([]);
    const added = await request("PATCH", `/scim/v2/Groups/${groupId}`, {
      token,
      body: { Operations: [{ op: "add", path: "members", value: [{ value: olga.id }, { value: rita.id }] }] },
    });
    expect(added.body.members.map((member: { value: string }) => member.value).sort()).toEqual(
      [olga.id, rita.id].sort(),
    );
    expect((await request("GET", "/api/v1/sources", { userId: olga.id })).body.items).toHaveLength(1);
    const memberOf = await request(
      "GET",
      `/scim/v2/Groups?filter=${encodeURIComponent(`members.value eq "${olga.id}"`)}`,
      { token },
    );
    expect(memberOf.body.totalResults).toBe(1);

    await request("PATCH", `/scim/v2/Groups/${groupId}`, {
      token,
      body: { Operations: [{ op: "remove", path: `members[value eq "${olga.id}"]` }] },
    });
    expect((await request("GET", "/api/v1/sources", { userId: olga.id })).body.items).toEqual([]);
    expect((await request("GET", "/api/v1/sources", { userId: rita.id })).body.items).toHaveLength(1);

    const user = await request("GET", `/scim/v2/Users/${rita.id}`, { token });
    expect(user.body.groups).toEqual([expect.objectContaining({ value: groupId, display: "Operations" })]);

    // A member Connector never had is no member: nothing to remove, and no error.
    const stranger = await request("PATCH", `/scim/v2/Groups/${groupId}`, {
      token,
      body: { Operations: [{ op: "remove", path: 'members[value eq "not-an-id"]' }] },
    });
    expect(stranger.status).toBe(200);
    const beyond = await request("GET", "/scim/v2/Users?startIndex=99999999999999999999", { token });
    expect(beyond.status).toBe(200);
    expect(beyond.body.Resources).toEqual([]);

    const unknown = await request("PATCH", `/scim/v2/Groups/${groupId}`, {
      token,
      body: {
        Operations: [
          { op: "add", path: "members", value: [{ value: "00000000-0000-4000-8000-000000000000" }] },
        ],
      },
    });
    expect(unknown.status).toBe(400);

    // Other systems create groups themselves; Keycloak groups stay read-only.
    const created = await request("POST", "/scim/v2/Groups", {
      token,
      body: { displayName: "Finance", members: [{ value: rita.id }] },
    });
    expect(created.status).toBe(201);
    expect(
      (await request("POST", "/scim/v2/Groups", { token, body: { displayName: "Finance" } })).status,
    ).toBe(409);
    const keycloak = await createGroup("/staff", [], { source: "keycloak", externalId: "kc" });
    expect(
      (
        await request("PATCH", `/scim/v2/Groups/${keycloak.id}`, {
          token,
          body: { Operations: [{ op: "add", path: "members", value: [{ value: rita.id }] }] },
        })
      ).status,
    ).toBe(400);
    expect((await request("DELETE", `/scim/v2/Groups/${created.body.id}`, { token })).status).toBe(204);
  });
});
