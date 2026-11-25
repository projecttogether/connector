import { and, asc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import type { Colleague } from "@connector/shared/api/users";
import type { Db } from "../db/client";
import { groupMembers, groups, users } from "../db/schema";
import { escapeLike } from "../db/like";
import { notRemoved } from "../people/lifecycle";

/**
 * The people directory for people and agents: colleagues by name, email
 * address, job title or group, from sign-ins, SCIM (e.g. IAM)
 * and the Keycloak directory. Blocked and removed people are left out.
 */
export async function findColleagues(db: Db, q: string, limit: number): Promise<Colleague[]> {
  const pattern = `%${escapeLike(q)}%`;
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      title: users.title,
      signInGroups: users.signInGroups,
    })
    .from(users)
    .where(
      and(
        isNull(users.blockedAt),
        notRemoved,
        or(
          ilike(users.name, pattern),
          ilike(users.email, pattern),
          ilike(users.title, pattern),
          sql`exists (select 1 from unnest(${users.signInGroups}) as g(name) where g.name ilike ${pattern})`,
          sql`exists (select 1 from ${groupMembers} m join ${groups} g on g.id = m.group_id where m.user_id = ${users.id} and g.name ilike ${pattern})`,
        ),
      ),
    )
    .orderBy(asc(users.name))
    .limit(limit);
  const result: Colleague[] = [];
  for (const row of rows) {
    const member = await db
      .select({ name: groups.name })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .where(eq(groupMembers.userId, row.id));
    result.push({
      name: row.name || row.email,
      email: row.email,
      title: row.title,
      groups: [...new Set([...row.signInGroups, ...member.map((item) => item.name)])].sort((a, b) =>
        a.localeCompare(b),
      ),
    });
  }
  return result;
}
