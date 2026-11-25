import { and, desc, eq, gte, inArray, notInArray, sql, type SQL } from "drizzle-orm";
import { HIGHLIGHT_END, HIGHLIGHT_START } from "@connector/shared/api/search";
import { MAX_ITEM_TEXT, MAX_SNIPPET } from "@connector/shared/limits";
import type { Authority, SourceKind } from "@connector/shared/sources";
import { config } from "../config";
import { getSetting, putSetting } from "../core/settings";
import { logger } from "../logger";
import type { DbOrTx } from "../db/client";
import { items } from "../db/schema";
import type { Principal } from "../auth/principal";
import { normalizeGroup } from "../directory/groups";
import {
  SourceError,
  type Adapter,
  type AdapterContext,
  type FetchedItem,
  type Hit,
  type SourceRow,
} from "./types";

/*
 * The index of webhook sources: what Logbook, Library and the IT Knowledge
 * Base sent, searchable
 * with PostgreSQL full-text search in SEARCH_LANGUAGES. Each item says who
 * may see it inside its source (`visibility`); service tokens see only
 * items meant for everyone.
 */

export type IndexedItem = {
  externalId: string;
  type: string;
  ref: string | null;
  title: string;
  url: string;
  summary: string;
  body: string;
  status: string | null;
  inForce: boolean | null;
  metadata: Record<string, unknown>;
  related: { ref: string; relation: string }[];
  visibility: "all" | "groups";
  /** `group:<group path>`, `team:<name>` and `kc:<Keycloak group ID>` entries. */
  visibilityGroups: string[];
  occurredAt: Date | null;
  changedAt: Date | null;
};

function searchVector(parts: { text: string; weight: "A" | "B" | "C" }[]): SQL {
  const vectors: SQL[] = [];
  for (const language of config().searchConfigs) {
    for (const part of parts) {
      vectors.push(sql`setweight(to_tsvector(${language}::regconfig, ${part.text}), ${part.weight})`);
    }
  }
  return sql.join(vectors, sql` || `);
}

function tsQuery(text: string): SQL {
  return sql.join(
    config().searchConfigs.map((language) => sql`websearch_to_tsquery(${language}::regconfig, ${text})`),
    sql` || `,
  );
}

/** Title and reference first, then summary and facts, then the whole text. */
function itemVector(item: Pick<IndexedItem, "ref" | "title" | "summary" | "metadata" | "body">): SQL {
  return searchVector([
    { text: `${item.ref ?? ""} ${item.title}`, weight: "A" },
    {
      text: `${item.summary} ${Object.values(item.metadata)
        .flat()
        .filter((value) => typeof value === "string")
        .join(" ")}`,
      weight: "B",
    },
    { text: item.body.slice(0, 200_000), weight: "C" },
  ]);
}

/**
 * Rebuilds the search data of every item when SEARCH_LANGUAGES changed since
 * it was built; one item per statement, so deliveries go on meanwhile.
 */
export async function reindexIfLanguagesChanged(db: DbOrTx) {
  const wanted = config().searchConfigs.join(",");
  const stored = await getSetting(db, "search");
  if (stored?.languages === wanted) return;
  const rows = await db.select({ id: items.id }).from(items);
  for (const { id } of rows) {
    const [row] = await db.select().from(items).where(eq(items.id, id));
    if (row)
      await db
        .update(items)
        .set({ searchVector: itemVector(row) })
        .where(eq(items.id, id));
  }
  await putSetting(db, "search", { languages: wanted });
  if (stored)
    logger.info({ languages: wanted, count: rows.length }, "search index rebuilt for new languages");
}

/** Stores an item as the app sent it, replacing what Connector had. */
export async function upsertItem(db: DbOrTx, sourceId: string, item: IndexedItem) {
  const vector = itemVector(item);
  const values = {
    sourceId,
    externalId: item.externalId,
    type: item.type,
    ref: item.ref,
    title: item.title,
    url: item.url,
    summary: item.summary,
    body: item.body.slice(0, MAX_ITEM_TEXT),
    status: item.status,
    inForce: item.inForce,
    metadata: item.metadata,
    related: item.related,
    visibility: item.visibility,
    visibilityGroups: item.visibilityGroups,
    occurredAt: item.occurredAt,
    changedAt: item.changedAt,
    searchVector: vector,
  };
  await db
    .insert(items)
    .values(values)
    .onConflictDoUpdate({
      target: [items.sourceId, items.externalId],
      set: { ...values, updatedAt: sql`now()` },
    });
}

/** Removes the items of a source that are not in `keep`; returns how many. */
export async function removeItemsExcept(db: DbOrTx, sourceId: string, keep: string[]): Promise<number> {
  const removed = await db
    .delete(items)
    .where(and(eq(items.sourceId, sourceId), notInArray(items.externalId, keep)))
    .returning({ id: items.id });
  return removed.length;
}

/** Removes an item; true when Connector had it. */
export async function removeItem(db: DbOrTx, sourceId: string, externalId: string): Promise<boolean> {
  const removed = await db
    .delete(items)
    .where(and(eq(items.sourceId, sourceId), eq(items.externalId, externalId)))
    .returning({ id: items.id });
  return removed.length > 0;
}

/**
 * The visibility keys of a caller: `group:<path>` for each of their groups
 * (exactly that group, not its subgroups), `kc:<id>` for their Keycloak
 * groups, and `team:<name>` for their groups below `teamPrefix`
 * (`/teams/Programs` with the prefix `/teams` is the team "Programs").
 * Service tokens have none.
 */
export function visibilityKeys(principal: Principal, teamPrefix: string | null = null): string[] {
  if (principal.kind === "service") return [];
  const keys = [
    ...principal.groups.map((group) => `group:${normalizeGroup(group)}`),
    ...principal.groupIds.map((id) => `kc:${id}`),
  ];
  const prefix = teamPrefix?.trim().replace(/^\/+|\/+$/g, "");
  if (prefix) {
    for (const group of principal.groups) {
      const name = group.replace(/^\/+|\/+$/g, "");
      if (name.startsWith(`${prefix}/`)) keys.push(`team:${name.slice(prefix.length + 1)}`);
    }
  }
  return keys;
}

/** Items for everyone, and items for one of the caller's keys. */
function visible(keys: string[]): SQL {
  if (keys.length === 0) return sql`${items.visibility} = 'all'`;
  const array = sql`array[${sql.join(
    keys.map((key) => sql`${key}`),
    sql`, `,
  )}]::text[]`;
  return sql`(${items.visibility} = 'all' or ${items.visibilityGroups} && ${array})`;
}

type Row = typeof items.$inferSelect;

const iso = (value: Date | null) => (value ? value.toISOString() : null);

function snippetOf(text: string) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SNIPPET ? `${flat.slice(0, MAX_SNIPPET - 1)}…` : flat;
}

/**
 * An index adapter for a webhook kind; `authorityOf` places items in the
 * source order (with the source's settings as they are now); `teamPrefix`
 * reads the team group prefix from the source's settings (Library).
 */
export function indexAdapter(
  kind: SourceKind,
  authorityOf: (row: Row, config: Record<string, unknown>) => Authority,
  options: {
    teamPrefix?: (config: Record<string, unknown>) => string | null;
    /** Whether the caller's groups count inside the source; returning `false` limits them to items for everyone. */
    groupsCount?: (principal: Principal, source: SourceRow) => boolean;
    /** The keys of service tokens in the source; without, they see only items for everyone. */
    serviceKeys?: (source: SourceRow) => string[];
  } = {},
): Adapter {
  const teamPrefix = (config: Record<string, unknown>) => options.teamPrefix?.(config) ?? null;
  const visibleTo = ({ principal, source, config }: AdapterContext) => {
    if (principal.kind === "service") return visible(options.serviceKeys?.(source) ?? []);
    if (options.groupsCount && !options.groupsCount(principal, source)) return visible([]);
    return visible(visibilityKeys(principal, teamPrefix(config)));
  };
  const hit = (row: Row, config: Record<string, unknown>, snippet?: string | null): Hit => ({
    type: row.type,
    externalId: row.externalId,
    title: row.ref ? `${row.ref}: ${row.title}` : row.title,
    url: row.url,
    snippet: snippet ? snippetOf(snippet) : snippetOf(row.summary || row.body),
    authority: authorityOf(row, config),
    date: iso(row.changedAt ?? row.occurredAt),
    status: row.status,
  });

  return {
    kind,

    async check(context) {
      const [row] = await context.db
        .select({ count: sql<number>`count(*)::int` })
        .from(items)
        .where(eq(items.sourceId, context.source.id));
      const secret = context.secret.webhookSecret;
      if (typeof secret !== "string" || secret === "") {
        throw new SourceError("Set a webhook secret, then the same secret in the app");
      }
      const last = context.source.lastDeliveryAt;
      return last
        ? `${row?.count ?? 0} items; last delivery ${last.toISOString().slice(0, 16).replace("T", " ")} UTC`
        : "Waiting for the first delivery: enter the webhook's URL and secret in the app";
    },

    async search(context, query, limit) {
      const q = sql`(${tsQuery(query)})`;
      const ref = query.trim().toUpperCase();
      const language = config().searchConfigs[0]!;
      const headline = `StartSel=${HIGHLIGHT_START}, StopSel=${HIGHLIGHT_END}, MaxWords=35, MinWords=12, ShortWord=2, MaxFragments=1, FragmentDelimiter=" … "`;
      const score = sql<number>`(case when upper(coalesce(${items.ref}, '')) = ${ref} then 10 else 0 end) + ts_rank(${items.searchVector}, ${q})`;
      const rows = await context.db
        .select({
          row: items,
          snippet: sql<
            string | null
          >`ts_headline(${language}::regconfig, coalesce(nullif(${items.summary}, ''), ${items.body}), ${q}, ${headline})`,
        })
        .from(items)
        .where(
          and(
            eq(items.sourceId, context.source.id),
            sql`(${items.searchVector} @@ ${q} or upper(coalesce(${items.ref}, '')) = ${ref})`,
            visibleTo(context),
          ),
        )
        .orderBy(desc(score), desc(sql`coalesce(${items.changedAt}, ${items.occurredAt})`))
        .limit(limit);
      return rows.map(({ row, snippet }) => hit(row, context.config, snippet));
    },

    async fetch(context, type, externalId) {
      const [row] = await context.db
        .select()
        .from(items)
        .where(
          and(
            eq(items.sourceId, context.source.id),
            eq(items.externalId, externalId),
            eq(items.type, type),
            visibleTo(context),
          ),
        );
      if (!row) return null;
      const refs = row.related.map((relation) => relation.ref);
      const linked =
        refs.length > 0
          ? await context.db
              .select({ ref: items.ref, type: items.type, externalId: items.externalId, title: items.title })
              .from(items)
              .where(and(eq(items.sourceId, context.source.id), inArray(items.ref, refs), visibleTo(context)))
          : [];
      const item: FetchedItem = {
        type: row.type,
        externalId: row.externalId,
        title: row.ref ? `${row.ref}: ${row.title}` : row.title,
        url: row.url,
        authority: authorityOf(row, context.config),
        date: iso(row.changedAt ?? row.occurredAt),
        status: row.status,
        text: row.body,
        metadata: Object.fromEntries(
          Object.entries(row.metadata).filter(
            (entry): entry is [string, string | number | boolean | null | string[]] =>
              entry[1] === null ||
              ["string", "number", "boolean"].includes(typeof entry[1]) ||
              (Array.isArray(entry[1]) && entry[1].every((value) => typeof value === "string")),
          ),
        ),
        related: row.related.map((relation) => {
          const target = linked.find((candidate) => candidate.ref === relation.ref);
          return {
            id: target ? `${context.source.slug}:${target.type}:${target.externalId}` : null,
            title: target ? `${relation.ref}: ${target.title}` : relation.ref,
            relation: relation.relation,
          };
        }),
      };
      return item;
    },

    async recent(context, since, limit) {
      const rows = await context.db
        .select()
        .from(items)
        .where(
          and(
            eq(items.sourceId, context.source.id),
            gte(sql`coalesce(${items.changedAt}, ${items.occurredAt}, ${items.updatedAt})`, since),
            visibleTo(context),
          ),
        )
        .orderBy(desc(sql`coalesce(${items.changedAt}, ${items.occurredAt}, ${items.updatedAt})`))
        .limit(limit);
      return rows.map((row) => hit(row, context.config));
    },
  };
}
