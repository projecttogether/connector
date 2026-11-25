import { and, asc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { Person, PersonUpdate } from "@connector/shared/api/users";
import type { Db } from "../db/client";
import { escapeLike } from "../db/like";
import { groupMembers, groups, users } from "../db/schema";
import type { UserPrincipal } from "../auth/principal";
import { audit } from "../core/audit";
import { conflict, notFound } from "../http/errors";
import {
  ENVIRONMENT_ADMIN_MESSAGE,
  isAdminThroughEnvironment,
  isRemoved,
  notRemoved,
  setBlocked,
} from "../people/lifecycle";

const iso = (value: Date | null) => (value ? value.toISOString() : null);

export async function listPeople(db: Db, q: string | undefined, ids?: string[]): Promise<Person[]> {
  const rows = await db
    .select()
    .from(users)
    .where(
      and(
        notRemoved,
        q ? or(ilike(users.email, `%${escapeLike(q)}%`), ilike(users.name, `%${escapeLike(q)}%`)) : undefined,
        ids ? inArray(users.id, ids) : undefined,
      ),
    )
    .orderBy(asc(users.email))
    .limit(500);
  const memberships = await db
    .select({ userId: groupMembers.userId, name: groups.name })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .orderBy(asc(groups.name));
  return rows.map((user) => ({
    id: user.id,
    email: user.email,
    name: user.name || user.email,
    title: user.title,
    isAdmin: user.isAdmin,
    adminSource: user.isAdmin ? (user.adminSource === "environment" ? "environment" : "app") : null,
    blocked: user.blockedAt !== null,
    directory:
      user.directorySource === "scim" || user.directorySource === "keycloak" ? user.directorySource : null,
    groups: [
      ...new Set([
        ...user.signInGroups,
        ...memberships.filter((row) => row.userId === user.id).map((row) => row.name),
      ]),
    ].sort((a, b) => a.localeCompare(b)),
    lastSignInAt: iso(user.lastSignInAt),
    createdAt: user.createdAt.toISOString(),
  }));
}

/**
 * Makes a person admin or not, blocks or unblocks them. People listed in
 * ADMIN_EMAILS stay admins; nobody changes their own admin rights or blocks
 * themselves. Blocking ends their sessions and revokes their personal
 * tokens and connected apps for good: unblocking does not bring them back.
 */
export async function updatePerson(
  db: Db,
  actor: UserPrincipal,
  userId: string,
  input: PersonUpdate,
): Promise<Person> {
  await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    if (!user || isRemoved(user)) throw notFound("No such person");
    if (user.id === actor.id && (input.isAdmin === false || input.blocked === true)) {
      throw conflict("You cannot remove your own admin rights or block yourself", "self_change");
    }
    if (isAdminThroughEnvironment(user) && (input.isAdmin === false || input.blocked === true)) {
      throw conflict(ENVIRONMENT_ADMIN_MESSAGE, "environment_admin");
    }
    const changes: string[] = [];
    if (input.isAdmin !== undefined && input.isAdmin !== user.isAdmin) {
      await tx
        .update(users)
        .set({ isAdmin: input.isAdmin, adminSource: input.isAdmin ? "app" : null, updatedAt: sql`now()` })
        .where(eq(users.id, user.id));
      changes.push(
        input.isAdmin ? `Made ${user.email} an admin` : `Removed the admin rights of ${user.email}`,
      );
    }
    if (input.blocked !== undefined && (await setBlocked(tx, user, input.blocked, "app"))) {
      changes.push(`${input.blocked ? "Blocked" : "Unblocked"} ${user.email}`);
    }
    if (changes.length === 0) return;
    await audit(tx, actor, {
      action: "person.updated",
      entityType: "user",
      entityId: user.id,
      summary: changes.join("; "),
    });
  });
  const [person] = await listPeople(db, undefined, [userId]);
  return person!;
}
