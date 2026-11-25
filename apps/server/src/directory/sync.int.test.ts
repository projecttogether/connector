import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { resetConfigForTests } from "../config";
import { auditLog, credentials, groups, users } from "../db/schema";
import { createGroup, createToken, createUser, request, resetDatabase } from "../test/helpers";
import type { KeycloakClient, KeycloakUser } from "./keycloak";
import { ensureEnvironmentAdmins } from "../auth/bootstrap";
import { directoryStatus, syncDirectory } from "./sync";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

function realm(
  people: KeycloakUser[],
  memberships: Record<string, { id: string; path: string; members: string[] }>,
): KeycloakClient {
  return {
    userGroups: async () => [],
    users: async () => people,
    groups: async () => Object.values(memberships).map(({ id, path }) => ({ id, path })),
    directMembers: async (groupId) => {
      const group = Object.values(memberships).find((item) => item.id === groupId);
      return people.filter((person) => group?.members.includes(person.id));
    },
  };
}

describe("Keycloak directory sync", () => {
  beforeEach(resetDatabase);

  it("keeps people, groups and memberships in step, and blocks disabled people", async () => {
    // Ada's last sign-in still names a team she has left in Keycloak.
    const ada = await createUser({ email: "ada@example.org", name: "Ada", signInGroups: ["/teams/Old"] });
    const agent = await createToken(ada.id, "Claude");
    await createGroup("Finance", [ada.id]);
    const people: KeycloakUser[] = [
      {
        id: "kc-ada",
        email: "ada@example.org",
        emailVerified: true,
        firstName: "Ada",
        lastName: "Lovelace",
        enabled: true,
      },
      {
        id: "kc-rita",
        email: "Rita@example.org",
        emailVerified: true,
        firstName: "Rita",
        lastName: "Reader",
        enabled: true,
      },
      { id: "kc-bot", username: "bot", enabled: true },
    ];
    await syncDirectory(
      realm(people, {
        staff: { id: "g-staff", path: "/staff", members: [] },
        it: { id: "g-it", path: "/staff/it", members: ["kc-ada"] },
        programs: { id: "g-programs", path: "/teams/Programs", members: ["kc-rita"] },
      }),
    );
    const rows = await getDb().select().from(users);
    expect(rows.map((row) => [row.email, row.name, row.directorySource]).sort()).toEqual([
      ["ada@example.org", "Ada Lovelace", "keycloak"],
      ["rita@example.org", "Rita Reader", "keycloak"],
    ]);
    const me = await request("GET", "/api/v1/me", { token: agent });
    expect(me.body.groups).toEqual(["/staff/it", "Finance"]);
    const rita = rows.find((row) => row.email === "rita@example.org")!;
    const people2 = await request("GET", "/api/v1/people?q=programs", { userId: ada.id });
    expect(people2.body.items).toEqual([
      expect.objectContaining({ email: "rita@example.org", groups: ["/teams/Programs"] }),
    ]);

    // Ada is disabled, Rita leaves her team, the team group goes.
    people[0]!.enabled = false;
    await syncDirectory(realm(people, { it: { id: "g-it", path: "/staff/it", members: ["kc-ada"] } }));
    expect((await request("GET", "/api/v1/me", { token: agent })).status).toBe(401);
    const [revoked] = await getDb().select().from(credentials).where(eq(credentials.userId, ada.id));
    expect(revoked!.revokedAt).not.toBeNull();
    const directoryEntries = () =>
      getDb()
        .select({ actorUserId: auditLog.actorUserId, action: auditLog.action, summary: auditLog.summary })
        .from(auditLog)
        .where(eq(auditLog.entityId, ada.id))
        .orderBy(asc(auditLog.createdAt), asc(auditLog.id));
    expect(await directoryEntries()).toEqual([
      { actorUserId: null, action: "person.blocked", summary: "The directory blocked ada@example.org" },
    ]);
    expect((await getDb().select().from(groups)).map((group) => group.name).sort()).toEqual([
      "/staff/it",
      "Finance",
    ]);
    expect((await request("GET", "/api/v1/people?q=rita", { userId: rita.id })).body.items[0].groups).toEqual(
      [],
    );

    // Enabled again: the directory lifts its own block (tokens stay revoked).
    people[0]!.enabled = true;
    await syncDirectory(realm(people, {}));
    const [back] = await getDb().select().from(users).where(eq(users.id, ada.id));
    expect(back!.blockedAt).toBeNull();
    expect((await directoryEntries()).map((entry) => entry.summary)).toEqual([
      "The directory blocked ada@example.org",
      "The directory unblocked ada@example.org",
    ]);
    // Deleted in Keycloak: blocked.
    await syncDirectory(realm([people[0]!], {}));
    const [gone] = await getDb().select().from(users).where(eq(users.id, rita.id));
    expect(gone).toMatchObject({ blockedBy: "directory" });
    const status = await request("GET", "/api/v1/admin/directory", {
      userId: (await createUser({ isAdmin: true })).id,
    });
    expect(status.body.lastSync).toMatchObject({ ok: true, people: 1 });
  });
});

describe("Keycloak directory sync with ACCESS_GROUPS", () => {
  beforeEach(resetDatabase);

  it("lists only people who may use Connector and blocks those who leave the groups", async () => {
    process.env.ACCESS_GROUPS = "/staff";
    resetConfigForTests();
    try {
      const people: KeycloakUser[] = [
        { id: "kc-rita", email: "rita@example.org", firstName: "Rita", enabled: true },
        { id: "kc-gina", email: "gina@example.org", firstName: "Gina", enabled: true },
        { id: "kc-root", email: "root@example.org", firstName: "Root", enabled: true },
      ];
      await syncDirectory(
        realm(people, {
          it: { id: "g-it", path: "/staff/it", members: ["kc-rita"] },
          guests: { id: "g-guests", path: "/guests", members: ["kc-gina"] },
        }),
      );
      const emails = (await getDb().select().from(users)).map((row) => row.email).sort();
      expect(emails).toEqual(["rita@example.org", "root@example.org"]);
      // Rita moves to the guests: blocked.
      await syncDirectory(
        realm(people, { guests: { id: "g-guests", path: "/guests", members: ["kc-gina", "kc-rita"] } }),
      );
      const [rita] = await getDb().select().from(users).where(eq(users.email, "rita@example.org"));
      expect(rita).toMatchObject({ blockedBy: "directory" });
    } finally {
      delete process.env.ACCESS_GROUPS;
      resetConfigForTests();
    }
  });
});

describe("Keycloak directory sync and identities", () => {
  beforeEach(resetDatabase);

  it("counts only the groups it synced: a name an app or SCIM group has stays theirs", async () => {
    await createGroup("/staff");
    await syncDirectory(
      realm([], {
        staff: { id: "g-staff", path: "/staff", members: [] },
        it: { id: "g-it", path: "/it", members: [] },
      }),
    );
    expect((await directoryStatus(getDb())).lastSync).toMatchObject({
      message: "Synced 0 people and 1 groups",
    });
  });

  it("adopts a person by email only when Keycloak verified it, and admin rights stay with the address", async () => {
    const root = await createUser({ email: "root@example.org", isAdmin: true });
    await getDb().update(users).set({ adminSource: "environment" }).where(eq(users.id, root.id));
    const claim: KeycloakUser = {
      id: "kc-x",
      email: "root@example.org",
      firstName: "Mallory",
      enabled: true,
      emailVerified: false,
    };
    await syncDirectory(realm([claim], {}));
    const [untouched] = await getDb().select().from(users).where(eq(users.id, root.id));
    expect(untouched).toMatchObject({ directoryId: null, name: root.name });
    expect((await directoryStatus(getDb())).lastSync).toMatchObject({
      ok: true,
      people: 0,
      skipped: 1,
      message: "Synced 0 people and 0 groups",
    });

    // Verified, the person is adopted; when their address changes, ADMIN_EMAILS no longer makes them admin.
    claim.emailVerified = true;
    await syncDirectory(realm([claim], {}));
    expect((await directoryStatus(getDb())).lastSync).toMatchObject({ skipped: 0 });
    claim.email = "mallory@example.org";
    await syncDirectory(realm([claim], {}));
    const [moved] = await getDb().select().from(users).where(eq(users.id, root.id));
    expect(moved).toMatchObject({ email: "mallory@example.org", isAdmin: false, adminSource: null });
  });

  it("drops admin rights from ADMIN_EMAILS also when the new address is taken, and grants of people Keycloak no longer lists", async () => {
    const previousAdmins = process.env.ADMIN_EMAILS;
    const root = await createUser({ email: "root@example.org", isAdmin: true });
    await getDb().update(users).set({ adminSource: "environment" }).where(eq(users.id, root.id));
    // The occupied address is in ADMIN_EMAILS too: the placeholder still counts.
    process.env.ADMIN_EMAILS = "root@example.org,taken@example.org";
    resetConfigForTests();
    onTestFinished(() => {
      process.env.ADMIN_EMAILS = previousAdmins;
      resetConfigForTests();
    });
    await createUser({ email: "taken@example.org" });
    const scimPerson = await createUser({ email: "olga@example.org", signInGroups: ["/staff"] });
    await getDb().update(users).set({ directorySource: "scim" }).where(eq(users.id, scimPerson.id));
    const claim: KeycloakUser = {
      id: "kc-root",
      email: "root@example.org",
      emailVerified: true,
      enabled: true,
    };
    await syncDirectory(realm([claim], {}));
    claim.email = "taken@example.org";
    await syncDirectory(realm([claim], {}));
    const [kept] = await getDb().select().from(users).where(eq(users.id, root.id));
    expect(kept).toMatchObject({ email: `conflict-${root.id}@conflict.invalid`, isAdmin: false });
    // A restart makes the address in ADMIN_EMAILS an admin again, not this person.
    await ensureEnvironmentAdmins(getDb());
    const [still] = await getDb().select().from(users).where(eq(users.id, root.id));
    expect(still!.isAdmin).toBe(false);

    const [olga] = await getDb().select().from(users).where(eq(users.id, scimPerson.id));
    expect(olga!.signInGroups).toEqual([]);
  });
});
