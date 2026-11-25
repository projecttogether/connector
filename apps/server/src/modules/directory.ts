import { Hono } from "hono";
import { asc, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import {
  activityListQuerySchema,
  groupCreateSchema,
  type ActivityEntry,
  type Group,
} from "@connector/shared/api/users";
import { config } from "../config";
import { getDb } from "../db/client";
import { activity, groupMembers, groups } from "../db/schema";
import type { AppEnv } from "../http/env";
import { conflict, notFound, validationError } from "../http/errors";
import { idParam, jsonBody, queryOf, requireAdmin } from "../http/middleware";
import { audit } from "../core/audit";
import { escapeLike } from "../db/like";
import { directoryStatus, syncDirectory } from "../directory/sync";

/** Groups, the directory (SCIM, Keycloak) and the activity log (admins). */
const router = new Hono<AppEnv>();

router.get("/admin/groups", async (c) => {
  requireAdmin(c);
  const rows = await getDb()
    .select({
      id: groups.id,
      name: groups.name,
      source: groups.source,
      createdAt: groups.createdAt,
      members: sql<number>`(select count(*)::int from ${groupMembers} m where m.group_id = ${groups.id})`,
    })
    .from(groups)
    .orderBy(asc(groups.name));
  const items: Group[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    source: row.source === "scim" || row.source === "keycloak" ? row.source : "app",
    members: row.members,
    createdAt: row.createdAt.toISOString(),
  }));
  return c.json({ items });
});

/** A group for SCIM clients that only fill existing groups (IAM). */
router.post("/admin/groups", async (c) => {
  const actor = requireAdmin(c);
  const input = await jsonBody(c, groupCreateSchema);
  const [taken] = await getDb().select({ id: groups.id }).from(groups).where(eq(groups.name, input.name));
  if (taken) throw validationError({ name: "A group with this name exists" });
  const [row] = await getDb().transaction(async (tx) => {
    const created = await tx.insert(groups).values({ name: input.name, source: "app" }).returning();
    await audit(tx, actor, {
      action: "group.create",
      entityType: "group",
      entityId: created[0]!.id,
      summary: `Created the group “${input.name}”`,
    });
    return created;
  });
  const body: Group = {
    id: row!.id,
    name: row!.name,
    source: "app",
    members: 0,
    createdAt: row!.createdAt.toISOString(),
  };
  return c.json(body, 201);
});

router.delete("/admin/groups/:id", async (c) => {
  const actor = requireAdmin(c);
  const id = idParam(c);
  const [row] = await getDb().select().from(groups).where(eq(groups.id, id));
  if (!row) throw notFound("No such group");
  if (row.source === "keycloak") throw conflict("This group comes from Keycloak; remove it there");
  await getDb().transaction(async (tx) => {
    await tx.delete(groups).where(eq(groups.id, id));
    await audit(tx, actor, {
      action: "group.delete",
      entityType: "group",
      entityId: id,
      summary: `Removed the group “${row.name}”`,
    });
  });
  return c.body(null, 204);
});

router.get("/admin/directory", async (c) => {
  requireAdmin(c);
  return c.json(await directoryStatus(getDb()));
});

router.post("/admin/directory/sync", async (c) => {
  requireAdmin(c);
  if (config().DIRECTORY !== "keycloak") throw conflict("Set DIRECTORY=keycloak to sync from Keycloak");
  await syncDirectory().catch(() => undefined);
  return c.json(await directoryStatus(getDb()));
});

router.get("/admin/activity", async (c) => {
  requireAdmin(c);
  const query = queryOf(c, activityListQuerySchema);
  const where = query.q
    ? or(
        ilike(activity.actor, `%${escapeLike(query.q)}%`),
        ilike(activity.query, `%${escapeLike(query.q)}%`),
        ilike(activity.client, `%${escapeLike(query.q)}%`),
      )
    : undefined;
  const [rows, [total]] = await Promise.all([
    getDb()
      .select()
      .from(activity)
      .where(where)
      .orderBy(desc(activity.createdAt))
      .limit(query.limit)
      .offset(query.offset),
    getDb().select({ value: count() }).from(activity).where(where),
  ]);
  const items: ActivityEntry[] = rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    actor: row.actor,
    channel:
      row.channel === "token" || row.channel === "oauth" || row.channel === "service" ? row.channel : "web",
    client: row.client,
    action: row.action,
    query: row.query,
    results: row.results,
    sources: row.sources,
    ms: row.ms,
  }));
  return c.json({ items, total: total?.value ?? 0 });
});

export default router;
