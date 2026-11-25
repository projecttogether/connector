import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { sessions, users } from "../db/schema";
import { createGroup, createToken, createUser, request, resetDatabase } from "../test/helpers";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

describe("admin API", () => {
  beforeEach(resetDatabase);

  it("lists people, makes admins, blocks people and protects itself and ADMIN_EMAILS", async () => {
    const admin = await createUser({ isAdmin: true, email: "ada@example.org" });
    const person = await createUser({
      email: "rita@example.org",
      signInGroups: ["/staff"],
      title: "Program lead",
    });
    await createGroup("/teams/Programs", [person.id]);
    const root = await createUser({ email: "root@example.org" });
    await getDb()
      .update(users)
      .set({ isAdmin: true, adminSource: "environment" })
      .where(eq(users.id, root.id));
    await getDb()
      .insert(sessions)
      .values({ userId: person.id, token: "t", expiresAt: new Date(Date.now() + 60_000) });

    expect((await request("GET", "/api/v1/admin/people", { userId: person.id })).status).toBe(403);
    const agent = await createToken(admin.id);
    expect((await request("GET", "/api/v1/admin/people", { token: agent })).status).toBe(403);
    const list = await request("GET", "/api/v1/admin/people?q=rita", { userId: admin.id });
    expect(list.body.items).toEqual([
      expect.objectContaining({
        email: "rita@example.org",
        title: "Program lead",
        isAdmin: false,
        directory: null,
        groups: ["/staff", "/teams/Programs"],
      }),
    ]);

    const made = await request("PATCH", `/api/v1/admin/people/${person.id}`, {
      userId: admin.id,
      body: { isAdmin: true },
    });
    expect(made.body).toMatchObject({ isAdmin: true, adminSource: "app" });
    const blocked = await request("PATCH", `/api/v1/admin/people/${person.id}`, {
      userId: admin.id,
      body: { isAdmin: false, blocked: true },
    });
    expect(blocked.body).toMatchObject({ isAdmin: false, blocked: true });
    expect(await getDb().select().from(sessions).where(eq(sessions.userId, person.id))).toHaveLength(0);
    expect((await request("GET", "/api/v1/me", { userId: person.id })).status).toBe(401);

    expect(
      (
        await request("PATCH", `/api/v1/admin/people/${admin.id}`, {
          userId: admin.id,
          body: { blocked: true },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request("PATCH", `/api/v1/admin/people/${root.id}`, {
          userId: admin.id,
          body: { isAdmin: false },
        })
      ).status,
    ).toBe(409);

    const audit = await request("GET", "/api/v1/admin/audit", { userId: admin.id });
    expect(audit.body.total).toBe(2);
    expect(audit.body.items.map((item: { summary: string }) => item.summary)).toEqual([
      "Removed the admin rights of rita@example.org; Blocked rita@example.org",
      "Made rita@example.org an admin",
    ]);
  });

  it("manages groups for SCIM clients and keeps Keycloak groups read-only", async () => {
    const admin = await createUser({ isAdmin: true });
    const rita = await createUser();
    const created = await request("POST", "/api/v1/admin/groups", {
      userId: admin.id,
      body: { name: "Programs" },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Programs", source: "app", members: 0 });
    expect(
      (await request("POST", "/api/v1/admin/groups", { userId: admin.id, body: { name: "Programs" } }))
        .status,
    ).toBe(422);
    expect(
      (await request("POST", "/api/v1/admin/groups", { userId: rita.id, body: { name: "Other" } })).status,
    ).toBe(403);
    const keycloak = await createGroup("/staff", [rita.id], { source: "keycloak", externalId: "kc-1" });
    const list = await request("GET", "/api/v1/admin/groups", { userId: admin.id });
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "/staff", source: "keycloak", members: 1 }),
        expect.objectContaining({ name: "Programs", source: "app" }),
      ]),
    );
    expect(
      (await request("DELETE", `/api/v1/admin/groups/${keycloak.id}`, { userId: admin.id })).status,
    ).toBe(409);
    expect(
      (await request("DELETE", `/api/v1/admin/groups/${created.body.id}`, { userId: admin.id })).status,
    ).toBe(204);
    const directory = await request("GET", "/api/v1/admin/directory", { userId: admin.id });
    expect(directory.body).toMatchObject({
      mode: "oidc",
      scimUrl: "http://localhost:3000/scim/v2",
      scimPeople: 0,
    });
  });
});
