import { z } from "zod";
import { MAX_ITEM_TEXT, MAX_SNIPPET } from "@connector/shared/limits";
import { handbookConfigSchema } from "@connector/shared/api/sources";
import { sourceRequest } from "./http";
import { linkedAccessToken } from "./links";
import { SourceError, type Adapter, type AdapterContext, type FetchedItem, type Hit } from "./types";

/*
 * Handbook (live): its REST API with a read-only service token,
 * or as the person when they linked their Handbook account (then Handbook
 * shows them their drafts as it would in the browser, and agents can
 * propose changes). Pages in the rule spaces rank first (source order).
 */

const APP = "Handbook";

const searchSchema = z.object({
  results: z.array(
    z.object({
      pageId: z.string(),
      space: z.object({ slug: z.string(), name: z.string() }),
      path: z.string(),
      title: z.string(),
      description: z.string().nullable().optional(),
      headingPath: z.array(z.string()).optional().default([]),
      url: z.string(),
      snippet: z.string().optional().default(""),
      tags: z.array(z.string()).optional().default([]),
      type: z.string().nullable().optional(),
    }),
  ),
});

const pageSchema = z.object({
  id: z.string(),
  space: z.string(),
  spaceName: z.string(),
  path: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  type: z.string().nullable(),
  tags: z.array(z.string()),
  revision: z.number(),
  updatedAt: z.string(),
  body: z.string(),
  properties: z.record(z.string(), z.unknown()),
  updatedBy: z.object({ name: z.string() }).nullable().optional(),
  breadcrumbs: z
    .array(z.object({ title: z.string() }))
    .optional()
    .default([]),
  backlinks: z
    .array(z.object({ id: z.string(), title: z.string() }))
    .optional()
    .default([]),
});

const recentSchema = z.object({
  items: z.array(
    z.object({
      page: z.object({ id: z.string(), space: z.string(), path: z.string(), title: z.string() }),
      revision: z.object({
        kind: z.string(),
        createdAt: z.string(),
        message: z.string().nullable().optional(),
        author: z.object({ name: z.string() }).nullable().optional(),
      }),
    }),
  ),
});

const spacesSchema = z.object({
  items: z.array(z.object({ slug: z.string(), name: z.string().optional() })),
});

export type HandbookConfig = z.infer<typeof handbookConfigSchema>;

export function handbookConfig(context: Pick<AdapterContext, "config">): HandbookConfig {
  return handbookConfigSchema.parse(context.config);
}

/** The person's linked token, else the service token. */
async function tokenFor(context: AdapterContext): Promise<string> {
  if (context.principal.kind === "user") {
    const linked = await linkedAccessToken(context.db, context.source, context.principal.id, context.signal);
    if (linked) return linked;
  }
  const token = context.secret.serviceToken;
  if (typeof token !== "string" || token === "") {
    throw new SourceError("Handbook has no service token: an admin adds one in Connector");
  }
  return token;
}

const pageUrl = (base: string, space: string, path: string) =>
  `${base}/s/${encodeURIComponent(space)}/${path.split("/").map(encodeURIComponent).join("/")}`;

function authorityOf(config: HandbookConfig, space: string) {
  return config.ruleSpaces.includes(space) ? ("rules" as const) : ("knowledge" as const);
}

/** Handbook marks matched words with \u0002 and \u0003; Connector uses the same marks. */
function snippetOf(text: string): string {
  return text.length > MAX_SNIPPET ? `${text.slice(0, MAX_SNIPPET - 1)}…` : text;
}

/** Handbook's spaces, read with the service token: admins pick the rule spaces from them. */
export async function handbookSpaces(context: AdapterContext): Promise<{ slug: string; name: string }[]> {
  const config = handbookConfig(context);
  const token = context.secret.serviceToken;
  if (typeof token !== "string" || token === "") throw new SourceError("Add a service token from Handbook");
  const spaces = await sourceRequest(`${config.baseUrl}/api/v1/spaces`, {
    token,
    signal: context.signal,
    schema: spacesSchema,
    app: APP,
  });
  return spaces.items.map((space) => ({ slug: space.slug, name: space.name ?? space.slug }));
}

export const handbookAdapter: Adapter = {
  kind: "handbook",

  async check(context) {
    const config = handbookConfig(context);
    const token = context.secret.serviceToken;
    if (typeof token !== "string" || token === "") throw new SourceError("Add a service token from Handbook");
    const spaces = await sourceRequest(`${config.baseUrl}/api/v1/spaces`, {
      token,
      signal: context.signal,
      schema: spacesSchema,
      app: APP,
    });
    const missing = config.ruleSpaces.filter((slug) => !spaces.items.some((space) => space.slug === slug));
    if (missing.length > 0) throw new SourceError(`Handbook has no space ${missing.join(", ")}`);
    return `Reached Handbook: ${spaces.items.length} spaces`;
  },

  async search(context, query, limit) {
    const config = handbookConfig(context);
    const url = new URL(`${config.baseUrl}/api/v1/search`);
    url.searchParams.set("q", query.slice(0, 200));
    url.searchParams.set("limit", String(Math.min(limit, 50)));
    const data = await sourceRequest(url.toString(), {
      token: await tokenFor(context),
      signal: context.signal,
      schema: searchSchema,
      app: APP,
    });
    // Handbook returns the best section of each page once.
    return data.results.map((result): Hit => ({
      type: "page",
      externalId: result.pageId,
      title:
        result.headingPath.length > 0 ? `${result.title} › ${result.headingPath.join(" › ")}` : result.title,
      url: result.url,
      snippet: snippetOf(result.snippet || result.description || ""),
      authority: authorityOf(config, result.space.slug),
      date: null,
      status: result.type ? result.type : null,
    }));
  },

  async fetch(context, type, externalId) {
    if (type !== "page" || !/^[0-9a-f-]{36}$/i.test(externalId)) return null;
    const config = handbookConfig(context);
    let page: z.infer<typeof pageSchema>;
    try {
      page = await sourceRequest(`${config.baseUrl}/api/v1/pages/${externalId}`, {
        token: await tokenFor(context),
        signal: context.signal,
        schema: pageSchema,
        app: APP,
      });
    } catch (error) {
      if (error instanceof SourceError && error.kind === "not_found") return null;
      throw error;
    }
    const item: FetchedItem = {
      type: "page",
      externalId: page.id,
      title: page.title,
      url: pageUrl(config.baseUrl, page.space, page.path),
      authority: authorityOf(config, page.space),
      date: page.updatedAt,
      status: page.status === "active" ? null : page.status,
      text: page.body.slice(0, MAX_ITEM_TEXT),
      metadata: {
        space: page.spaceName,
        path: `${page.space}/${page.path}`,
        description: page.description,
        status: page.status,
        type: page.type,
        tags: page.tags,
        revision: page.revision,
        updatedBy: page.updatedBy?.name ?? null,
        ...(typeof page.properties.owner === "string" ? { owner: page.properties.owner } : {}),
        ...(typeof page.properties.reviewed === "string" ? { reviewed: page.properties.reviewed } : {}),
      },
      related: [
        ...(typeof page.properties.replaced_by === "string"
          ? [{ id: null, title: page.properties.replaced_by, relation: "replaced by" }]
          : []),
        ...page.backlinks.slice(0, 20).map((link) => ({
          id: `${context.source.slug}:page:${link.id}`,
          title: link.title,
          relation: "linked from",
        })),
      ],
    };
    return item;
  },

  async recent(context, since, limit) {
    const config = handbookConfig(context);
    const data = await sourceRequest(`${config.baseUrl}/api/v1/recent?limit=${Math.min(limit, 100)}`, {
      token: await tokenFor(context),
      signal: context.signal,
      schema: recentSchema,
      app: APP,
    });
    const seen = new Set<string>();
    const hits: Hit[] = [];
    for (const entry of data.items) {
      if (new Date(entry.revision.createdAt) < since || seen.has(entry.page.id)) continue;
      seen.add(entry.page.id);
      hits.push({
        type: "page",
        externalId: entry.page.id,
        title: entry.page.title,
        url: pageUrl(config.baseUrl, entry.page.space, entry.page.path),
        snippet: snippetOf(
          [
            entry.revision.kind === "save" ? "Changed" : entry.revision.kind,
            entry.revision.author?.name ? `by ${entry.revision.author.name}` : "",
            entry.revision.message ? `: ${entry.revision.message}` : "",
          ]
            .filter(Boolean)
            .join(" "),
        ),
        authority: authorityOf(config, entry.page.space),
        date: entry.revision.createdAt,
        status: null,
      });
    }
    return hits;
  },
};

const changeSetSchema = z.object({
  number: z.number(),
  status: z.string(),
  space: z.object({ slug: z.string() }),
});

export type HandbookProposal = {
  title: string;
  description: string;
  /** Change an existing page with exact text replacements. */
  page?: { id: string; edits: { oldText: string; newText: string }[] };
  /** Or create a page. */
  newPage?: { space: string; path: string; title: string; body: string };
};

/**
 * Proposes a change as the person (their linked account): a change set in
 * the page's space, the change, and the submission for review. Editors
 * review and merge in Handbook; nothing goes live from here.
 */
export async function proposeHandbookChange(
  context: AdapterContext,
  proposal: HandbookProposal,
): Promise<{ number: number; url: string; status: string }> {
  if (context.principal.kind !== "user") throw new SourceError("Only people can propose changes");
  const config = handbookConfig(context);
  const token = await linkedAccessToken(context.db, context.source, context.principal.id, context.signal);
  if (!token) {
    throw new SourceError(
      `Link your Handbook account first: open Connector, Settings → Linked accounts (the agent proposes as you)`,
    );
  }
  const call = <T extends z.ZodType>(
    path: string,
    method: "GET" | "POST" | "PUT",
    schema: T,
    body?: unknown,
  ) =>
    sourceRequest(`${config.baseUrl}/api/v1${path}`, {
      token,
      signal: context.signal,
      schema,
      method,
      body,
      app: APP,
    });

  let space: string;
  if (proposal.page) {
    space = (await call(`/pages/${proposal.page.id}`, "GET", pageSchema)).space;
  } else if (proposal.newPage) {
    space = proposal.newPage.space;
    // Putting a file at a taken path would replace that page: only new paths.
    const existing = await call(
      `/spaces/${encodeURIComponent(space)}/pages/by-path?path=${encodeURIComponent(proposal.newPage.path)}`,
      "GET",
      z.object({ id: z.string() }),
    ).catch((error: unknown) => {
      if (error instanceof SourceError && error.kind === "not_found") return null;
      throw error;
    });
    if (existing) {
      throw new SourceError(
        `A page exists at ${space}/${proposal.newPage.path}: propose edits to it (handbook:page:${existing.id})`,
        { diagnostic: "A page exists at that path" },
      );
    }
  } else {
    throw new SourceError("Name a page to change or a new page");
  }
  const changeSet = await call("/change-sets", "POST", changeSetSchema, {
    space,
    title: proposal.title,
    description: proposal.description,
  });
  const url = `${config.baseUrl}/changes/${changeSet.number}`;
  try {
    if (proposal.page) {
      await call(`/change-sets/${changeSet.number}/pages/${proposal.page.id}/edit`, "POST", z.unknown(), {
        edits: proposal.page.edits,
      });
    } else if (proposal.newPage) {
      const file = `---\ntitle: ${JSON.stringify(proposal.newPage.title)}\n---\n\n${proposal.newPage.body.trim()}\n`;
      await call(`/change-sets/${changeSet.number}/pages`, "PUT", z.unknown(), {
        path: proposal.newPage.path,
        markdown: file,
      });
    }
    const submitted = await call(`/change-sets/${changeSet.number}/submit`, "POST", changeSetSchema, {});
    return { number: changeSet.number, url, status: submitted.status };
  } catch (error) {
    if (error instanceof SourceError) {
      throw new SourceError(`${error.message}. The change set #${changeSet.number} stays open: ${url}`, {
        kind: error.kind,
        diagnostic: `${error.diagnostic}; a change set stays open`,
      });
    }
    throw error;
  }
}
