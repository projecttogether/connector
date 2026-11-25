import { sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { groupMembers, groups, sources, users } from "../db/schema";
import { createApp } from "../http/app";
import { issueCredential } from "../auth/credentials";
import { encryptJson } from "../core/crypto";

/** Empties every table between tests. */
export async function resetDatabase() {
  await getDb().execute(sql`
    truncate table activity, items, link_requests, source_links, sources, group_members, groups, oauth_requests,
      oauth_grants, oauth_clients, credentials, audit_log, settings, sessions, accounts, verifications,
      auth_rate_limits, users
      restart identity cascade
  `);
}

/** A person who signed in just now (`lastSignInAt`), unless told otherwise. */
export async function createUser(
  options: {
    email?: string;
    name?: string;
    isAdmin?: boolean;
    lastSignInAt?: Date | null;
    signInGroups?: string[];
    title?: string | null;
  } = {},
) {
  const email = options.email ?? `person-${Math.random().toString(36).slice(2, 8)}@example.org`;
  const [user] = await getDb()
    .insert(users)
    .values({
      email,
      name: options.name ?? email.split("@")[0]!,
      isAdmin: options.isAdmin ?? false,
      adminSource: options.isAdmin ? "app" : null,
      lastSignInAt: options.lastSignInAt === undefined ? new Date() : options.lastSignInAt,
      signInGroups: options.signInGroups ?? [],
      title: options.title ?? null,
    })
    .returning();
  return user!;
}

/** A source, stored as an admin would connect it. */
export async function createSource(input: {
  kind: "handbook" | "logbook" | "library" | "crm";
  slug?: string;
  name?: string;
  config: Record<string, unknown>;
  secret?: Record<string, string>;
  accessGroups?: string[];
  serviceAccess?: boolean;
  enabled?: boolean;
}) {
  const [row] = await getDb()
    .insert(sources)
    .values({
      kind: input.kind,
      slug: input.slug ?? input.kind,
      name: input.name ?? input.kind,
      config: input.config,
      secretEncrypted: input.secret ? encryptJson(input.secret) : null,
      accessGroups: input.accessGroups ?? [],
      serviceAccess: input.serviceAccess ?? false,
      enabled: input.enabled ?? true,
    })
    .returning();
  return row!;
}

/** A directory group with members. */
export async function createGroup(
  name: string,
  memberIds: string[] = [],
  options: { source?: string; externalId?: string } = {},
) {
  const [group] = await getDb()
    .insert(groups)
    .values({ name, source: options.source ?? "app", externalId: options.externalId ?? null })
    .returning();
  for (const userId of memberIds) await getDb().insert(groupMembers).values({ groupId: group!.id, userId });
  return group!;
}

/** A service or SCIM token; returns the secret. */
export async function createAdminToken(kind: "service" | "scim", name = "Test token") {
  const { secret } = await issueCredential(getDb(), { kind, name, userId: null, expiresAt: null });
  return secret;
}

/** A personal access token (agent) of a person; returns the secret. */
export async function createToken(userId: string, name = "Test agent") {
  const { secret } = await issueCredential(getDb(), {
    kind: "personal",
    name,
    userId,
    createdById: userId,
    expiresAt: null,
  });
  return secret;
}

let app: ReturnType<typeof createApp> | undefined;

export function testApp() {
  app ??= createApp();
  return app;
}

/**
 * A request to the app as `userId` in the web app (the test resolver in API
 * tests reads the x-test-user header), or with a bearer `token`. JSON bodies
 * are sent with the app's origin.
 */
export async function request(
  method: string,
  path: string,
  options: {
    userId?: string;
    token?: string;
    body?: unknown;
    form?: FormData;
    headers?: Record<string, string>;
  } = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are read loosely
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = {
    origin: "http://localhost:3000",
    accept: "application/json",
    ...options.headers,
  };
  if (options.userId) headers["x-test-user"] = options.userId;
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await testApp().request(path, {
    method,
    headers,
    body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const type = response.headers.get("content-type") ?? "";
  const text = await response.text();
  return {
    status: response.status,
    body: text && type.includes("json") ? JSON.parse(text) : text,
    headers: response.headers,
  };
}
