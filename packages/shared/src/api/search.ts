import { z } from "zod";
import { authoritySchema, sourceKindSchema } from "../sources";
import { NOT_STORABLE_MESSAGE, storable } from "./common";

/** Matched words in snippets of the search page are wrapped in these characters. */
export const HIGHLIGHT_START = "\u0002";
export const HIGHLIGHT_END = "\u0003";

const sourceListParam = z.preprocess(
  (value) =>
    typeof value === "string"
      ? value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : value,
  z.array(z.string().max(40)).max(20).optional(),
);

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1, "Enter a search").max(300).refine(storable, NOT_STORABLE_MESSAGE),
  /** Source slugs, comma-separated; empty: every source the caller may use. */
  sources: sourceListParam,
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const sourceRefSchema = z.object({
  slug: z.string(),
  name: z.string(),
  kind: sourceKindSchema,
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

export const searchResultSchema = z.object({
  /** `<source>:<type>:<id>`, for fetch. */
  id: z.string(),
  title: z.string(),
  /** The item in its app. */
  url: z.string(),
  /** A short excerpt; on the search page with highlight marks. */
  snippet: z.string(),
  type: z.string(),
  source: sourceRefSchema,
  /** Level in the source order (lower wins when sources disagree). */
  authority: authoritySchema,
  /** Last change, decision or publication date. */
  date: z.string().nullable(),
  /** E.g. "in force", "superseded by LB-14", "draft". */
  status: z.string().nullable(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

/** How each source answered. */
export const sourceOutcomeSchema = z.object({
  slug: z.string(),
  name: z.string(),
  ok: z.boolean(),
  count: z.number().int(),
  ms: z.number().int(),
  /** Why the source did not answer; short and plain. */
  error: z.string().nullable(),
});
export type SourceOutcome = z.infer<typeof sourceOutcomeSchema>;

export const searchResponseSchema = z.object({
  query: z.string(),
  results: z.array(searchResultSchema),
  sources: z.array(sourceOutcomeSchema),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const metadataValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
]);

/** One item, read in full. */
export const itemSchema = searchResultSchema.omit({ snippet: true }).extend({
  /** The whole item as text (Markdown where the app uses it). */
  text: z.string(),
  metadata: z.record(z.string(), metadataValueSchema),
  /** Items this one points to (e.g. the decision it replaced). */
  related: z.array(z.object({ id: z.string().nullable(), title: z.string(), relation: z.string() })),
});
export type Item = z.infer<typeof itemSchema>;

export const contextRequestSchema = z.object({
  topic: z.string().trim().min(2, "Describe the topic").max(500).refine(storable, NOT_STORABLE_MESSAGE),
  sources: sourceListParam,
  /** Results per source. */
  perSource: z.coerce.number().int().min(1).max(10).default(4),
});
export type ContextRequest = z.infer<typeof contextRequestSchema>;

/** Everything Connector knows about a topic, ordered by the source order. */
export const contextResponseSchema = z.object({
  topic: z.string(),
  sections: z.array(
    z.object({
      authority: authoritySchema,
      label: z.string(),
      description: z.string(),
      items: z.array(searchResultSchema),
    }),
  ),
  /** Hints: newer decisions than pages, sources that did not answer. */
  notes: z.array(z.string()),
  sources: z.array(sourceOutcomeSchema),
});
export type ContextResponse = z.infer<typeof contextResponseSchema>;

export const recentQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
  sources: sourceListParam,
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type RecentQuery = z.infer<typeof recentQuerySchema>;
export const recentResponseSchema = z.object({
  items: z.array(searchResultSchema),
  sources: z.array(sourceOutcomeSchema),
});
export type RecentResponse = z.infer<typeof recentResponseSchema>;

/**
 * The knowledge source contract of the Support Agent (and other
 * bots): `POST /api/v1/knowledge/search` with a service token.
 */
export const knowledgeSearchSchema = z.object({
  query: z.string().trim().min(1).max(500).refine(storable, NOT_STORABLE_MESSAGE),
  limit: z.coerce.number().int().min(1).max(20).default(6),
});
export const knowledgeResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  text: z.string(),
  section: z.string().nullable(),
});
export const knowledgeResponseSchema = z.object({ results: z.array(knowledgeResultSchema) });
export type KnowledgeResponse = z.infer<typeof knowledgeResponseSchema>;

/**
 * A proposed change to a Handbook page or a new page, made as the person
 * (their linked Handbook account) and submitted for review. Nothing goes
 * live until an editor merges it in Handbook.
 */
export const proposalSchema = z
  .object({
    /** The page to change: its ID from search (`handbook:page:…`). */
    page: z.string().trim().min(1).max(300).optional(),
    edits: z
      .array(z.object({ oldText: z.string().min(1).max(20_000), newText: z.string().max(20_000) }))
      .min(1)
      .max(50)
      .optional(),
    /** Or a new page: the Handbook source's slug (when there are several), space, path, title and Markdown body. */
    newPage: z
      .object({
        space: z
          .string()
          .trim()
          .max(100)
          .regex(/^[a-z0-9][a-z0-9-]*$/, "Use the space's slug, e.g. it"),
        path: z.string().trim().min(1).max(300),
        title: z.string().trim().min(1).max(200),
        body: z.string().max(100_000),
      })
      .optional(),
    source: z.string().max(40).optional(),
    /** The change set's title and why the change is needed (reviewers read it). */
    title: z.string().trim().min(1, "Add a title").max(200),
    description: z.string().trim().min(1, "Say why").max(10_000),
  })
  .refine((value) => (value.page && value.edits) || value.newPage, {
    message: "Give a page with edits, or a new page",
    path: ["page"],
  });
export type Proposal = z.infer<typeof proposalSchema>;
export const proposalResultSchema = z.object({
  number: z.number().int(),
  url: z.string(),
  status: z.string(),
});
export type ProposalResult = z.infer<typeof proposalResultSchema>;
