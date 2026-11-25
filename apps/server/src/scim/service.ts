import { and, asc, count, eq, ilike, inArray, sql, type SQL } from "drizzle-orm";
import { config } from "../config";
import type { Db, DbOrTx } from "../db/client";
import { escapeLike } from "../db/like";
import { groupMembers, groups, users } from "../db/schema";
import { audit } from "../core/audit";
import { AppError } from "../http/errors";
import { changeEmail, isRemoved, notRemoved, removePerson, setDirectoryActive } from "../people/lifecycle";
import { ScimFilterError, normalizeAttribute, parseFilter, type ScimCondition } from "./filter";

/*
 * SCIM 2.0 resources (RFC 7643): people (`users`) and groups. Identity
 * systems such as IAM create, update, deactivate and remove
 * people, and fill groups. Deactivated people are blocked and their agents
 * revoked; removed people are anonymized like a removal by an admin.
 */

export const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

export class ScimError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 500 | 501,
    readonly detail: string,
    readonly scimType?: string,
  ) {
    super(detail);
    this.name = "ScimError";
  }
}

type UserRow = typeof users.$inferSelect;
type GroupRow = typeof groups.$inferSelect;
type Json = Record<string, unknown>;

const location = (kind: "Users" | "Groups", id: string) => `${config().scimUrl}/${kind}/${id}`;

function splitName(name: string): { givenName: string; familyName: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return { givenName: parts[0] ?? "", familyName: "" };
  return { givenName: parts.slice(0, -1).join(" "), familyName: parts.at(-1)! };
}

export async function userResource(db: DbOrTx, user: UserRow): Promise<Json> {
  const memberOf = await db
    .select({ id: groups.id, name: groups.name })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(eq(groupMembers.userId, user.id))
    .orderBy(asc(groups.name));
  return {
    schemas: [USER_SCHEMA],
    id: user.id,
    ...(user.directorySource === "scim" && user.directoryId ? { externalId: user.directoryId } : {}),
    userName: user.email,
    name: { formatted: user.name, ...splitName(user.name) },
    displayName: user.name,
    ...(user.title ? { title: user.title } : {}),
    active: user.blockedAt === null,
    emails: [{ value: user.email, type: "work", primary: true }],
    groups: memberOf.map((group) => ({
      value: group.id,
      display: group.name,
      $ref: location("Groups", group.id),
    })),
    meta: {
      resourceType: "User",
      created: user.createdAt.toISOString(),
      lastModified: user.updatedAt.toISOString(),
      location: location("Users", user.id),
    },
  };
}

export async function groupResource(db: DbOrTx, group: GroupRow, withMembers = true): Promise<Json> {
  const members = withMembers
    ? await db
        .select({ id: users.id, name: users.name })
        .from(groupMembers)
        .innerJoin(users, eq(users.id, groupMembers.userId))
        .where(eq(groupMembers.groupId, group.id))
        .orderBy(asc(users.name))
    : [];
  return {
    schemas: [GROUP_SCHEMA],
    id: group.id,
    ...(group.externalId && group.source === "scim" ? { externalId: group.externalId } : {}),
    displayName: group.name,
    ...(withMembers
      ? {
          members: members.map((member) => ({
            value: member.id,
            display: member.name,
            $ref: location("Users", member.id),
          })),
        }
      : {}),
    meta: {
      resourceType: "Group",
      created: group.createdAt.toISOString(),
      lastModified: group.updatedAt.toISOString(),
      location: location("Groups", group.id),
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function conditions(filter: string | undefined, map: (condition: ScimCondition) => SQL | null): SQL[] {
  let parsed: ScimCondition[];
  try {
    parsed = parseFilter(filter);
  } catch (error) {
    if (error instanceof ScimFilterError) throw new ScimError(400, error.message, "invalidFilter");
    throw error;
  }
  return parsed.map((condition) => {
    const clause = map(condition);
    if (!clause)
      throw new ScimError(400, `Filtering by ${condition.attribute} is not supported`, "invalidFilter");
    return clause;
  });
}

export async function listUsers(
  db: DbOrTx,
  query: { filter?: string; startIndex: number; count: number },
): Promise<Json> {
  const where = and(
    notRemoved,
    ...conditions(query.filter, ({ attribute, value }) => {
      if (attribute === "username" || attribute === "emails.value" || attribute === "emails") {
        return ilike(users.email, escapeLike(value));
      }
      if (attribute === "externalid")
        return and(eq(users.directorySource, "scim"), eq(users.directoryId, value))!;
      if (attribute === "id") return UUID.test(value) ? eq(users.id, value.toLowerCase()) : sql`false`;
      if (attribute === "active")
        return value === "true" ? sql`${users.blockedAt} is null` : sql`${users.blockedAt} is not null`;
      if (attribute === "displayname") return ilike(users.name, escapeLike(value));
      return null;
    }),
  );
  const [total] = await db.select({ value: count() }).from(users).where(where);
  const rows = await db
    .select()
    .from(users)
    .where(where)
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(query.count)
    .offset(query.startIndex - 1);
  const resources = [];
  for (const row of rows) resources.push(await userResource(db, row));
  return list(resources, total?.value ?? 0, query.startIndex);
}

export async function listGroups(
  db: DbOrTx,
  query: { filter?: string; startIndex: number; count: number; withMembers: boolean },
): Promise<Json> {
  const where = and(
    ...conditions(query.filter, ({ attribute, value }) => {
      if (attribute === "displayname") return eq(groups.name, value);
      if (attribute === "externalid") return eq(groups.externalId, value);
      if (attribute === "id") return UUID.test(value) ? eq(groups.id, value.toLowerCase()) : sql`false`;
      if (attribute === "members.value" || attribute === "members") {
        return UUID.test(value)
          ? sql`exists (select 1 from group_members m where m.group_id = ${groups.id} and m.user_id = ${value.toLowerCase()}::uuid)`
          : sql`false`;
      }
      return null;
    }),
  );
  const [total] = await db.select({ value: count() }).from(groups).where(where);
  const rows = await db
    .select()
    .from(groups)
    .where(where)
    .orderBy(asc(groups.name))
    .limit(query.count)
    .offset(query.startIndex - 1);
  const resources = [];
  for (const row of rows) resources.push(await groupResource(db, row, query.withMembers));
  return list(resources, total?.value ?? 0, query.startIndex);
}

function list(resources: Json[], total: number, startIndex: number): Json {
  return {
    schemas: [LIST_SCHEMA],
    totalResults: total,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

export async function getUser(db: DbOrTx, id: string): Promise<UserRow> {
  if (!UUID.test(id)) throw new ScimError(404, "No such user");
  const [user] = await db.select().from(users).where(eq(users.id, id.toLowerCase()));
  if (!user || isRemoved(user)) throw new ScimError(404, "No such user");
  return user;
}

export async function getGroup(db: DbOrTx, id: string): Promise<GroupRow> {
  if (!UUID.test(id)) throw new ScimError(404, "No such group");
  const [group] = await db.select().from(groups).where(eq(groups.id, id.toLowerCase()));
  if (!group) throw new ScimError(404, "No such group");
  return group;
}

/** The attributes of a User resource that Connector keeps. */
type UserInput = {
  email?: string;
  name?: string;
  title?: string | null;
  active?: boolean;
  externalId?: string | null;
};

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : undefined;

function primaryEmail(emails: unknown): string | undefined {
  if (!Array.isArray(emails)) return undefined;
  const list = emails.filter((item): item is Json => typeof item === "object" && item !== null);
  const chosen =
    list.find((item) => item.primary === true) ?? list.find((item) => item.type === "work") ?? list[0];
  return text(chosen?.value, 320);
}

function nameOf(body: Json): string | undefined {
  const display = text(body.displayName, 200);
  if (display) return display;
  const name = body.name as Json | undefined;
  if (name && typeof name === "object") {
    const formatted = text(name.formatted, 200);
    if (formatted) return formatted;
    const joined = [text(name.givenName, 100), text(name.familyName, 100)].filter(Boolean).join(" ");
    if (joined) return joined;
  }
  return undefined;
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Reads a full User resource (POST, PUT). */
export function readUser(body: Json): UserInput {
  const userName = text(body.userName, 320);
  const email = primaryEmail(body.emails) ?? userName;
  const input: UserInput = {
    email: email?.toLowerCase(),
    name: nameOf(body),
    title: text(body.title, 200) ?? null,
    externalId: text(body.externalId, 200) ?? null,
  };
  if (typeof body.active === "boolean") input.active = body.active;
  return input;
}

async function saveUser(db: Db, user: UserRow, input: UserInput) {
  await db.transaction(async (tx) => {
    const set: Partial<typeof users.$inferInsert> = { directorySource: "scim", updatedAt: new Date() };
    if (input.email && input.email !== user.email) {
      if (!isEmail(input.email))
        throw new ScimError(400, "userName must be an email address", "invalidValue");
      const [taken] = await tx.select({ id: users.id }).from(users).where(eq(users.email, input.email));
      if (taken) throw new ScimError(409, "Another user has this email address", "uniqueness");
      await changeEmail(tx, user, input.email);
    }
    if (input.name !== undefined) set.name = input.name;
    if (input.title !== undefined) set.title = input.title;
    if (input.externalId !== undefined) set.directoryId = input.externalId;
    await tx.update(users).set(set).where(eq(users.id, user.id));
    if (input.active !== undefined) await setDirectoryActive(tx, user.id, input.active);
  });
}

export async function createUser(db: Db, body: Json): Promise<{ user: UserRow; created: boolean }> {
  const input = readUser(body);
  if (!input.email || !isEmail(input.email)) {
    throw new ScimError(400, "userName or a primary email must be an email address", "invalidValue");
  }
  const [existing] = await db.select().from(users).where(eq(users.email, input.email));
  if (existing && !isRemoved(existing)) {
    // Someone who signed in before, or whom Keycloak listed: IAM takes them over.
    if (
      existing.directorySource === "scim" &&
      existing.directoryId &&
      input.externalId &&
      existing.directoryId !== input.externalId
    ) {
      throw new ScimError(409, "A user with this email address exists", "uniqueness");
    }
    await saveUser(db, existing, input);
    return { user: await getUser(db, existing.id), created: false };
  }
  const [user] = await db
    .insert(users)
    .values({
      email: input.email,
      name: input.name ?? input.email,
      title: input.title ?? null,
      directorySource: "scim",
      directoryId: input.externalId ?? null,
    })
    .returning();
  if (input.active === false) await setDirectoryActive(db, user!.id, false);
  await audit(db, null, {
    action: "scim.user_created",
    entityType: "user",
    entityId: user!.id,
    summary: "The directory (SCIM) added a person",
  });
  return { user: await getUser(db, user!.id), created: true };
}

export async function replaceUser(db: Db, id: string, body: Json): Promise<UserRow> {
  const user = await getUser(db, id);
  const input = readUser(body);
  await saveUser(db, user, { ...input, active: input.active ?? true });
  return getUser(db, id);
}

type PatchOperation = { op: string; path?: string; value?: unknown };

function operations(body: Json): PatchOperation[] {
  const list = body.Operations ?? body.operations;
  if (!Array.isArray(list) || list.length === 0) throw new ScimError(400, "Send Operations", "invalidSyntax");
  return list.map((item) => {
    if (typeof item !== "object" || item === null)
      throw new ScimError(400, "Invalid operation", "invalidSyntax");
    const op = String((item as Json).op ?? "").toLowerCase();
    if (!["add", "replace", "remove"].includes(op))
      throw new ScimError(400, `Unknown operation: ${op}`, "invalidSyntax");
    const path = (item as Json).path;
    return { op, path: typeof path === "string" ? path : undefined, value: (item as Json).value };
  });
}

const booleanOf = (value: unknown) =>
  typeof value === "boolean" ? value : typeof value === "string" ? value.toLowerCase() === "true" : undefined;

export async function patchUser(db: Db, id: string, body: Json): Promise<UserRow> {
  const user = await getUser(db, id);
  const input: UserInput = {};
  const apply = (path: string, value: unknown, remove: boolean) => {
    const attribute = normalizeAttribute(path);
    if (attribute === "active") {
      const active = remove ? false : booleanOf(value);
      if (active === undefined) throw new ScimError(400, "active must be true or false", "invalidValue");
      input.active = active;
    } else if (attribute === "username") input.email = remove ? undefined : text(value, 320)?.toLowerCase();
    else if (attribute === "emails" || attribute === "emails.value") {
      const email = Array.isArray(value) ? primaryEmail(value) : text(value, 320);
      if (!remove && email) input.email = email.toLowerCase();
    } else if (attribute === "displayname" || attribute === "name.formatted")
      input.name = remove ? undefined : text(value, 200);
    else if (attribute === "name.givenname" || attribute === "name.familyname") {
      const parts = splitName(input.name ?? user.name);
      const part = text(value, 100) ?? "";
      input.name =
        (attribute === "name.givenname" ? [part, parts.familyName] : [parts.givenName, part])
          .filter(Boolean)
          .join(" ") || user.name;
    } else if (attribute === "name") {
      const name = typeof value === "object" && value !== null ? nameOf({ name: value }) : undefined;
      if (name) input.name = name;
    } else if (attribute === "title") input.title = remove ? null : (text(value, 200) ?? null);
    else if (attribute === "externalid") input.externalId = remove ? null : (text(value, 200) ?? null);
    // Other attributes (phone numbers, addresses, enterprise extension) are not kept.
  };
  for (const operation of operations(body)) {
    if (operation.path) apply(operation.path, operation.value, operation.op === "remove");
    else if (typeof operation.value === "object" && operation.value !== null) {
      for (const [key, value] of Object.entries(operation.value as Json))
        apply(key, value, operation.op === "remove");
    }
  }
  await saveUser(db, user, input);
  return getUser(db, id);
}

export async function deleteUser(db: Db, id: string): Promise<void> {
  const user = await getUser(db, id);
  // removePerson decides under the row lock; an admin from ADMIN_EMAILS stays.
  await removePerson(db, null, user.id).catch((error: unknown) => {
    if (error instanceof AppError && error.code === "environment_admin")
      throw new ScimError(409, error.message);
    throw error;
  });
}

/** Members given as `[{ value: <user id> }]`; unknown IDs are an error. */
async function memberIds(db: DbOrTx, value: unknown): Promise<string[]> {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const ids = list.map((item) => {
    const id = typeof item === "object" && item !== null ? (item as Json).value : item;
    if (typeof id !== "string" || !UUID.test(id))
      throw new ScimError(400, "Members must name users by id", "invalidValue");
    return id.toLowerCase();
  });
  if (ids.length === 0) return [];
  const found = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, ids), notRemoved));
  if (found.length !== new Set(ids).size)
    throw new ScimError(400, "A member is not a known user", "invalidValue");
  return [...new Set(ids)];
}

function assertWritable(group: GroupRow) {
  if (group.source === "keycloak") {
    throw new ScimError(
      400,
      "This group comes from the Keycloak directory and cannot be changed here",
      "mutability",
    );
  }
}

export async function createGroup(db: Db, body: Json): Promise<GroupRow> {
  const name = text(body.displayName, 200);
  if (!name || /[,\n]/.test(name))
    throw new ScimError(400, "displayName is required (no commas)", "invalidValue");
  const [taken] = await db.select({ id: groups.id }).from(groups).where(eq(groups.name, name));
  if (taken) throw new ScimError(409, "A group with this name exists", "uniqueness");
  const ids = await memberIds(db, body.members);
  const group = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(groups)
      .values({ name, source: "scim", externalId: text(body.externalId, 200) ?? null })
      .returning();
    if (ids.length > 0)
      await tx.insert(groupMembers).values(ids.map((userId) => ({ groupId: row!.id, userId })));
    return row!;
  });
  await audit(db, null, {
    action: "scim.group_created",
    entityType: "group",
    entityId: group.id,
    summary: `The directory (SCIM) added the group “${name}”`,
  });
  return group;
}

async function setMembers(tx: DbOrTx, groupId: string, ids: string[]) {
  await tx.delete(groupMembers).where(eq(groupMembers.groupId, groupId));
  if (ids.length > 0) await tx.insert(groupMembers).values(ids.map((userId) => ({ groupId, userId })));
}

async function rename(tx: DbOrTx, group: GroupRow, name: string | undefined) {
  if (!name || name === group.name) return;
  if (/[,\n]/.test(name)) throw new ScimError(400, "displayName must not contain commas", "invalidValue");
  const [taken] = await tx.select({ id: groups.id }).from(groups).where(eq(groups.name, name));
  if (taken) throw new ScimError(409, "A group with this name exists", "uniqueness");
  await tx
    .update(groups)
    .set({ name, updatedAt: sql`now()` })
    .where(eq(groups.id, group.id));
}

export async function replaceGroup(db: Db, id: string, body: Json): Promise<GroupRow> {
  const group = await getGroup(db, id);
  assertWritable(group);
  const ids = await memberIds(db, body.members);
  await db.transaction(async (tx) => {
    await rename(tx, group, text(body.displayName, 200));
    await setMembers(tx, group.id, ids);
    await tx
      .update(groups)
      .set({ externalId: text(body.externalId, 200) ?? group.externalId, updatedAt: sql`now()` })
      .where(eq(groups.id, group.id));
  });
  return getGroup(db, id);
}

/** `members[value eq "<id>"]` → the id. */
function memberInPath(path: string): string | null {
  const match = /^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i.exec(path.trim());
  return match ? match[1]!.toLowerCase() : null;
}

export async function patchGroup(db: Db, id: string, body: Json): Promise<GroupRow> {
  const group = await getGroup(db, id);
  assertWritable(group);
  const ops = operations(body);
  await db.transaction(async (tx) => {
    for (const operation of ops) {
      const path = operation.path ?? "";
      const attribute = normalizeAttribute(path);
      const single = memberInPath(path);
      if (operation.op === "remove" && single) {
        // Members are people by ID: anything else is no member, so nothing goes.
        if (!UUID.test(single)) continue;
        await tx
          .delete(groupMembers)
          .where(and(eq(groupMembers.groupId, group.id), eq(groupMembers.userId, single)));
      } else if (attribute === "members") {
        const ids =
          operation.op === "remove" && operation.value === undefined
            ? null
            : await memberIds(tx, operation.value);
        if (operation.op === "add") {
          if (ids && ids.length > 0) {
            await tx
              .insert(groupMembers)
              .values(ids.map((userId) => ({ groupId: group.id, userId })))
              .onConflictDoNothing();
          }
        } else if (operation.op === "replace") await setMembers(tx, group.id, ids ?? []);
        else if (ids === null) await setMembers(tx, group.id, []);
        else if (ids.length > 0) {
          await tx
            .delete(groupMembers)
            .where(and(eq(groupMembers.groupId, group.id), inArray(groupMembers.userId, ids)));
        }
      } else if (attribute === "displayname") {
        await rename(tx, group, text(operation.value, 200));
      } else if (attribute === "externalid") {
        await tx
          .update(groups)
          .set({ externalId: operation.op === "remove" ? null : (text(operation.value, 200) ?? null) })
          .where(eq(groups.id, group.id));
      } else if (!operation.path && typeof operation.value === "object" && operation.value !== null) {
        const value = operation.value as Json;
        if (value.displayName !== undefined) await rename(tx, group, text(value.displayName, 200));
        if (value.members !== undefined) {
          const ids = await memberIds(tx, value.members);
          if (operation.op === "replace") await setMembers(tx, group.id, ids);
          else if (ids.length > 0) {
            await tx
              .insert(groupMembers)
              .values(ids.map((userId) => ({ groupId: group.id, userId })))
              .onConflictDoNothing();
          }
        }
      } else {
        throw new ScimError(400, `Changing ${path || "this attribute"} is not supported`, "invalidPath");
      }
    }
    await tx
      .update(groups)
      .set({ updatedAt: sql`now()` })
      .where(eq(groups.id, group.id));
  });
  return getGroup(db, id);
}

export async function deleteGroup(db: Db, id: string): Promise<void> {
  const group = await getGroup(db, id);
  assertWritable(group);
  await db.delete(groups).where(eq(groups.id, group.id));
  await audit(db, null, {
    action: "scim.group_deleted",
    entityType: "group",
    entityId: group.id,
    summary: `The directory (SCIM) removed the group “${group.name}”`,
  });
}
