import { Hono } from "hono";
import {
  contextRequestSchema,
  knowledgeSearchSchema,
  recentQuerySchema,
  searchQuerySchema,
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  type KnowledgeResponse,
} from "@connector/shared/api/search";
import { colleagueQuerySchema } from "@connector/shared/api/users";
import { MAX_KNOWLEDGE_TEXT } from "@connector/shared/limits";
import { getDb } from "../db/client";
import type { AppEnv } from "../http/env";
import { jsonBody, queryOf, requirePrincipal, requireUser } from "../http/middleware";
import { buildContext, fetchItem, federatedSearch, logActivity, recentChanges } from "../search/federate";
import { findColleagues } from "../directory/people";
import { sourceSummaries } from "../sources/service";

/**
 * Reading across sources: search, one item, context for a topic, recent
 * changes, the people directory, and the knowledge API for bots. Every
 * route checks which sources the caller may use (docs/identity-and-access.md).
 */
const router = new Hono<AppEnv>();

const plain = (text: string) => text.replaceAll(HIGHLIGHT_START, "").replaceAll(HIGHLIGHT_END, "");

router.get("/sources", async (c) => {
  const principal = requirePrincipal(c);
  return c.json({ items: await sourceSummaries(getDb(), principal) });
});

router.get("/search", async (c) => {
  const principal = requirePrincipal(c);
  return c.json(await federatedSearch(getDb(), principal, queryOf(c, searchQuerySchema)));
});

// IDs contain colons (`handbook:page:…`); the rest of the path is the ID.
router.get("/items/:id{.+}", async (c) => {
  const principal = requirePrincipal(c);
  return c.json(await fetchItem(getDb(), principal, c.req.param("id")));
});

router.post("/context", async (c) => {
  const principal = requirePrincipal(c);
  return c.json(await buildContext(getDb(), principal, await jsonBody(c, contextRequestSchema)));
});

router.get("/recent", async (c) => {
  const principal = requirePrincipal(c);
  return c.json(await recentChanges(getDb(), principal, queryOf(c, recentQuerySchema)));
});

router.get("/people", async (c) => {
  const principal = requireUser(c);
  const query = queryOf(c, colleagueQuerySchema);
  const started = performance.now();
  const items = await findColleagues(getDb(), query.q, query.limit);
  await logActivity(getDb(), principal, {
    action: "people",
    query: query.q,
    results: items.length,
    sources: [],
    ms: Math.round(performance.now() - started),
  });
  return c.json({ items });
});

/**
 * The knowledge source contract of the Support Agent: POST
 * { query, limit } with a service token, answer { results: [{ title, url,
 * text, section }] }, best first (docs/agents.md, "Bots").
 */
router.post("/knowledge/search", async (c) => {
  const principal = requirePrincipal(c);
  const input = await jsonBody(c, knowledgeSearchSchema);
  const response = await federatedSearch(
    getDb(),
    principal,
    { q: input.query, limit: input.limit, sources: undefined },
    "knowledge",
  );
  // Bots answer from the text: each result's item, else its snippet.
  const items = await Promise.all(
    response.results.map((result) =>
      fetchItem(getDb(), principal, result.id, { log: false }).catch(() => null),
    ),
  );
  const body: KnowledgeResponse = {
    results: response.results.map((result, index) => ({
      title: result.title,
      url: result.url,
      text: (items[index]?.text || plain(result.snippet) || result.title).slice(0, MAX_KNOWLEDGE_TEXT),
      section: `${result.source.name}${result.status ? ` · ${result.status}` : ""}`,
    })),
  };
  return c.json(body);
});

export default router;
