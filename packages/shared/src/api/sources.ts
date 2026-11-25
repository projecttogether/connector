import { z } from "zod";
import { idSchema, nullableText } from "./common";
import { NOTION_AUTHORITIES, sourceKindSchema, sourceSlugSchema } from "../sources";

const baseUrlSchema = z
  .url({ protocol: /^https?$/, message: "Enter the app's address, e.g. https://handbook.example.org" })
  .max(500)
  .transform((value) => value.replace(/\/+$/, ""));

const groupListSchema = z
  .array(z.string().trim().min(1).max(200))
  .max(50)
  .transform((groups) => [...new Set(groups)]);

const spaceSlugListSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "Use the space's slug, e.g. policies"),
  )
  .max(20);

export const CRM_RECORD_TYPES = ["contact", "organization", "deal", "event", "meeting", "segment"] as const;
export const crmRecordTypeSchema = z.enum(CRM_RECORD_TYPES);
export type CrmRecordType = z.infer<typeof crmRecordTypeSchema>;

/** Notion's API; a Notion source may name another (a proxy). */
export const NOTION_API_URL = "https://api.notion.com";

/** Where people open Notion when a source names no workspace address. */
export const NOTION_APP_URL = "https://www.notion.so";

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/**
 * A Notion ID from a link or the ID itself, as a lowercase UUID with
 * hyphens: `https://www.notion.so/<workspace>/Wiki-1a2b…?v=…`, `1a2b…` and
 * `1a2b3c4d-…` give the same. Null when there is none. A link's last path
 * segment counts; its view (`?v=`) does not.
 */
export function notionIdOf(value: string): string | null {
  let text = value.trim();
  if (/^https?:\/\//i.test(text)) {
    try {
      text = new URL(text).pathname.split("/").filter(Boolean).at(-1) ?? "";
    } catch {
      return null;
    }
  }
  const hex = UUID.test(text) ? text.replaceAll("-", "") : /(?:^|-)([0-9a-f]{32})$/i.exec(text)?.[1];
  if (!hex) return null;
  const id = hex.toLowerCase();
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

const notionIdSchema = z
  .string()
  .trim()
  .max(500)
  .transform((value, context) => {
    const id = notionIdOf(value);
    if (!id) context.addIssue({ code: "custom", message: "Paste the database's link or ID" });
    return id ?? "";
  });

/** A Notion database Connector searches, and its level in the source order. */
export const notionDatabaseSchema = z.object({
  id: notionIdSchema,
  authority: z.enum(NOTION_AUTHORITIES).default("knowledge"),
});
export type NotionDatabase = z.infer<typeof notionDatabaseSchema>;

/** Databases of one Notion source; more mean more requests to Notion on every search. */
export const MAX_NOTION_DATABASES = 10;

/** Settings of each kind that are not secret. */
export const handbookConfigSchema = z.object({
  baseUrl: baseUrlSchema,
  /** Spaces that hold the purpose and the rules: their pages rank first (source order). */
  ruleSpaces: spaceSlugListSchema.default([]),
  /** People may link their Handbook account, so agents see their drafts and can propose changes. */
  allowLinking: z.boolean().default(true),
});
export const crmConfigSchema = z.object({
  baseUrl: baseUrlSchema,
  /** Record types searched; the API key needs the read scope of each. */
  types: z.array(crmRecordTypeSchema).min(1).default(["contact", "organization", "deal", "event", "meeting"]),
});
export const logbookConfigSchema = z.object({
  baseUrl: baseUrlSchema,
});
export const notionConfigSchema = z.object({
  /** The workspace address people open, e.g. https://www.notion.so/example-org; results link to their pages. */
  baseUrl: baseUrlSchema.default(NOTION_APP_URL),
  /** The databases searched: pages in other databases or outside one are never shown. */
  databases: z
    .array(notionDatabaseSchema)
    .min(1, "Add a database")
    .max(MAX_NOTION_DATABASES, `Add at most ${MAX_NOTION_DATABASES} databases`)
    .refine(
      (databases) => new Set(databases.map((database) => database.id)).size === databases.length,
      "Add each database once",
    ),
  /** Notion's API: its integration secret goes there. Change only for a proxy. */
  apiUrl: baseUrlSchema.default(NOTION_API_URL),
});
/** Sections of the IT Knowledge Base: a page's folder below `docs/` in its repository, e.g. `policies`. */
const sectionListSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "Use the section's folder name, e.g. policies"),
  )
  .max(20);

export const itkbConfigSchema = z.object({
  baseUrl: baseUrlSchema,
  /** Sections whose pages hold rules staff must follow: they rank with purpose and rules (source order). */
  ruleSections: sectionListSchema.default(["policies"]),
});
export const libraryConfigSchema = z.object({
  baseUrl: baseUrlSchema,
  /**
   * Team notes are shown to members of `<prefix>/<team name>`, e.g. prefix
   * `/teams` for the team "Programs" means the group `/teams/Programs`.
   * Members of the Keycloak group whose ID the note names always see them
   * (DIRECTORY=keycloak). Empty: only the Keycloak group ID counts.
   */
  teamGroupPrefix: nullableText(200).default(null),
});

/** A token sent as a bearer header: printable characters, no spaces or line breaks. */
const tokenSchema = z
  .string()
  .trim()
  .max(300)
  .regex(/^[\x21-\x7e]*$/, "Paste the token without spaces or line breaks");

/** Secrets of each kind; stored encrypted, never shown again (blank keeps the stored one). */
export const handbookSecretSchema = z.object({ serviceToken: tokenSchema.optional() });
export const crmSecretSchema = z.object({ apiKey: tokenSchema.optional() });
/** The internal integration secret of a Notion integration (Notion's integration settings). */
export const notionSecretSchema = z.object({ integrationSecret: tokenSchema.optional() });
export const webhookSecretSchema = z.object({
  webhookSecret: z.string().trim().min(16, "Use at least 16 characters").max(300).optional(),
});

const sharedFields = {
  name: z.string().trim().min(1, "Add a name").max(80),
  description: nullableText(500).default(null),
  enabled: z.boolean().default(true),
  /** Groups whose members may use the source; empty: everyone signed in. */
  accessGroups: groupListSchema.default([]),
  /** Service tokens (bots) may read the content meant for everyone. */
  serviceAccess: z.boolean().default(false),
};

export const sourceCreateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("handbook"),
    slug: sourceSlugSchema,
    ...sharedFields,
    config: handbookConfigSchema,
    secret: handbookSecretSchema.default({}),
  }),
  z.object({
    kind: z.literal("crm"),
    slug: sourceSlugSchema,
    ...sharedFields,
    config: crmConfigSchema,
    secret: crmSecretSchema.default({}),
  }),
  z.object({
    kind: z.literal("notion"),
    slug: sourceSlugSchema,
    ...sharedFields,
    config: notionConfigSchema,
    secret: notionSecretSchema.default({}),
  }),
  z.object({
    kind: z.literal("logbook"),
    slug: sourceSlugSchema,
    ...sharedFields,
    config: logbookConfigSchema,
    secret: webhookSecretSchema.default({}),
  }),
  z.object({
    kind: z.literal("itkb"),
    slug: sourceSlugSchema,
    ...sharedFields,
    config: itkbConfigSchema,
    secret: webhookSecretSchema.default({}),
  }),
  z.object({
    kind: z.literal("library"),
    slug: sourceSlugSchema,
    ...sharedFields,
    config: libraryConfigSchema,
    secret: webhookSecretSchema.default({}),
  }),
]);
export type SourceCreate = z.infer<typeof sourceCreateSchema>;

/** Changes; the kind and slug stay. `config` replaces the stored settings; secret fields left out stay. */
export const sourceUpdateSchema = z.object({
  name: sharedFields.name.optional(),
  description: nullableText(500).optional(),
  enabled: z.boolean().optional(),
  accessGroups: groupListSchema.optional(),
  serviceAccess: z.boolean().optional(),
  position: z.number().int().min(0).max(1000).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secret: z.record(z.string(), z.unknown()).optional(),
});
export type SourceUpdate = z.infer<typeof sourceUpdateSchema>;

export const sourceStatusSchema = z.object({
  at: z.string(),
  ok: z.boolean(),
  message: z.string(),
});
export type SourceStatus = z.infer<typeof sourceStatusSchema>;

/** A source as admins see it. */
export const sourceSchema = z.object({
  id: idSchema,
  slug: z.string(),
  kind: sourceKindSchema,
  name: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  accessGroups: z.array(z.string()),
  serviceAccess: z.boolean(),
  position: z.number().int(),
  config: z.record(z.string(), z.unknown()),
  /** Which secret fields are stored, with their last characters. */
  secrets: z.record(z.string(), z.string()),
  /** Where the app sends its webhook (webhook kinds). */
  webhookUrl: z.string().nullable(),
  /** The last connection check or webhook delivery. */
  status: sourceStatusSchema.nullable(),
  /** Indexed items (webhook kinds) and the last delivery. */
  stats: z.object({ items: z.number().int(), lastDeliveryAt: z.string().nullable() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Source = z.infer<typeof sourceSchema>;
export const sourceListSchema = z.object({ items: z.array(sourceSchema) });

/**
 * How a source is doing (source health), the same for admins (the status
 * page), people (the home page) and agents (`list_sources`); the first that
 * applies:
 * - off: turned off;
 * - setup: credentials are missing or cannot be read;
 * - failing: its last check or delivery failed, or its latest requests did;
 * - waiting: a webhook source that has not delivered yet;
 * - unchecked: a live source not checked yet;
 * - ok: working.
 */
export const sourceStateSchema = z.enum(["ok", "failing", "waiting", "setup", "unchecked", "off"]);
export type SourceState = z.infer<typeof sourceStateSchema>;

/** A source as people and agents see it: what it holds and how it is doing. */
export const sourceSummarySchema = z.object({
  slug: z.string(),
  kind: sourceKindSchema,
  name: z.string(),
  description: z.string().nullable(),
  holds: z.string(),
  delivery: z.enum(["live", "webhook"]),
  url: z.string(),
  /** As the status page judges it; never `off` (people and agents get enabled sources only). */
  state: sourceStateSchema,
  /** People may link their account at this source (Handbook). */
  linkable: z.boolean(),
  /** The person linked their account. */
  linked: z.boolean(),
});
export type SourceSummary = z.infer<typeof sourceSummarySchema>;
export const sourceSummaryListSchema = z.object({ items: z.array(sourceSummarySchema) });

export const sourceCheckSchema = z.object({ ok: z.boolean(), message: z.string() });
export type SourceCheck = z.infer<typeof sourceCheckSchema>;

/** Handbook's spaces, read with the service token: admins pick the rule spaces from them. */
export const handbookSpaceListSchema = z.object({
  items: z.array(z.object({ slug: z.string(), name: z.string() })),
});
export type HandbookSpaceList = z.infer<typeof handbookSpaceListSchema>;

/** A generated webhook secret, shown once; it becomes the app's signing secret. */
export const webhookSecretCreatedSchema = z.object({
  webhookSecret: z.string(),
  /** When it took effect: later deliveries were checked against it. */
  createdAt: z.string(),
});
export type WebhookSecretCreated = z.infer<typeof webhookSecretCreatedSchema>;

/** A person's linked account at a source (Handbook, through its OAuth server). */
export const linkSchema = z.object({
  source: z.string(),
  sourceName: z.string(),
  /** Who the account belongs to at the source, if known. */
  label: z.string().nullable(),
  createdAt: z.string(),
});
export type Link = z.infer<typeof linkSchema>;
export const linkListSchema = z.object({ items: z.array(linkSchema) });
export const linkStartSchema = z.object({ authorizeUrl: z.string() });
