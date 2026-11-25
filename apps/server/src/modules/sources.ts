import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { sourceCreateSchema, sourceUpdateSchema, type Link } from "@connector/shared/api/sources";
import { getDb } from "../db/client";
import { sourceLinks, sources } from "../db/schema";
import type { AppEnv } from "../http/env";
import { notFound } from "../http/errors";
import { idParam, jsonBody, requireAdmin, requireWebUser } from "../http/middleware";
import { logger } from "../logger";
import { finishLink, mayLink, startLink, unlink } from "../sources/links";
import { checkSource } from "../sources/health";
import { listHandbookSpaces } from "../sources/spaces";
import {
  createSource,
  deleteSource,
  getSource,
  listSources,
  rotateWebhookSecret,
  sourceBySlug,
  sourceView,
  updateSource,
} from "../sources/service";
import { SourceError } from "../sources/types";

/** Sources (admins) and linked accounts (everyone in the web app). */
const router = new Hono<AppEnv>();

router.get("/admin/sources", async (c) => {
  requireAdmin(c);
  return c.json({ items: await listSources(getDb()) });
});

router.post("/admin/sources", async (c) => {
  const actor = requireAdmin(c);
  return c.json(await createSource(getDb(), actor, await jsonBody(c, sourceCreateSchema)), 201);
});

router.get("/admin/sources/:id", async (c) => {
  requireAdmin(c);
  return c.json(await sourceView(getDb(), await getSource(getDb(), idParam(c))));
});

router.patch("/admin/sources/:id", async (c) => {
  const actor = requireAdmin(c);
  return c.json(await updateSource(getDb(), actor, idParam(c), await jsonBody(c, sourceUpdateSchema)));
});

router.delete("/admin/sources/:id", async (c) => {
  const actor = requireAdmin(c);
  await deleteSource(getDb(), actor, idParam(c));
  return c.body(null, 204);
});

router.post("/admin/sources/:id/check", async (c) => {
  requireAdmin(c);
  return c.json(await checkSource(getDb(), idParam(c)));
});

/** Handbook's spaces, for choosing the rule spaces (setup guide). */
router.get("/admin/sources/:id/spaces", async (c) => {
  requireAdmin(c);
  return c.json(await listHandbookSpaces(getDb(), idParam(c)));
});

router.post("/admin/sources/:id/webhook-secret", async (c) => {
  const actor = requireAdmin(c);
  return c.json(await rotateWebhookSecret(getDb(), actor, idParam(c)));
});

router.get("/links", async (c) => {
  const principal = requireWebUser(c);
  const rows = await getDb()
    .select({ link: sourceLinks, slug: sources.slug, name: sources.name })
    .from(sourceLinks)
    .innerJoin(sources, eq(sources.id, sourceLinks.sourceId))
    .where(eq(sourceLinks.userId, principal.id))
    .orderBy(desc(sourceLinks.createdAt));
  const items: Link[] = rows.map((row) => ({
    source: row.slug,
    sourceName: row.name,
    label: row.link.label,
    createdAt: row.link.createdAt.toISOString(),
  }));
  return c.json({ items });
});

router.post("/links/:slug", async (c) => {
  const principal = requireWebUser(c);
  const source = await sourceBySlug(getDb(), c.req.param("slug"));
  if (!source || !mayLink(principal, source)) throw notFound("This source does not take linked accounts");
  try {
    return c.json({ authorizeUrl: await startLink(getDb(), source, principal.id) });
  } catch (error) {
    if (error instanceof SourceError) throw notFound(error.message);
    throw error;
  }
});

/** The way back from the source's consent screen (a browser redirect). */
router.get("/links/callback", async (c) => {
  const principal = requireWebUser(c);
  try {
    const slug = await finishLink(getDb(), principal, {
      code: c.req.query("code"),
      state: c.req.query("state"),
      error: c.req.query("error"),
      iss: c.req.query("iss"),
    });
    return c.redirect(`/settings?linked=${encodeURIComponent(slug)}`, 302);
  } catch (error) {
    const message = error instanceof SourceError ? error.message : "Linking failed";
    if (!(error instanceof SourceError)) logger.error({ err: error }, "linking failed");
    return c.redirect(`/settings?link_error=${encodeURIComponent(message)}`, 302);
  }
});

router.delete("/links/:slug", async (c) => {
  const principal = requireWebUser(c);
  const source = await sourceBySlug(getDb(), c.req.param("slug"));
  const [link] = source
    ? await getDb()
        .select({ id: sourceLinks.id })
        .from(sourceLinks)
        .where(and(eq(sourceLinks.sourceId, source.id), eq(sourceLinks.userId, principal.id)))
    : [];
  if (!source || !link) throw notFound("No such linked account");
  await unlink(getDb(), source, principal.id);
  return c.body(null, 204);
});

export default router;
