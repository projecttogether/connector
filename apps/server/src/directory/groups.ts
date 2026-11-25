import { eq } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import { groupMembers, groups, users } from "../db/schema";

/** A person's groups: names (sign-in claim and directory) and the IDs of their Keycloak groups. */
export type GroupSet = { names: string[]; externalIds: string[] };

export const NO_GROUPS: GroupSet = { names: [], externalIds: [] };

/** The groups of the last sign-in plus the directory groups (SCIM, Keycloak, app) of a person. */
export async function groupsOfUser(db: DbOrTx, userId: string): Promise<GroupSet> {
  const [person] = await db
    .select({ signInGroups: users.signInGroups })
    .from(users)
    .where(eq(users.id, userId));
  const rows = await db
    .select({ name: groups.name, externalId: groups.externalId, source: groups.source })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(eq(groupMembers.userId, userId));
  const names = new Set([...(person?.signInGroups ?? []), ...rows.map((row) => row.name)]);
  return {
    names: [...names].sort((a, b) => a.localeCompare(b)),
    // Only Keycloak's own group IDs: a SCIM client chooses its externalIds.
    externalIds: rows.flatMap((row) => (row.externalId && row.source === "keycloak" ? [row.externalId] : [])),
  };
}

/** A group path without leading or trailing slashes; case stays. */
export const normalizeGroup = (group: string) => group.trim().replace(/^\/+|\/+$/g, "");
const normalize = normalizeGroup;

/**
 * True when one of `groups` is one of `wanted`, or below it: Keycloak group
 * paths count their subgroups (`/staff` admits `/staff/it`). Leading
 * slashes do not matter; case does.
 */
export function inAnyGroup(groupNames: string[], wanted: string[]): boolean {
  const targets = wanted.map(normalize).filter(Boolean);
  if (targets.length === 0) return false;
  return groupNames
    .map(normalize)
    .some((group) => targets.some((target) => group === target || group.startsWith(`${target}/`)));
}
