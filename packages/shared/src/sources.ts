import { z } from "zod";

/**
 * The kinds of apps Connector connects (docs/sources.md). Each kind has one
 * adapter on the server that knows the app's API or webhook, its item types,
 * links back to the app, and who may see what.
 *
 * - live: Connector asks the app at every request (nothing is copied).
 * - webhook: the app sends its content; Connector keeps a search index of it
 *   and drops what the app removes.
 */
export const SOURCE_KINDS = ["handbook", "logbook", "library", "crm"] as const;
export const sourceKindSchema = z.enum(SOURCE_KINDS);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export type Delivery = "live" | "webhook";

export type SourceKindInfo = {
  label: string;
  /** What the app holds, for people and agents. */
  holds: string;
  delivery: Delivery;
  /** The building block of the AI Operating System it fills. */
  block: string;
  /** Item types the adapter returns. */
  types: string[];
};

export const SOURCE_KIND_INFO: Record<SourceKind, SourceKindInfo> = {
  handbook: {
    label: "Handbook",
    holds: "What is true for the organization and how it works: policies, guides, playbooks",
    delivery: "live",
    block: "Knowledge base",
    types: ["page"],
  },
  logbook: {
    label: "Logbook",
    holds: "What happened and what was decided, in time order: decisions, updates, learnings",
    delivery: "webhook",
    block: "Logbook",
    types: ["decision", "update", "learning"],
  },
  library: {
    label: "Library",
    holds: "What others know: studies, reports and articles, each with a checked source note",
    delivery: "webhook",
    block: "Library",
    types: ["note"],
  },
  crm: {
    label: "CRM",
    holds: "Who the organization works with: contacts, organizations, deals, events, meetings",
    delivery: "live",
    block: "Records",
    types: ["contact", "organization", "deal", "event", "meeting", "segment"],
  },
};

/**
 * The source order of the AI Operating System: when sources disagree, the
 * higher one wins. Every result carries its level.
 */
export const AUTHORITIES = ["rules", "decision", "knowledge", "history", "record", "library"] as const;
export const authoritySchema = z.enum(AUTHORITIES);
export type Authority = z.infer<typeof authoritySchema>;

export const AUTHORITY_LABELS: Record<Authority, string> = {
  rules: "Purpose and rules",
  decision: "Decisions in force",
  knowledge: "Knowledge base",
  history: "Logbook history",
  record: "Records",
  library: "Library",
};

export const AUTHORITY_DESCRIPTIONS: Record<Authority, string> = {
  rules: "Handbook pages in the spaces that hold the purpose and the rules",
  decision: "Logbook decisions that are in force; the newest wins",
  knowledge: "Handbook pages",
  history: "Logbook updates, learnings, and decisions no longer in force",
  record: "CRM records",
  library: "Library notes about outside sources",
};

/** Lower is stronger. */
export function authorityRank(authority: Authority): number {
  return AUTHORITIES.indexOf(authority);
}

/** A source's slug: lowercase letters, digits and hyphens; it starts item IDs (`<slug>:<type>:<id>`). */
export const sourceSlugSchema = z
  .string()
  .trim()
  .min(2, "Use at least 2 characters")
  .max(40)
  .regex(/^[a-z][a-z0-9-]*$/, "Use lowercase letters, digits and hyphens, starting with a letter");

/** `<source slug>:<type>:<id in the app>`, e.g. `handbook:page:3f2c…`. */
export type ItemRef = { source: string; type: string; externalId: string };

export function formatItemId(ref: ItemRef): string {
  return `${ref.source}:${ref.type}:${ref.externalId}`;
}

export function parseItemId(id: string): ItemRef | null {
  const match = /^([a-z][a-z0-9-]*):([a-z_]+):(.{1,200})$/.exec(id.trim());
  // No app has a NUL character in an ID, and PostgreSQL cannot look one up.
  if (!match || id.includes("\u0000")) return null;
  return { source: match[1]!, type: match[2]!, externalId: match[3]! };
}
