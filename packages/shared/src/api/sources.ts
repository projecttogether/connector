import { z } from "zod";
import { idSchema, nullableText } from "./common";
import { sourceKindSchema, sourceSlugSchema } from "../sources";

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
    kind: z.literal("logbook"),
    slug: sourceSlugSchema,
    ...sharedFields,
    config: logbookConfigSchema,
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
