import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { MAX_ITEM_TEXT, MAX_SNIPPET } from "@connector/shared/limits";
import { notionConfigSchema, notionIdOf, type NotionDatabase } from "@connector/shared/api/sources";
import type { Authority } from "@connector/shared/sources";
import { config } from "../config";
import { sourceRequest } from "./http";
import { SourceError, type Adapter, type AdapterContext, type FetchedItem, type Hit } from "./types";

/*
 * Notion (live): its API with the secret of an internal integration. The
 * integration reads the pages shared with it; Connector shows only the
 * pages of the databases the source names (`config.databases`), each at
 * the level an admin chose in the source order. A database holds one or
 * more data sources (its tables); search asks each for pages whose title
 * or text properties contain every search word (Notion's API cannot search
 * page bodies), and fetch reads the page as Markdown.
 */

const APP = "Notion";

/** The API version Connector speaks (Notion-Version header). */
const NOTION_VERSION = "2026-03-11";

/** Search words sent to Notion; each must match. */
const MAX_TERMS = 5;

/** Text properties searched per table, besides the title (Notion allows 100 conditions per group). */
const MAX_TEXT_PROPERTIES = 20;

/**
 * Notion allows about three table queries a second per integration, with
 * short bursts: a search starts three at once and the rest this far apart,
 * or closer, so that all start within half the source's time.
 */
const QUERY_BURST = 3;
const QUERY_SPACING_MS = 350;

/**
 * How long a source's tables are kept in memory: their IDs, names and
 * property IDs, never pages. A change to the source starts over.
 */
const TABLES_TTL_MS = 5 * 60_000;

/** Words too common to narrow a search (English and German). */
const STOP_WORDS = new Set(
  (
    "a an and are as at be by can did do does for from has have how in into is it its of on or our " +
    "that the their this to was we were what when where which who why with you your " +
    "auf aus bei das dem den der des die ein eine einen für ist mit und von was wer wie zu zum zur"
  ).split(" "),
);

export type NotionConfig = z.infer<typeof notionConfigSchema>;

const richTextSchema = z.array(z.object({ plain_text: z.string().optional() })).catch([]);

const databaseSchema = z.object({
  id: z.string(),
  title: richTextSchema.optional(),
  data_sources: z.array(z.object({ id: z.string(), name: z.string().optional() })).default([]),
});

const dataSourceSchema = z.object({
  id: z.string(),
  title: richTextSchema.optional(),
  properties: z.record(z.string(), z.object({ id: z.string(), type: z.string() })),
});

/** A property value: its type, and the value under the type's name. */
const propertyValueSchema = z.looseObject({ type: z.string() });
type PropertyValue = z.infer<typeof propertyValueSchema>;

const pageSchema = z.object({
  object: z.literal("page"),
  id: z.string(),
  url: z.string().optional(),
  last_edited_time: z.string().optional(),
  in_trash: z.boolean().optional(),
  is_archived: z.boolean().optional(),
  parent: z
    .object({
      type: z.string(),
      database_id: z.string().optional(),
      data_source_id: z.string().optional(),
    })
    .optional(),
  properties: z.record(z.string(), propertyValueSchema).default({}),
});
type Page = z.infer<typeof pageSchema>;

const listSchema = z.object({ results: z.array(z.unknown()) });

const markdownSchema = z.object({ markdown: z.string(), truncated: z.boolean().optional() });

/** One table (data source) of a database: its pages' level and the properties that hold text. */
export type Table = {
  id: string;
  databaseId: string;
  /** The database's title, with the table's when the database has several. */
  name: string;
  authority: Authority;
  /** Property IDs of the title and of the text properties. */
  title: string | null;
  texts: string[];
};

export function notionConfig(context: Pick<AdapterContext, "config">): NotionConfig {
  return notionConfigSchema.parse(context.config);
}

function integrationSecret(context: AdapterContext): string {
  const secret = context.secret.integrationSecret;
  if (typeof secret !== "string" || secret === "")
    throw new SourceError("Notion has no integration secret: an admin adds one in Connector");
  return secret;
}

/** A request to Notion's API: GET, or POST with a body. */
function notion<T extends z.ZodType>(
  context: AdapterContext,
  path: string,
  schema: T,
  body?: unknown,
): Promise<z.infer<T>> {
  return sourceRequest(`${notionConfig(context).apiUrl}/v1/${path}`, {
    token: integrationSecret(context),
    signal: context.signal,
    schema,
    app: APP,
    method: body === undefined ? "GET" : "POST",
    body,
    headers: { "notion-version": NOTION_VERSION },
  });
}

const plain = (text: { plain_text?: string }[] | undefined) =>
  (text ?? []).map((part) => part.plain_text ?? "").join("");

/** A database's tables, read from Notion. */
async function readTables(context: AdapterContext, database: NotionDatabase): Promise<Table[]> {
  let found: z.infer<typeof databaseSchema>;
  try {
    found = await notion(context, `databases/${database.id}`, databaseSchema);
  } catch (error) {
    if (error instanceof SourceError && error.kind === "not_found") {
      throw new SourceError(
        `Notion has no database ${database.id} for the integration: share the database with it, or check its link`,
        { kind: "not_found" },
      );
    }
    throw error;
  }
  const name = plain(found.title).trim() || "Untitled";
  return Promise.all(
    found.data_sources.map(async (entry): Promise<Table> => {
      const table = await notion(context, `data_sources/${encodeURIComponent(entry.id)}`, dataSourceSchema);
      const properties = Object.values(table.properties);
      const tableName = entry.name?.trim() || plain(table.title).trim();
      return {
        id: table.id,
        databaseId: database.id,
        name: found.data_sources.length > 1 && tableName ? `${name} · ${tableName}` : name,
        authority: database.authority,
        title: properties.find((property) => property.type === "title")?.id ?? null,
        texts: properties
          .filter((property) => property.type === "rich_text")
          .map((property) => property.id)
          .slice(0, MAX_TEXT_PROPERTIES),
      };
    }),
  );
}

const tablesCache = new Map<string, { at: number; tables: Table[] }>();

/** A database's tables, from memory when read in the last minutes (`fresh` reads them again). */
async function databaseTables(
  context: AdapterContext,
  database: NotionDatabase,
  options: { fresh?: boolean } = {},
): Promise<Table[]> {
  const now = Date.now();
  for (const [key, entry] of tablesCache) if (now - entry.at > TABLES_TTL_MS) tablesCache.delete(key);
  // Settings or secrets that change start over (`updatedAt`).
  const key = `${context.source.id}:${context.source.updatedAt.getTime()}:${database.id}:${database.authority}`;
  const cached = options.fresh ? undefined : tablesCache.get(key);
  if (cached) return cached.tables;
  const tables = await readTables(context, database);
  tablesCache.set(key, { at: Date.now(), tables });
  return tables;
}

/**
 * The tables of every database of the source. A database that fails is
 * left out and its failure returned: searches use the others, checks fail.
 */
async function tablesOf(
  context: AdapterContext,
  options: { fresh?: boolean } = {},
): Promise<{ tables: Table[]; failure: SourceError | null }> {
  const config = notionConfig(context);
  integrationSecret(context);
  const settled = await Promise.allSettled(
    config.databases.map((database) => databaseTables(context, database, options)),
  );
  const tables: Table[] = [];
  let failure: SourceError | null = null;
  for (const result of settled) {
    if (result.status === "fulfilled") tables.push(...result.value);
    else if (result.reason instanceof SourceError) failure ??= result.reason;
    else throw result.reason;
  }
  return { tables, failure };
}

/** The tables to ask; none at all is the first failure. */
async function usableTables(context: AdapterContext): Promise<Table[]> {
  const { tables, failure } = await tablesOf(context);
  if (tables.length === 0 && failure) throw failure;
  return tables;
}

/** The search words: quoted phrases stay whole; common words go unless nothing else is left. */
export function termsOf(query: string): string[] {
  const terms: string[] = [];
  const add = (term: string) => {
    if (!terms.some((other) => other.toLowerCase() === term.toLowerCase())) terms.push(term.slice(0, 100));
  };
  for (const match of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const phrase = match[1]?.trim();
    if (phrase) {
      add(phrase);
      continue;
    }
    const word = (match[2] ?? "").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (word.length >= 2 && !STOP_WORDS.has(word.toLowerCase())) add(word);
  }
  if (terms.length === 0) return [query.replaceAll('"', "").trim().slice(0, 100)];
  return terms.slice(0, MAX_TERMS);
}

/** Pages whose title or a text property contains each term. */
export function textFilter(table: Pick<Table, "title" | "texts">, terms: string[]): Record<string, unknown> {
  const anyProperty = (term: string) => ({
    or: [
      ...(table.title ? [{ property: table.title, title: { contains: term } }] : []),
      ...table.texts.map((id) => ({ property: id, rich_text: { contains: term } })),
    ],
  });
  return terms.length === 1 ? anyProperty(terms[0]!) : { and: terms.map(anyProperty) };
}

const LAST_EDITED_FIRST = [{ timestamp: "last_edited_time", direction: "descending" }];

/** The pages each table returns for its body; tables that fail are left out, unless all do. */
async function queryTables(
  context: AdapterContext,
  tables: Table[],
  bodyOf: (table: Table) => Record<string, unknown> | null,
  /** When the search began: reading the tables may have used some of its time. */
  started: number,
): Promise<{ page: Page; table: Table }[]> {
  const asked = tables.flatMap((table) => {
    const body = bodyOf(table);
    return body ? [{ table, body }] : [];
  });
  const left = started + config().SOURCE_TIMEOUT_SECONDS * 500 - Date.now();
  const spacing = Math.min(QUERY_SPACING_MS, Math.max(0, left) / Math.max(1, asked.length - QUERY_BURST));
  const settled = await Promise.allSettled(
    asked.map(async ({ table, body }, index) => {
      if (index >= QUERY_BURST) {
        // Cut short when time is up; the request below then fails as too slow.
        await sleep((index - QUERY_BURST + 1) * spacing, undefined, {
          signal: context.signal,
        }).catch(() => undefined);
      }
      const list = await notion(
        context,
        `data_sources/${encodeURIComponent(table.id)}/query`,
        listSchema,
        body,
      );
      return list.results.flatMap((result) => {
        const page = pageSchema.safeParse(result);
        // A table may have moved to another database since it was read: each page's own parent counts.
        return page.success && !gone(page.data) && parentDatabase(page.data) === table.databaseId
          ? [{ page: page.data, table }]
          : [];
      });
    }),
  );
  const found: { page: Page; table: Table }[] = [];
  let failure: SourceError | null = null;
  for (const result of settled) {
    if (result.status === "fulfilled") found.push(...result.value);
    else if (result.reason instanceof SourceError) failure ??= result.reason;
    else throw result.reason;
  }
  if (failure && settled.every((result) => result.status === "rejected")) throw failure;
  return found;
}

/** In Notion's trash, or archived. */
const gone = (page: Page) => Boolean(page.in_trash || page.is_archived);

/** The database a page lives in; null outside one. */
function parentDatabase(page: Page): string | null {
  const parent = page.parent;
  if (!parent || (parent.type !== "data_source_id" && parent.type !== "database_id")) return null;
  return parent.database_id ? notionIdOf(parent.database_id) : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textOf = (value: unknown) =>
  Array.isArray(value) ? plain(value.filter(isRecord) as { plain_text?: string }[]) : "";

const nameOf = (value: unknown) => (isRecord(value) && typeof value.name === "string" ? value.name : null);

const day = (value: unknown) => (typeof value === "string" ? value.slice(0, 10) : null);

/** A property's value as text; null when empty or not shown (relations, buttons). */
export function valueText(property: PropertyValue): string | null {
  const value = (property as Record<string, unknown>)[property.type];
  let text: string | null = null;
  switch (property.type) {
    case "title":
    case "rich_text":
      text = textOf(value);
      break;
    case "select":
    case "status":
      text = nameOf(value);
      break;
    case "multi_select":
    case "people":
      text = Array.isArray(value)
        ? value
            .map(nameOf)
            .filter((name): name is string => Boolean(name))
            .join(", ")
        : null;
      break;
    case "created_by":
    case "last_edited_by":
      text = nameOf(value);
      break;
    case "files":
      text = Array.isArray(value)
        ? value
            .map(nameOf)
            .filter((name): name is string => Boolean(name))
            .join(", ")
        : null;
      break;
    case "date":
      if (isRecord(value) && typeof value.start === "string") {
        text = typeof value.end === "string" ? `${value.start} – ${value.end}` : value.start;
      }
      break;
    case "number":
      text = typeof value === "number" ? String(value) : null;
      break;
    case "checkbox":
      text = value === true ? "Yes" : value === false ? "No" : null;
      break;
    case "url":
    case "email":
    case "phone_number":
      text = typeof value === "string" ? value : null;
      break;
    case "created_time":
    case "last_edited_time":
      text = day(value);
      break;
    case "unique_id":
      if (isRecord(value) && typeof value.number === "number") {
        text =
          typeof value.prefix === "string" && value.prefix
            ? `${value.prefix}-${value.number}`
            : String(value.number);
      }
      break;
    case "formula":
      if (isRecord(value) && typeof value.type === "string") {
        const result = value[value.type];
        text =
          typeof result === "string" || typeof result === "number"
            ? String(result)
            : typeof result === "boolean"
              ? result
                ? "Yes"
                : "No"
              : isRecord(result) && typeof result.start === "string"
                ? result.start
                : null;
      }
      break;
    case "rollup":
      if (isRecord(value) && typeof value.type === "string") {
        const result = value[value.type];
        if (typeof result === "number") text = String(result);
        else if (isRecord(result) && typeof result.start === "string") text = result.start;
        else if (Array.isArray(result)) {
          text = result
            .map((item) =>
              isRecord(item) && typeof item.type === "string" ? valueText(item as PropertyValue) : null,
            )
            .filter((item): item is string => Boolean(item))
            .join(", ");
        }
      }
      break;
    case "verification":
      text = isRecord(value) && typeof value.state === "string" ? value.state : null;
      break;
  }
  return text?.trim() ? text.trim() : null;
}

function pageTitle(page: Page): string {
  for (const property of Object.values(page.properties)) {
    if (property.type === "title") return valueText(property) ?? "Untitled";
  }
  return "Untitled";
}

/** The page in Notion: its own link, else one on the workspace's address. */
function pageUrl(page: Page, config: NotionConfig): string {
  if (page.url && /^https?:\/\//i.test(page.url)) return page.url;
  return `${config.baseUrl}/${page.id.replaceAll("-", "")}`;
}

/** The first status property, as Notion shows it (e.g. "In progress"). */
function pageStatus(page: Page): string | null {
  for (const property of Object.values(page.properties)) {
    if (property.type === "status") return valueText(property);
  }
  return null;
}

const cut = (text: string, length = MAX_SNIPPET) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

/** The text property that matched (around the match), else the page's other properties. */
export function snippetOf(page: Page, terms: string[]): string {
  const lowered = terms.map((term) => term.toLowerCase());
  const texts = Object.values(page.properties)
    .filter((property) => property.type === "rich_text")
    .map(valueText)
    .filter((text): text is string => Boolean(text))
    .map((text) => text.replace(/\s+/g, " "));
  for (const text of texts) {
    const index = Math.min(
      ...lowered.map((term) => text.toLowerCase().indexOf(term)).filter((position) => position >= 0),
    );
    if (!Number.isFinite(index)) continue;
    const start = index > MAX_SNIPPET / 2 ? index - 60 : 0;
    return start > 0 ? `…${cut(text.slice(start), MAX_SNIPPET - 1)}` : cut(text);
  }
  if (texts[0]) return cut(texts[0]);
  const facts = Object.entries(page.properties)
    .filter(([, property]) => property.type !== "title")
    .map(([name, property]) => {
      const text = valueText(property);
      return text ? `${name}: ${text.replace(/\s+/g, " ")}` : null;
    })
    .filter(Boolean)
    .join(" · ");
  return cut(facts);
}

function hitOf(page: Page, table: Table, config: NotionConfig, terms: string[]): Hit {
  return {
    type: "page",
    externalId: page.id,
    title: pageTitle(page),
    url: pageUrl(page, config),
    snippet: snippetOf(page, terms),
    authority: table.authority,
    date: page.last_edited_time ?? null,
    status: pageStatus(page),
  };
}

/** Title matches first (all words before some), then the latest edit. */
function byRelevance(terms: string[]) {
  const lowered = terms.map((term) => term.toLowerCase());
  const score = (page: Page) => {
    const title = pageTitle(page).toLowerCase();
    const matched = lowered.filter((term) => title.includes(term)).length;
    return matched + (matched === lowered.length ? 1 : 0);
  };
  return (a: { page: Page }, b: { page: Page }) => score(b.page) - score(a.page) || newestFirst(a, b);
}

const newestFirst = (a: { page: Page }, b: { page: Page }) =>
  (b.page.last_edited_time ?? "").localeCompare(a.page.last_edited_time ?? "");

/** The configured database a page lives in; null for pages elsewhere. */
function databaseOf(config: NotionConfig, page: Page): NotionDatabase | null {
  const id = parentDatabase(page);
  return config.databases.find((database) => database.id === id) ?? null;
}

/** Notion's tags inside a line (styles, a mention of a person); other tags end a line. */
const INLINE_TAGS = new Set(["b", "i", "s", "u", "span", "code", "mention"]);
const TAG = /(?<!\\)<\/?([a-z][a-z0-9_-]*)(?:\s+[a-z][a-z0-9_:-]*(?:="[^"]*")?)*\s*\/?>/gi;

function attributesOf(text: string): Record<string, string> {
  return Object.fromEntries(
    [...text.matchAll(/([a-z][a-z0-9_:-]*)="([^"]*)"/gi)].map((match) => [match[1]!, match[2]!]),
  );
}

const webUrl = (value: string | undefined) => (value && /^https?:\/\//i.test(value) ? value : null);

/** One line of Notion's Markdown outside code, without its tags. */
function untag(text: string): string {
  return text
    .replace(
      /(?<!\\)<(page|database|mention)\b([^>]*)>([^<]*)<\/\1>/gi,
      (_, _tag: string, attributes: string, label: string) => {
        const url = webUrl(attributesOf(attributes).url);
        return url && label ? `[${label}](${url})` : label;
      },
    )
    .replace(
      /(?<!\\)<image\b([^>]*?)\s*(?:\/>|>([^<]*)<\/image>)/gi,
      (_, attributes: string, caption?: string) => {
        const source = webUrl(attributesOf(attributes).source);
        return source ? `![${caption ?? ""}](${source})` : (caption ?? "");
      },
    )
    .replace(/(?<!\\)<date\b([^>]*?)\s*\/>/gi, (_, attributes: string) => {
      const { start, end } = attributesOf(attributes);
      return [start, end].filter(Boolean).join(" – ");
    })
    .replace(TAG, (_, name: string) => (INLINE_TAGS.has(name.toLowerCase()) ? "" : "\n"));
}

/**
 * Notion's Markdown as plain Markdown. Notion writes callouts, toggles,
 * columns, styled tables, mentions and dates as XML-style tags, which
 * Markdown renderers drop together with their text: links to pages and
 * images stay links, dates their dates, the other tags go and their text
 * stays. Code is left as it is.
 */
export function plainMarkdown(markdown: string): string {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced || /^\s*(```|~~~)/.test(line)) return line;
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, index) => (index % 2 === 1 ? part : untag(part)))
        .join("");
    })
    .join("\n");
}

/** A page as Markdown: its title, one line per filled property, then its content. */
export function pageText(page: Page, content: { markdown: string; truncated?: boolean } | null): string {
  const lines = [`# ${pageTitle(page)}`, ""];
  for (const [name, property] of Object.entries(page.properties)) {
    if (property.type === "title") continue;
    const text = valueText(property);
    if (!text) continue;
    if (text.includes("\n")) lines.push(`**${name}:**`, "", text, "");
    else lines.push(`- **${name}:** ${text}`);
  }
  if (content?.markdown.trim()) lines.push("", plainMarkdown(content.markdown).trim());
  if (content?.truncated) lines.push("", "(Notion sent only the start of this page; open it for the rest.)");
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const notionAdapter: Adapter = {
  kind: "notion",

  async check(context) {
    const { tables, failure } = await tablesOf(context, { fresh: true });
    if (failure) throw failure;
    if (tables.length === 0) throw new SourceError("Notion's databases have no tables to search");
    return `Reached Notion; searching ${[...new Set(tables.map((table) => table.name))].join(", ")}`;
  },

  async search(context, query, limit) {
    const started = Date.now();
    const config = notionConfig(context);
    const tables = await usableTables(context);
    const terms = termsOf(query);
    const pageSize = Math.min(100, Math.max(20, limit * 2));
    const found = await queryTables(
      context,
      tables,
      (table) =>
        table.title || table.texts.length > 0
          ? { filter: textFilter(table, terms), sorts: LAST_EDITED_FIRST, page_size: pageSize }
          : null,
      started,
    );
    return found
      .sort(byRelevance(terms))
      .slice(0, limit)
      .map(({ page, table }) => hitOf(page, table, config, terms));
  },

  async fetch(context, type, externalId) {
    const id = type === "page" ? notionIdOf(externalId) : null;
    if (!id) return null;
    const config = notionConfig(context);
    let page: Page;
    try {
      page = await notion(context, `pages/${id}`, pageSchema);
    } catch (error) {
      if (error instanceof SourceError && error.kind === "not_found") return null;
      throw error;
    }
    const database = databaseOf(config, page);
    if (!database || gone(page)) return null;
    // v2: plain Markdown (tables as GFM); v1 is deprecated.
    const content = await notion(context, `pages/${id}/markdown?markdown_version=v2`, markdownSchema).catch(
      (error: unknown) => {
        // A page without content Notion can render keeps its properties.
        if (error instanceof SourceError && error.kind === "not_found") return null;
        throw error;
      },
    );
    // The table's name is context, not a condition: a failure leaves it out.
    const tables = await databaseTables(context, database).catch(() => [] as Table[]);
    const table =
      tables.find(
        (candidate) => notionIdOf(candidate.id) === notionIdOf(page.parent?.data_source_id ?? ""),
      ) ?? (tables.length === 1 ? tables[0] : undefined);
    const item: FetchedItem = {
      type: "page",
      externalId: page.id,
      title: pageTitle(page),
      url: pageUrl(page, config),
      authority: database.authority,
      date: page.last_edited_time ?? null,
      status: pageStatus(page),
      text: pageText(page, content).slice(0, MAX_ITEM_TEXT),
      metadata: { database: table?.name ?? null },
      related: [],
    };
    return item;
  },

  async recent(context, since, limit) {
    const started = Date.now();
    const config = notionConfig(context);
    const tables = await usableTables(context);
    const found = await queryTables(
      context,
      tables,
      () => ({
        filter: { timestamp: "last_edited_time", last_edited_time: { on_or_after: since.toISOString() } },
        sorts: LAST_EDITED_FIRST,
        page_size: Math.min(100, limit),
      }),
      started,
    );
    return found
      .sort(newestFirst)
      .slice(0, limit)
      .map(({ page, table }) => hitOf(page, table, config, []));
  },
};
