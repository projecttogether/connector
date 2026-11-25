import { lt, sql } from "drizzle-orm";
import type {
  ContextRequest,
  ContextResponse,
  Item,
  RecentQuery,
  RecentResponse,
  SearchQuery,
  SearchResponse,
  SearchResult,
  SourceOutcome,
} from "@connector/shared/api/search";
import {
  AUTHORITIES,
  AUTHORITY_DESCRIPTIONS,
  AUTHORITY_LABELS,
  authorityRank,
  formatItemId,
  parseItemId,
} from "@connector/shared/sources";
import { config } from "../config";
import type { Db, DbOrTx } from "../db/client";
import { activity } from "../db/schema";
import type { Principal } from "../auth/principal";
import { AppError, notFound } from "../http/errors";
import { logger } from "../logger";
import { kindOf, sourceBySlug } from "../sources/service";
import type { FetchedItem, Hit, SourceRow } from "../sources/types";
import { useSource, useSources } from "../sources/use";

/*
 * Federated reads (docs/architecture.md, "Search"): every source the caller
 * may use is asked at the same time, each within SOURCE_TIMEOUT_SECONDS.
 * A source that fails or is slow is reported, never fatal. Results are
 * merged round-robin by each source's own ranking, and within a round by
 * the source order (rules, decisions, knowledge base, history, records,
 * library), so every source's best answers come first and the stronger
 * source wins ties.
 */

const sourceRef = (row: SourceRow) => ({ slug: row.slug, name: row.name, kind: kindOf(row) });

function toResult(row: SourceRow, hit: Hit): SearchResult {
  return {
    id: formatItemId({ source: row.slug, type: hit.type, externalId: hit.externalId }),
    title: hit.title,
    url: hit.url,
    snippet: hit.snippet,
    type: hit.type,
    source: sourceRef(row),
    authority: hit.authority,
    date: hit.date,
    status: hit.status,
  };
}

function toItem(row: SourceRow, item: FetchedItem): Item {
  return {
    id: formatItemId({ source: row.slug, type: item.type, externalId: item.externalId }),
    title: item.title,
    url: item.url,
    type: item.type,
    source: sourceRef(row),
    authority: item.authority,
    date: item.date,
    status: item.status,
    text: item.text,
    metadata: item.metadata,
    related: item.related,
  };
}

/** Round-robin by rank within each source; within a round, the source order decides. */
export function mergeResults(lists: SearchResult[][], limit: number): SearchResult[] {
  const ranked = lists.flatMap((list, sourceIndex) =>
    list.map((result, rank) => ({ result, rank, sourceIndex })),
  );
  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      authorityRank(a.result.authority) - authorityRank(b.result.authority) ||
      a.sourceIndex - b.sourceIndex,
  );
  return ranked.slice(0, limit).map((entry) => entry.result);
}

export type ActivityInput = {
  action: string;
  query: string | null;
  results: number;
  /** The outcomes as the log keeps them: Connector's own words (`logged` of source use). */
  sources: SourceOutcome[];
  ms: number;
};

/**
 * Records what an agent, token or bot asked (oversight). Searches in the
 * web app are not recorded. ACTIVITY_LOG_DAYS=0 records nothing.
 */
export async function logActivity(db: DbOrTx, principal: Principal, entry: ActivityInput) {
  if (config().ACTIVITY_LOG_DAYS === 0) return;
  if (principal.kind === "user" && principal.channel === "web") return;
  await db
    .insert(activity)
    .values({
      userId: principal.kind === "user" ? principal.id : null,
      credentialId: principal.credentialId,
      actor: principal.kind === "user" ? principal.name || principal.email : principal.name,
      channel: principal.kind === "user" ? principal.channel : "service",
      client: principal.kind === "user" ? principal.clientName : null,
      action: entry.action,
      query: entry.query?.slice(0, 500) ?? null,
      results: entry.results,
      sources: entry.sources.map((source) => ({
        slug: source.slug,
        ok: source.ok,
        count: source.count,
        ...(source.error ? { error: source.error.slice(0, 300) } : {}),
      })),
      ms: entry.ms,
    })
    .catch((error: unknown) => logger.warn({ err: error }, "could not record activity"));
}

export async function pruneActivity(db: DbOrTx, days = config().ACTIVITY_LOG_DAYS): Promise<number> {
  const result =
    days === 0
      ? await db.delete(activity)
      : await db.delete(activity).where(lt(activity.createdAt, sql`now() - make_interval(days => ${days})`));
  return result.rowCount ?? 0;
}

export async function federatedSearch(
  db: Db,
  principal: Principal,
  query: SearchQuery,
  action = "search",
): Promise<SearchResponse> {
  const started = performance.now();
  const { answers, outcomes, logged } = await useSources(db, principal, query.sources, (adapter, context) =>
    adapter.search(context, query.q, query.limit),
  );
  const results = mergeResults(
    answers.map(({ row, value }) => value.map((hit) => toResult(row, hit))),
    query.limit,
  );
  await logActivity(db, principal, {
    action,
    query: query.q,
    results: results.length,
    sources: logged,
    ms: Math.round(performance.now() - started),
  });
  return { query: query.q, results, sources: outcomes };
}

/** One item by its ID; 404 when the source is unknown, closed to the caller, or has no such item. */
export async function fetchItem(
  db: Db,
  principal: Principal,
  id: string,
  options: { log?: boolean } = {},
): Promise<Item> {
  const started = performance.now();
  const ref = parseItemId(id);
  if (!ref) throw notFound("Use an ID from search results, e.g. handbook:page:…");
  const row = await sourceBySlug(db, ref.source);
  const use = row
    ? await useSource(db, principal, row, (adapter, context) =>
        adapter.fetch(context, ref.type, ref.externalId),
      )
    : null;
  if (!row || !use) throw notFound("No such item");
  if (options.log !== false)
    await logActivity(db, principal, {
      action: "fetch",
      query: id,
      results: use.outcome.count,
      sources: [use.logged],
      ms: Math.round(performance.now() - started),
    });
  if (!use.ok) throw new AppError(502, "source_failed", use.error.message);
  if (!use.value) throw notFound("No such item");
  return toItem(row, use.value);
}

const day = (value: string | null) => (value ? value.slice(0, 10) : "unknown date");

/**
 * Everything about a topic, by the source order, with hints: decisions in
 * force that are newer than knowledge base pages on the same topic (rule
 * pages stand above decisions), and replaced decisions.
 */
export async function buildContext(
  db: Db,
  principal: Principal,
  request: ContextRequest,
): Promise<ContextResponse> {
  const started = performance.now();
  const { answers, outcomes, logged } = await useSources(
    db,
    principal,
    request.sources,
    async (adapter, context) => {
      const hits = await adapter.search(context, request.topic, request.perSource);
      // Live results without a date (Handbook pages): read their date, for the hints.
      return Promise.all(
        hits.map(async (hit) => {
          if (hit.date || hit.authority !== "knowledge") return hit;
          const item = await adapter.fetch(context, hit.type, hit.externalId).catch(() => null);
          return item ? { ...hit, date: item.date } : hit;
        }),
      );
    },
  );
  const all = answers.flatMap(({ row, value }) => value.map((hit) => toResult(row, hit)));
  const sections = AUTHORITIES.map((authority) => ({
    authority,
    label: AUTHORITY_LABELS[authority],
    description: AUTHORITY_DESCRIPTIONS[authority],
    items: all
      .filter((result) => result.authority === authority)
      .sort((a, b) =>
        authority === "decision" || authority === "history" ? (b.date ?? "").localeCompare(a.date ?? "") : 0,
      ),
  })).filter((section) => section.items.length > 0);

  const notes: string[] = [];
  const decisions = all.filter((result) => result.authority === "decision");
  // Rule pages stand above decisions (source order): only knowledge base pages yield.
  const pages = all.filter((result) => result.authority === "knowledge");
  for (const decision of decisions) {
    for (const page of pages) {
      if (decision.date && page.date && decision.date > page.date) {
        notes.push(
          `The decision “${decision.title}” (${day(decision.date)}) is newer than the page “${page.title}” (last changed ${day(page.date)}). Where they disagree, the decision wins: say so, and suggest updating the page.`,
        );
      }
    }
  }
  for (const replaced of all.filter((result) => result.status?.startsWith("superseded by"))) {
    notes.push(`“${replaced.title}” is ${replaced.status}: rely on the newer decision.`);
  }
  for (const outcome of outcomes.filter((item) => !item.ok)) {
    notes.push(`${outcome.name} did not answer (${outcome.error}); its content is missing here.`);
  }
  if (all.length === 0) notes.push("No source has anything on this topic that you may see.");
  await logActivity(db, principal, {
    action: "context",
    query: request.topic,
    results: all.length,
    sources: logged,
    ms: Math.round(performance.now() - started),
  });
  return { topic: request.topic, sections, notes: notes.slice(0, 20), sources: outcomes };
}

export async function recentChanges(
  db: Db,
  principal: Principal,
  query: RecentQuery,
): Promise<RecentResponse> {
  const started = performance.now();
  const since = new Date(Date.now() - query.days * 86_400_000);
  const { answers, outcomes, logged } = await useSources(db, principal, query.sources, (adapter, context) =>
    adapter.recent(context, since, query.limit),
  );
  const results = answers
    .flatMap(({ row, value }) => value.map((hit) => toResult(row, hit)))
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    .slice(0, query.limit);
  await logActivity(db, principal, {
    action: "recent",
    query: `${query.days} days`,
    results: results.length,
    sources: logged,
    ms: Math.round(performance.now() - started),
  });
  return { items: results, sources: outcomes };
}
