import { and, eq, inArray, not, notLike, or, sql } from "drizzle-orm";
import { REMOVED_PERSON_NAME } from "@connector/shared/api/users";
import { config } from "../config";
import type { Db, DbOrTx } from "../db/client";
import {
  accounts,
  activity,
  auditLog,
  credentials,
  groupMembers,
  linkRequests,
  oauthGrants,
  oauthRequests,
  sessions,
  sourceLinks,
  users,
} from "../db/schema";
import type { UserPrincipal } from "../auth/principal";
import { isEnvironmentAdmin } from "../auth/bootstrap";
import { revokeAgentAccess } from "../auth/credentials";
import { audit } from "../core/audit";
import { conflict, notFound } from "../http/errors";

/*
 * Changes to a person's lifecycle, whoever makes them: admins, the Keycloak
 * directory, SCIM and the sign-in. Blocking, address changes and removal
 * follow the same rules on every path.
 */

/**
 * Removed people keep their row, so that the audit and activity logs still
 * name someone, under an address that no provider can sign in with
 * (`.invalid` is reserved) and that keeps emails unique.
 */
const REMOVED_EMAIL_DOMAIN = "removed.invalid";

export const isRemoved = (user: { email: string }) => user.email.endsWith(`@${REMOVED_EMAIL_DOMAIN}`);

/** SQL condition: the person is not removed. */
export const notRemoved = notLike(users.email, `%@${REMOVED_EMAIL_DOMAIN}`);

/** Why nobody in Connector can block, demote or remove an admin from ADMIN_EMAILS. */
export const ENVIRONMENT_ADMIN_MESSAGE = "This person is an admin through ADMIN_EMAILS; change it there";

/** ADMIN_EMAILS makes this person admin: since the last start, or by their address now. */
export function isAdminThroughEnvironment(user: { email: string; adminSource: string | null }): boolean {
  return user.adminSource === "environment" || isEnvironmentAdmin(user.email);
}

type BlockState = Pick<typeof users.$inferSelect, "id" | "email" | "adminSource" | "blockedAt" | "blockedBy">;

/**
 * Blocks or unblocks a person; `by` is who acts. Blocking ends their
 * sessions and revokes their personal tokens and connected apps for good:
 * unblocking does not bring them back. The directory never blocks admins
 * from ADMIN_EMAILS and lifts only its own blocks; the app lifts any block.
 * Returns whether anything changed.
 */
export async function setBlocked(
  tx: DbOrTx,
  user: BlockState,
  blocked: boolean,
  by: "app" | "directory",
): Promise<boolean> {
  if (blocked === (user.blockedAt !== null)) return false;
  if (by === "directory" && (blocked ? isAdminThroughEnvironment(user) : user.blockedBy !== "directory")) {
    return false;
  }
  await tx
    .update(users)
    .set({ blockedAt: blocked ? sql`now()` : null, blockedBy: blocked ? by : null, updatedAt: sql`now()` })
    .where(eq(users.id, user.id));
  if (blocked) {
    await tx.delete(sessions).where(eq(sessions.userId, user.id));
    await revokeAgentAccess(tx, user.id);
  }
  return true;
}

/**
 * Blocks or unblocks a person on the directory's word (SCIM `active`,
 * Keycloak `enabled`), and records it in the audit log.
 */
export async function setDirectoryActive(tx: DbOrTx, userId: string, active: boolean) {
  const [user] = await tx.select().from(users).where(eq(users.id, userId));
  if (!user || !(await setBlocked(tx, user, !active, "directory"))) return;
  await audit(tx, null, {
    action: active ? "person.unblocked" : "person.blocked",
    entityType: "user",
    entityId: user.id,
    summary: `The directory ${active ? "unblocked" : "blocked"} ${user.email}`,
  });
}

/**
 * Gives a person a new address (the directory's change). Admin rights from
 * ADMIN_EMAILS belong to the address: they stay only if the new address is
 * in ADMIN_EMAILS too. Decided by the row as it is when written (a sign-in
 * may have made the person admin since the caller read it). Callers check
 * that nobody else has the address.
 */
export async function changeEmail(tx: DbOrTx, user: { id: string }, email: string) {
  const fromEnvironment = sql`${users.adminSource} = 'environment'`;
  await tx
    .update(users)
    .set({
      email,
      ...(isEnvironmentAdmin(email)
        ? {}
        : {
            isAdmin: sql`case when ${fromEnvironment} then false else ${users.isAdmin} end`,
            adminSource: sql`case when ${fromEnvironment} then null else ${users.adminSource} end`,
          }),
      updatedAt: sql`now()`,
    })
    .where(eq(users.id, user.id));
}

/**
 * At sign-in: an address in ADMIN_EMAILS makes the person admin and lifts
 * any block, so ADMIN_EMAILS is always the way back in. Admin rights from
 * ADMIN_EMAILS end when the provider changed the address to one it does not
 * list. Decided by the address the row has now, not as the sign-in read it
 * (the directory may have changed it meanwhile). Returns whether the person
 * is an admin through ADMIN_EMAILS.
 */
export async function environmentAdminAtSignIn(db: DbOrTx, userId: string): Promise<boolean> {
  const listed = config().adminEmails;
  const inList = listed.length > 0 ? inArray(sql`lower(${users.email})`, listed) : sql`false`;
  const promoted = await db
    .update(users)
    .set({
      isAdmin: true,
      adminSource: "environment",
      blockedAt: null,
      blockedBy: null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(users.id, userId), inList))
    .returning({ id: users.id });
  if (promoted.length > 0) return true;
  await db
    .update(users)
    .set({ isAdmin: false, adminSource: null, updatedAt: sql`now()` })
    .where(and(eq(users.id, userId), eq(users.adminSource, "environment"), not(inList)));
  return false;
}

/** What audit summaries and search words say instead of a removed person's email or name. */
const REMOVED_IN_SUMMARIES = "a removed person";

/**
 * A PostgreSQL pattern that finds `text` as a whole name or address, not
 * inside another one: "ben@example.org" not in "ruben@example.org", "Rita
 * Reader" not in "Margarita Reader".
 */
function standalone(text: string): string {
  const literal = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?<![[:alnum:]_.+@-])${literal}(?![[:alnum:]_@-]|\\.[[:alnum:]])`;
}

/**
 * Removes a person while the logs stay readable: their name and email are
 * replaced; their provider accounts, sessions, tokens, connected apps,
 * pending app sign-ins, linked accounts and group memberships are deleted;
 * the audit log loses their email; the activity log keeps their entries
 * under the placeholder name, without their personal tokens' names, and
 * loses their email and full name from everyone's search words. If they
 * sign in again, they come back as a new, empty person. Not for people in
 * ADMIN_EMAILS, and not for yourself. `actor` null: the directory (SCIM)
 * removed them.
 */
export async function removePerson(db: Db, actor: UserPrincipal | null, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    if (!user || isRemoved(user)) throw notFound("No such person");
    if (actor && user.id === actor.id) throw conflict("You cannot remove yourself", "self_change");
    if (isAdminThroughEnvironment(user)) throw conflict(ENVIRONMENT_ADMIN_MESSAGE, "environment_admin");

    await tx.delete(sessions).where(eq(sessions.userId, user.id));
    await tx.delete(accounts).where(eq(accounts.userId, user.id));
    // Personal tokens and the tokens of connected apps; service tokens have no person.
    await tx.delete(credentials).where(eq(credentials.userId, user.id));
    await tx.delete(oauthGrants).where(eq(oauthGrants.userId, user.id));
    await tx.delete(oauthRequests).where(eq(oauthRequests.userId, user.id));
    await tx.delete(sourceLinks).where(eq(sourceLinks.userId, user.id));
    await tx.delete(linkRequests).where(eq(linkRequests.userId, user.id));
    await tx.delete(groupMembers).where(eq(groupMembers.userId, user.id));
    await tx
      .update(users)
      .set({
        email: `removed-${user.id}@${REMOVED_EMAIL_DOMAIN}`,
        name: REMOVED_PERSON_NAME,
        emailVerified: false,
        image: null,
        title: null,
        isAdmin: false,
        adminSource: null,
        // Nothing can sign in as this row; blocked in case a sign-in raced the removal.
        blockedAt: sql`now()`,
        blockedBy: "app",
        signInGroups: [],
        directorySource: null,
        directoryId: null,
        lastSignInAt: null,
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, user.id));

    // The audit log shows the placeholder name as the actor (null would read as "System").
    await tx
      .update(auditLog)
      .set({ actorEmail: REMOVED_PERSON_NAME })
      .where(or(eq(auditLog.actorUserId, user.id), eq(auditLog.actorEmail, user.email)));
    await tx
      .update(auditLog)
      .set({ summary: sql`replace(${auditLog.summary}, ${user.email}, ${REMOVED_IN_SUMMARIES})` })
      .where(sql`strpos(${auditLog.summary}, ${user.email}) > 0`);
    // The directory's entries name the person by the address they had then.
    for (const [action, verb] of [
      ["person.blocked", "blocked"],
      ["person.unblocked", "unblocked"],
    ] as const) {
      await tx
        .update(auditLog)
        .set({ summary: `The directory ${verb} ${REMOVED_IN_SUMMARIES}` })
        .where(and(eq(auditLog.entityId, user.id), eq(auditLog.action, action)));
    }
    // The activity log keeps their entries, so counts and source health stay
    // right. It named them by name or email, and a personal token by the name
    // they gave it; connected apps are named by the app.
    await tx
      .update(activity)
      .set({
        actor: REMOVED_PERSON_NAME,
        client: sql`case when ${activity.channel} = 'token' then null else ${activity.client} end`,
      })
      .where(eq(activity.userId, user.id));
    // Anyone's agent may have looked them up by their address or full name, in any case.
    // A one-word name ("Max") is also an everyday word, so it stays in others' words.
    const fullName = user.name.trim();
    for (const identifier of [user.email, /\s/.test(fullName) ? fullName : ""].filter(Boolean)) {
      const pattern = standalone(identifier);
      await tx
        .update(activity)
        .set({ query: sql`regexp_replace(${activity.query}, ${pattern}, ${REMOVED_IN_SUMMARIES}, 'gi')` })
        .where(sql`${activity.query} ~* ${pattern}`);
    }
    await audit(tx, actor, {
      action: "person.removed",
      entityType: "user",
      entityId: user.id,
      summary: actor ? "Removed a person" : "The directory removed a person",
    });
  });
}
