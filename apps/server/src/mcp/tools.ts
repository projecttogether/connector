import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  ContextResponse,
  Item,
  ProposalResult,
  RecentResponse,
  SearchResponse,
  SearchResult,
} from "@connector/shared/api/search";
import { HIGHLIGHT_END, HIGHLIGHT_START } from "@connector/shared/api/search";
import type { SourceSummary } from "@connector/shared/api/sources";
import type { Colleague } from "@connector/shared/api/users";
import { AUTHORITIES, AUTHORITY_DESCRIPTIONS, AUTHORITY_LABELS } from "@connector/shared/sources";
import { config } from "../config";
import { ApiCallError, type ApiClient } from "./client";

/**
 * The tools of the MCP server. Each is a thin translation to REST API calls
 * made as the caller (client.ts), so the API's rules apply unchanged: the
 * caller sees only the sources and items they may see. `search` and `fetch`
 * follow the shape ChatGPT expects for company knowledge and deep research
 * (id, title, url; id, title, text, url, metadata). Results are JSON, as
 * text and as `structuredContent`.
 */

type ToolResult = CallToolResult;

function ok(data: unknown): ToolResult {
  const structured =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { result: data ?? null };
  return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
}

function failure(error: ApiCallError): ToolResult {
  const fields = Object.entries(error.fields ?? {})
    .map(([key, message]) => `${key}: ${message}`)
    .join("; ");
  const text = `${error.message}${fields && fields !== error.message ? ` (${fields})` : ""} [${error.status} ${error.code}]`;
  return { isError: true, content: [{ type: "text", text }] };
}

async function run(body: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await body());
  } catch (error) {
    if (error instanceof ApiCallError) return failure(error);
    throw error;
  }
}

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const plain = (text: string) => text.replaceAll(HIGHLIGHT_START, "").replaceAll(HIGHLIGHT_END, "");

const sourcesArg = z
  .array(z.string().max(40))
  .max(20)
  .optional()
  .describe("Only these sources (slugs from list_sources); default: all");

/** A result as agents read it: no highlight marks; the source order named. */
function result(item: SearchResult) {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    text: plain(item.snippet),
    source: item.source.name,
    type: item.type,
    authority: AUTHORITY_LABELS[item.authority],
    date: item.date,
    status: item.status,
  };
}

export function registerTools(server: McpServer, api: ApiClient) {
  server.registerTool(
    "search",
    {
      title: "Search",
      description:
        "Searches every connected app the person may use (Handbook, Logbook, Library, CRM) at once. Returns items with id, title, url, a short text, source, type, authority (level in the source order), date and status. Read an item in full with fetch.",
      inputSchema: {
        query: z.string().min(1).max(300).describe("Words to search for, or a reference such as LB-12"),
        sources: sourcesArg,
        limit: z.number().int().min(1).max(50).optional().describe("Most results (default 20)"),
      },
      annotations: READ,
    },
    ({ query, sources, limit }) =>
      run(async () => {
        const response = await api.get<SearchResponse>("/search", {
          q: query,
          sources: sources?.join(","),
          limit: limit ?? 20,
        });
        return {
          results: response.results.map(result),
          unavailable: response.sources
            .filter((source) => !source.ok)
            .map((source) => `${source.name}: ${source.error}`),
        };
      }),
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch",
      description:
        "Reads one item in full by its id from search, get_context or recent_changes (e.g. handbook:page:…, logbook:decision:…). Returns id, title, text, url and metadata (source, type, authority, status, date, related items).",
      inputSchema: { id: z.string().min(1).max(300).describe("The item's id") },
      annotations: READ,
    },
    ({ id }) =>
      run(async () => {
        const item = await api.get<Item>(`/items/${encodeURIComponent(id)}`);
        return {
          id: item.id,
          title: item.title,
          text: item.text,
          url: item.url,
          metadata: {
            source: item.source.name,
            type: item.type,
            authority: AUTHORITY_LABELS[item.authority],
            status: item.status,
            date: item.date,
            ...item.metadata,
            related: item.related,
          },
        };
      }),
  );

  server.registerTool(
    "get_context",
    {
      title: "Get context",
      description:
        "Everything the connected apps hold on a topic, grouped by the source order (purpose and rules, decisions in force, knowledge base, logbook history, records, library), with notes on conflicts (a decision newer than a page, replaced decisions) and sources that did not answer. Use it first for questions and tasks.",
      inputSchema: {
        topic: z.string().min(2).max(500).describe("The question, task or topic in a few words"),
        sources: sourcesArg,
        per_source: z.number().int().min(1).max(10).optional().describe("Results per source (default 4)"),
      },
      annotations: READ,
    },
    ({ topic, sources, per_source }) =>
      run(async () => {
        const response = await api.post<ContextResponse>("/context", {
          topic,
          sources,
          perSource: per_source ?? 4,
        });
        return {
          topic: response.topic,
          sections: response.sections.map((section) => ({
            level: section.label,
            meaning: section.description,
            items: section.items.map(result),
          })),
          notes: response.notes,
        };
      }),
  );

  server.registerTool(
    "recent_changes",
    {
      title: "Recent changes",
      description:
        "What changed in the connected apps lately, newest first: new decisions, updates, learnings, notes and changed pages.",
      inputSchema: {
        days: z.number().int().min(1).max(90).optional().describe("How many days back (default 7)"),
        sources: sourcesArg,
      },
      annotations: READ,
    },
    ({ days, sources }) =>
      run(async () => {
        const response = await api.get<RecentResponse>("/recent", {
          days: days ?? 7,
          sources: sources?.join(","),
        });
        return {
          items: response.items.map(result),
          unavailable: response.sources
            .filter((source) => !source.ok)
            .map((source) => `${source.name}: ${source.error}`),
        };
      }),
  );

  server.registerTool(
    "list_sources",
    {
      title: "List sources",
      description:
        "The connected apps the person may use: what each holds, how it is doing (state: ok = working, failing, waiting = no delivery yet, setup = an admin must finish its setup, unchecked = not checked yet), and the source order that decides which wins.",
      inputSchema: {},
      annotations: READ,
    },
    () =>
      run(async () => {
        const response = await api.get<{ items: SourceSummary[] }>("/sources");
        return {
          sources: response.items.map((source) => ({
            slug: source.slug,
            name: source.name,
            holds: source.holds,
            description: source.description,
            state: source.state,
            linkedAccount: source.linkable ? source.linked : null,
          })),
          sourceOrder: AUTHORITIES.map(
            (authority, index) =>
              `${index + 1}. ${AUTHORITY_LABELS[authority]}: ${AUTHORITY_DESCRIPTIONS[authority]}`,
          ),
          connector: config().APP_URL,
        };
      }),
  );

  server.registerTool(
    "find_people",
    {
      title: "Find people",
      description:
        "Looks up colleagues in the organization's directory by name, email address, job title or group (team). Returns name, email, title and groups.",
      inputSchema: { query: z.string().min(1).max(100).describe("A name, email address, title or group") },
      annotations: READ,
    },
    ({ query }) =>
      run(async () => ({ people: (await api.get<{ items: Colleague[] }>("/people", { q: query })).items })),
  );

  server.registerTool(
    "propose_handbook_change",
    {
      title: "Propose a Handbook change",
      description:
        "Proposes a change to the Handbook as the person: exact text replacements on an existing page (fetch it first and copy old_text exactly), or a new page. The change set is submitted for review; editors merge it in Handbook. Needs the person's linked Handbook account (Connector → Settings).",
      inputSchema: {
        title: z.string().min(1).max(200).describe("Short title of the change"),
        description: z
          .string()
          .min(1)
          .max(10_000)
          .describe("Why the change is needed, with links to the sources (e.g. the decision)"),
        page: z
          .string()
          .max(300)
          .optional()
          .describe("The page to change: its id from search (handbook:page:…)"),
        edits: z
          .array(z.object({ old_text: z.string().min(1), new_text: z.string() }))
          .max(50)
          .optional()
          .describe("Replacements in the page's text"),
        new_page: z
          .object({
            space: z.string().describe("The space's slug, e.g. it"),
            path: z.string().describe("The page's path in the space, e.g. onboarding/laptop"),
            title: z.string(),
            body: z.string().describe("The page's Markdown body (no frontmatter)"),
          })
          .optional()
          .describe("Or a new page"),
        source: z.string().max(40).optional().describe("The Handbook source's slug, when there are several"),
      },
      annotations: WRITE,
    },
    ({ title, description, page, edits, new_page, source }) =>
      run(async () => {
        const created = await api.post<ProposalResult>("/proposals", {
          title,
          description,
          page,
          edits: edits?.map((edit) => ({ oldText: edit.old_text, newText: edit.new_text })),
          newPage: new_page,
          source,
        });
        return { ...created, note: "Submitted for review; it goes live when an editor merges it." };
      }),
  );
}
