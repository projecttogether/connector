import { and, eq, isNotNull, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { DirectoryStatus } from "@connector/shared/api/users";
import { config } from "../config";
import { getDb, type DbOrTx } from "../db/client";
import { accounts, groupMembers, groups, settings, users } from "../db/schema";
import { putSetting } from "../core/settings";
import { logger } from "../logger";
import { isEnvironmentAdmin } from "../auth/bootstrap";
import { changeEmail, notRemoved, setDirectoryActive } from "../people/lifecycle";
import { inAnyGroup } from "./groups";
import { createKeycloakClient, displayNameOf, type KeycloakClient, type KeycloakUser } from "./keycloak";

const lastSyncSchema = z.object({
  at: z.string(),
  ok: z.boolean(),
  message: z.string(),
  people: z.number().int(),
  /** Keycloak users left out: their email address is unverified or another person's. */
  skipped: z.number().int().default(0),
});

export async function directoryStatus(db: DbOrTx): Promise<DirectoryStatus> {
  const [row] = await db.select().from(settings).where(eq(settings.key, "directory"));
  const lastSync = lastSyncSchema.safeParse(row?.value);
  const [scim] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(eq(users.directorySource, "scim"));
  return {
    mode: config().DIRECTORY,
    syncMinutes: config().DIRECTORY === "keycloak" ? config().DIRECTORY_SYNC_MINUTES : null,
    lastSync: lastSync.success ? lastSync.data : null,
    scimUrl: config().scimUrl,
    scimPeople: scim?.count ?? 0,
  };
}

const usable = (user: KeycloakUser) => Boolean(user.email?.includes("@"));

/** Where people go whose Keycloak address another person has (`.invalid` is reserved): admins sort it out. */
export const CONFLICT_EMAIL_DOMAIN = "conflict.invalid";

/**
 * DIRECTORY=keycloak: reads every user and group of the realm and keeps
 * people, groups and memberships in step, so access rules and the people
 * directory work before anyone signs in. Only people who may use Connector
 * count: with ACCESS_GROUPS, members of those groups (and ADMIN_EMAILS).
 * Disabled or deleted users, and users who left ACCESS_GROUPS, are blocked
 * (agents revoked); back again, the directory's block lifts.
 * People managed by SCIM keep their details; only groups are synced for
 * them. Runs in one transaction under a lock, so two processes never sync
 * at once.
 */
export async function syncDirectory(
  client: KeycloakClient = createKeycloakClient(),
): Promise<{ people: number }> {
  const db = getDb();
  try {
    // The lock comes first and holds through the commit, so an older
    // snapshot never lands after a newer one.
    const count = await db.transaction(async (tx) => {
      const [lock] = await tx
        .execute<{ locked: boolean }>(
          sql`select pg_try_advisory_xact_lock(hashtext('connector.directory_sync')) as locked`,
        )
        .then((result) => result.rows);
      if (!lock?.locked) return null;

      const realmGroups = await client.groups();
      const members = new Map<string, string[]>();
      const pathsOf = new Map<string, string[]>();
      for (const group of realmGroups) {
        const ids = (await client.directMembers(group.id)).map((user) => user.id);
        members.set(group.id, ids);
        for (const id of ids) pathsOf.set(id, [...(pathsOf.get(id) ?? []), group.path]);
      }
      const required = config().accessGroups;
      const mayUse = (user: KeycloakUser) =>
        required.length === 0 ||
        isEnvironmentAdmin(user.email ?? "") ||
        inAnyGroup(pathsOf.get(user.id) ?? [], required);
      const realmUsers = (await client.users()).filter((user) => usable(user) && mayUse(user));

      const idsByKeycloakId = new Map<string, string>();
      let skipped = 0;
      for (const user of realmUsers) {
        const email = user.email!.trim().toLowerCase();
        // The person this Keycloak user is: bound by directory ID or by the
        // sign-in's subject; by email address only when Keycloak verified it
        // (as at sign-in) and the person is bound to nobody else.
        const [bound] = await tx
          .select({
            id: users.id,
            email: users.email,
            directorySource: users.directorySource,
            adminSource: users.adminSource,
          })
          .from(users)
          .where(
            or(
              and(eq(users.directorySource, "keycloak"), eq(users.directoryId, user.id)),
              sql`exists (select 1 from ${accounts} a where a.user_id = ${users.id} and a.provider_id = 'oidc' and a.account_id = ${user.id})`,
            ),
          )
          .limit(1);
        let existing = bound;
        if (!existing) {
          const [byEmail] = await tx
            .select({
              id: users.id,
              email: users.email,
              directorySource: users.directorySource,
              adminSource: users.adminSource,
              directoryId: users.directoryId,
              otherSubject: sql<boolean>`exists (select 1 from ${accounts} a where a.user_id = ${users.id} and a.provider_id = 'oidc')`,
            })
            .from(users)
            .where(eq(users.email, email));
          const verified = user.emailVerified === true || !config().OIDC_REQUIRE_EMAIL_VERIFIED;
          if (
            byEmail &&
            (!verified ||
              byEmail.otherSubject ||
              (byEmail.directoryId && byEmail.directorySource === "keycloak"))
          ) {
            logger.warn(
              { userId: byEmail.id },
              "a Keycloak user's email address belongs to another person; skipped",
            );
            skipped += 1;
            continue;
          }
          existing = byEmail;
        }
        let id: string;
        if (existing) {
          id = existing.id;
          if (existing.directorySource !== "scim") {
            const [taken] =
              existing.email === email
                ? []
                : await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
            // Another person has the new address: this person keeps neither address,
            // so an address from ADMIN_EMAILS cannot make them admin again.
            const conflict = Boolean(taken) && existing.email !== email;
            const written = conflict ? `conflict-${id}@${CONFLICT_EMAIL_DOMAIN}` : email;
            if (conflict)
              logger.warn({ userId: id }, "a Keycloak user's new email address belongs to another person");
            await tx
              .update(users)
              .set({
                name: displayNameOf(user),
                directorySource: "keycloak",
                directoryId: user.id,
                updatedAt: sql`now()`,
              })
              .where(eq(users.id, id));
            if (written !== existing.email) await changeEmail(tx, existing, written);
          }
        } else {
          const [created] = await tx
            .insert(users)
            .values({ email, name: displayNameOf(user), directorySource: "keycloak", directoryId: user.id })
            .returning({ id: users.id });
          id = created!.id;
        }
        // Keycloak's groups are the person's groups now, also for the grants of the last sign-in.
        await tx
          .update(users)
          .set({ signInGroups: pathsOf.get(user.id) ?? [] })
          .where(eq(users.id, id));
        idsByKeycloakId.set(user.id, id);
        const [person] = await tx
          .select({ directorySource: users.directorySource })
          .from(users)
          .where(eq(users.id, id));
        if (person?.directorySource === "keycloak") await setDirectoryActive(tx, id, user.enabled !== false);
      }

      // People the realm no longer has, or who left ACCESS_GROUPS.
      const gone = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.directorySource, "keycloak"),
            isNotNull(users.directoryId),
            notRemoved,
            realmUsers.length > 0
              ? notInArray(
                  users.directoryId,
                  realmUsers.map((user) => user.id),
                )
              : sql`true`,
          ),
        );
      for (const person of gone) await setDirectoryActive(tx, person.id, false);
      // Keycloak gives the groups of sign-ins too: whoever it no longer lists has none.
      const listed = [...idsByKeycloakId.values()];
      await tx
        .update(users)
        .set({ signInGroups: [] })
        .where(listed.length > 0 ? notInArray(users.id, listed) : sql`true`);

      // Groups: by Keycloak ID; a name an app or SCIM group already has stays theirs.
      const keptGroupIds: string[] = [];
      for (const group of realmGroups) {
        const [existing] = await tx
          .select({ id: groups.id, source: groups.source })
          .from(groups)
          .where(
            or(
              and(eq(groups.source, "keycloak"), eq(groups.externalId, group.id)),
              eq(groups.name, group.path),
            ),
          )
          .orderBy(sql`(${groups.externalId} = ${group.id}) desc nulls last`)
          .limit(1);
        let groupId: string;
        if (existing && existing.source !== "keycloak") {
          logger.warn(
            { groupId: existing.id },
            "a Keycloak group has the name of an app or SCIM group; skipped",
          );
          continue;
        }
        if (existing) {
          groupId = existing.id;
          await tx
            .update(groups)
            .set({ name: group.path, externalId: group.id, updatedAt: sql`now()` })
            .where(eq(groups.id, groupId));
        } else {
          const [created] = await tx
            .insert(groups)
            .values({ name: group.path, source: "keycloak", externalId: group.id })
            .returning({ id: groups.id });
          groupId = created!.id;
        }
        keptGroupIds.push(groupId);
        const wanted = (members.get(group.id) ?? []).flatMap((keycloakId) => {
          const id = idsByKeycloakId.get(keycloakId);
          return id ? [id] : [];
        });
        await tx
          .delete(groupMembers)
          .where(
            and(
              eq(groupMembers.groupId, groupId),
              wanted.length > 0 ? notInArray(groupMembers.userId, wanted) : sql`true`,
            ),
          );
        if (wanted.length > 0) {
          await tx
            .insert(groupMembers)
            .values(wanted.map((userId) => ({ groupId, userId })))
            .onConflictDoNothing();
        }
      }
      await tx
        .delete(groups)
        .where(
          and(
            eq(groups.source, "keycloak"),
            keptGroupIds.length > 0 ? notInArray(groups.id, keptGroupIds) : sql`true`,
          ),
        );

      await putSetting(tx, "directory", {
        at: new Date().toISOString(),
        ok: true,
        message: `Synced ${realmUsers.length - skipped} people and ${keptGroupIds.length} groups`,
        people: realmUsers.length - skipped,
        skipped,
      });
      return realmUsers.length - skipped;
    });
    if (count === null) {
      logger.info("directory sync skipped: another process is syncing");
      return { people: 0 };
    }
    logger.info({ people: count }, "directory synced");
    return { people: count };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "Unknown error";
    await putSetting(db, "directory", {
      at: new Date().toISOString(),
      ok: false,
      message,
      people: 0,
      skipped: 0,
    }).catch(() => undefined);
    throw error;
  }
}
