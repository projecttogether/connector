import { z } from "zod";
import { itkbConfigSchema } from "@connector/shared/api/sources";
import { normalizeGroup } from "../directory/groups";
import { indexAdapter, type IndexedItem } from "./index-store";

/*
 * IT Knowledge Base (webhook): Markdown pages built into a site and a
 * memory export (each page with its chunks and Keycloak groups). After each
 * deploy, the knowledge base sends every page (`page.changed`: the page and
 * its chunks in order), then the IDs of all its pages (`export.completed`):
 * pages it no longer lists are removed.
 *
 * Who sees a page is what the site allows: members of one of the page's
 * `allowed_groups` (Keycloak group paths, exactly as the site checks them),
 * or everyone who may use the source for a public page. Service tokens
 * (bots) read what is meant for everyone the source is open to: public
 * pages and pages meant for all of its access groups (with the site's staff
 * group as the one access group, every staff page), never pages for other
 * groups (operators). Pages that may not support answers
 * (`agent.can_answer: false`) are not kept. Pages in a rule section
 * (`config.ruleSections`, the page's folder below `docs/` in the knowledge
 * base's repository; addresses are flat) rank with purpose and rules,
 * unless deprecated.
 */

const nullableText = (max: number) => z.string().max(max).nullable().optional();

const pageSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(1000),
  description: nullableText(10_000),
  search_terms: z.array(z.string().max(200)).max(200).default([]),
  page_type: nullableText(40),
  status: z.string().max(40),
  visibility: z.string().max(40),
  allowed_groups: z.array(z.string().min(1).max(200)).max(50).default([]),
  last_updated: nullableText(40),
  /** The page's file in the knowledge base's repository, e.g. `docs/policies/passwords.md`. */
  source_path: nullableText(500),
  rendered_url: z.url({ protocol: /^https?$/ }),
  agent: z
    .object({
      confidence: nullableText(40),
      can_answer: z.boolean().nullable().optional(),
      escalation: nullableText(200),
    })
    .nullable()
    .optional(),
});
type Page = z.infer<typeof pageSchema>;

export const itkbPayloadSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("page.changed"),
    page: pageSchema,
    /** The page's text in order, as the export chunked it. */
    chunks: z.array(z.object({ text: z.string().max(200_000) })).max(1000),
  }),
  z.object({
    event: z.literal("export.completed"),
    /** The commit the export was built from. */
    source_version: nullableText(100),
    /** Every page of the export; Connector removes the others. */
    page_ids: z.array(z.string().min(1).max(200)).min(1).max(10_000),
  }),
]);
export type ItkbPayload = z.infer<typeof itkbPayloadSchema>;

/** The section of a page: its folder below `docs/` (`docs/policies/passwords.md` → `policies`). */
function sectionOf(sourcePath: string | null | undefined): string | null {
  const parts = (sourcePath ?? "").split("/").filter(Boolean);
  return parts[0] === "docs" && parts.length > 2 ? parts[1]! : null;
}

function statusOf(page: Page): string | null {
  if (page.status === "deprecated" || page.agent?.confidence === "deprecated") return "deprecated";
  if (page.agent?.confidence === "draft") return "draft guidance";
  return null;
}

function dateOf(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The page as Connector indexes it; null when it may not support answers. */
export function itkbItem(page: Page, chunks: { text: string }[]): IndexedItem | null {
  if (page.agent?.can_answer === false) return null;
  const description = page.description?.trim() ?? "";
  const text = chunks
    .map((chunk) => chunk.text.trim())
    .filter(Boolean)
    .join("\n\n");
  const date = dateOf(page.last_updated);
  const isPublic = page.visibility === "public";
  return {
    externalId: page.id,
    type: "page",
    ref: null,
    title: page.title,
    url: page.rendered_url,
    summary: description,
    body: text || [`# ${page.title}`, description].filter(Boolean).join("\n\n"),
    status: statusOf(page),
    inForce: null,
    metadata: {
      section: sectionOf(page.source_path),
      pageType: page.page_type ?? null,
      searchTerms: page.search_terms,
      escalation: page.agent?.escalation ?? null,
    },
    related: [],
    // A non-public page without groups is shown to nobody, as on the site.
    visibility: isPublic ? "all" : "groups",
    visibilityGroups: isPublic ? [] : page.allowed_groups.map((group) => `group:${normalizeGroup(group)}`),
    occurredAt: date,
    changedAt: date,
  };
}

export const itkbAdapter = indexAdapter(
  "itkb",
  (row, config) => {
    const ruleSections = itkbConfigSchema.safeParse(config).data?.ruleSections ?? [];
    const section = row.metadata.section;
    return typeof section === "string" && ruleSections.includes(section) && row.status !== "deprecated"
      ? "rules"
      : "knowledge";
  },
  {
    // Bots read the pages meant for everyone the source is open to: pages
    // for all of its access groups, never pages only some of them may read.
    // Its access groups admit only their direct members (`mayUse`), as the
    // site does, so nobody who may use the source is left out of them.
    serviceAudience: (source) => source.accessGroups.map((group) => `group:${normalizeGroup(group)}`),
  },
);
