import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { tokenCreateSchema, type ConnectedApp, type ConnectInfo } from "@connector/shared/api/tokens";
import { config } from "../config";
import { getDb } from "../db/client";
import { credentials, oauthClients, oauthGrants } from "../db/schema";
import type { AppEnv } from "../http/env";
import { notFound } from "../http/errors";
import { idParam, jsonBody, requireAdmin, requireUser, requireWebUser } from "../http/middleware";
import { createAdminToken, listAdminTokens, revokeAdminToken } from "../auth/admin-tokens";
import { expiryIn, issueCredential, tokenView } from "../auth/credentials";
import { decideRequest, describeRequest, revokeGrantTokens } from "../oauth/flow";

/**
 * Credentials of agents: personal tokens, connected apps (OAuth grants),
 * the consent screen's API, and service and SCIM tokens (admins).
 */
const router = new Hono<AppEnv>();

const iso = (value: Date | null) => (value ? value.toISOString() : null);

router.get("/tokens", async (c) => {
  const principal = requireWebUser(c);
  const rows = await getDb()
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.userId, principal.id),
        eq(credentials.kind, "personal"),
        isNull(credentials.revokedAt),
      ),
    )
    .orderBy(desc(credentials.createdAt));
  return c.json({ items: rows.map(tokenView) });
});

router.post("/tokens", async (c) => {
  const principal = requireWebUser(c);
  const input = await jsonBody(c, tokenCreateSchema);
  const { id, secret } = await issueCredential(getDb(), {
    kind: "personal",
    name: input.name,
    userId: principal.id,
    createdById: principal.id,
    expiresAt: expiryIn(input.expiresInDays),
  });
  const [row] = await getDb().select().from(credentials).where(eq(credentials.id, id));
  return c.json({ ...tokenView(row!), secret }, 201);
});

router.delete("/tokens/:id", async (c) => {
  const principal = requireWebUser(c);
  const [row] = await getDb()
    .update(credentials)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(credentials.id, idParam(c)),
        eq(credentials.userId, principal.id),
        eq(credentials.kind, "personal"),
        isNull(credentials.revokedAt),
      ),
    )
    .returning({ id: credentials.id });
  if (!row) throw notFound("No such token");
  return c.body(null, 204);
});

router.get("/connected-apps", async (c) => {
  const principal = requireWebUser(c);
  const rows = await getDb()
    .select({ grant: oauthGrants, clientName: oauthClients.name })
    .from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
    .where(and(eq(oauthGrants.userId, principal.id), isNull(oauthGrants.revokedAt)))
    .orderBy(desc(oauthGrants.createdAt));
  const items: ConnectedApp[] = rows.map((row) => {
    let redirectHost = row.grant.redirectUri;
    try {
      redirectHost = new URL(row.grant.redirectUri).host || row.grant.redirectUri;
    } catch {
      // Keep the URI as written.
    }
    return {
      id: row.grant.id,
      clientName: row.clientName,
      redirectHost,
      createdAt: row.grant.createdAt.toISOString(),
      lastUsedAt: iso(row.grant.lastUsedAt),
    };
  });
  return c.json({ items });
});

router.delete("/connected-apps/:id", async (c) => {
  const principal = requireWebUser(c);
  const id = idParam(c);
  await getDb().transaction(async (tx) => {
    const [grant] = await tx
      .select({ id: oauthGrants.id })
      .from(oauthGrants)
      .where(
        and(eq(oauthGrants.id, id), eq(oauthGrants.userId, principal.id), isNull(oauthGrants.revokedAt)),
      );
    if (!grant) throw notFound("No such connected app");
    await revokeGrantTokens(tx, grant.id, { grant: true });
  });
  return c.body(null, 204);
});

router.get("/connect-info", (c) => {
  requireUser(c);
  const body: ConnectInfo = { appUrl: config().APP_URL, mcpUrl: config().mcpUrl };
  return c.json(body);
});

router.get("/oauth/requests/:id", async (c) => {
  const principal = requireWebUser(c);
  return c.json(await describeRequest(getDb(), principal, idParam(c)));
});

router.post("/oauth/requests/:id/approve", async (c) => {
  const principal = requireWebUser(c);
  return c.json({ redirectUrl: await decideRequest(getDb(), principal, idParam(c), true) });
});

router.post("/oauth/requests/:id/deny", async (c) => {
  const principal = requireWebUser(c);
  return c.json({ redirectUrl: await decideRequest(getDb(), principal, idParam(c), false) });
});

/** Admin tokens: service tokens (bots) and SCIM tokens (identity systems). */
const ADMIN_TOKENS = [
  { kind: "service", path: "/admin/service-tokens" },
  { kind: "scim", path: "/admin/scim-tokens" },
] as const;

for (const { kind, path } of ADMIN_TOKENS) {
  router.get(path, async (c) => {
    requireAdmin(c);
    return c.json({ items: await listAdminTokens(getDb(), kind) });
  });

  router.post(path, async (c) => {
    const actor = requireAdmin(c);
    const input = await jsonBody(c, tokenCreateSchema);
    return c.json(await createAdminToken(getDb(), actor, kind, input), 201);
  });

  router.delete(`${path}/:id`, async (c) => {
    const actor = requireAdmin(c);
    await revokeAdminToken(getDb(), actor, kind, idParam(c));
    return c.body(null, 204);
  });
}

export default router;
