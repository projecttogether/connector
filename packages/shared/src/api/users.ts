import { z } from "zod";
import { idSchema, NOT_STORABLE_MESSAGE, nullableText, pageQuerySchema, storable } from "./common";

/** The signed-in person. */
export const meSchema = z.object({
  id: idSchema,
  email: z.string(),
  name: z.string(),
  image: z.string().nullable(),
  isAdmin: z.boolean(),
  /** Groups from the sign-in and the directory; they decide which sources the person may use. */
  groups: z.array(z.string()),
});
export type Me = z.infer<typeof meSchema>;

/** Public: what the sign-in page shows. */
export const authConfigSchema = z.object({
  appName: z.string(),
  providerName: z.string(),
});
export type AuthConfig = z.infer<typeof authConfigSchema>;

/** What runs: the version is the commit the image was built from; null for a build from source. */
export const aboutSchema = z.object({ version: z.string().nullable() });
export type About = z.infer<typeof aboutSchema>;

export const DIRECTORY_SOURCES = ["scim", "keycloak"] as const;
export const directorySourceSchema = z.enum(DIRECTORY_SOURCES);

/** A person as admins see them. */
export const personSchema = z.object({
  id: idSchema,
  email: z.string(),
  name: z.string(),
  title: z.string().nullable(),
  isAdmin: z.boolean(),
  /** environment: listed in ADMIN_EMAILS (always admin); app: made admin in the app. */
  adminSource: z.enum(["environment", "app"]).nullable(),
  blocked: z.boolean(),
  /** Who keeps this person up to date: SCIM (e.g. IAM), the Keycloak directory, or nobody. */
  directory: directorySourceSchema.nullable(),
  groups: z.array(z.string()),
  lastSignInAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Person = z.infer<typeof personSchema>;
export const peopleQuerySchema = z.object({ q: z.string().trim().max(100).optional() });
export const peopleListSchema = z.object({ items: z.array(personSchema) });

export const personUpdateSchema = z.object({
  isAdmin: z.boolean().optional(),
  /** Blocked people cannot sign in; their sessions, tokens and connected apps stop working. */
  blocked: z.boolean().optional(),
});
export type PersonUpdate = z.infer<typeof personUpdateSchema>;

/** `DELETE /admin/people/:id`: what lists show instead of a removed person's name. */
export const REMOVED_PERSON_NAME = "Removed person";

/** A colleague in the directory, as people and agents see them (no admin details). */
export const colleagueSchema = z.object({
  name: z.string(),
  email: z.string(),
  title: z.string().nullable(),
  groups: z.array(z.string()),
});
export type Colleague = z.infer<typeof colleagueSchema>;
export const colleagueQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(1, "Enter a name, email address or group")
    .max(100)
    .refine(storable, NOT_STORABLE_MESSAGE),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export const colleagueListSchema = z.object({ items: z.array(colleagueSchema) });

/** A group: from the sign-in claims, the Keycloak directory, SCIM, or made in the app. */
export const groupSchema = z.object({
  id: idSchema,
  name: z.string(),
  source: z.enum(["app", "scim", "keycloak"]),
  members: z.number().int(),
  createdAt: z.string(),
});
export type Group = z.infer<typeof groupSchema>;
export const groupListSchema = z.object({ items: z.array(groupSchema) });
export const groupCreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Add a name")
    .max(200)
    .refine((value) => !/[,\n]/.test(value), "No commas or line breaks"),
});

export const directoryStatusSchema = z.object({
  /** oidc: groups from the sign-in claim; keycloak: also synced from the Keycloak Admin API. */
  mode: z.enum(["oidc", "keycloak"]),
  syncMinutes: z.number().int().nullable(),
  lastSync: z
    .object({
      at: z.string(),
      ok: z.boolean(),
      message: z.string(),
      people: z.number().int(),
      /** Keycloak users left out: their email address is unverified or another person's. */
      skipped: z.number().int(),
    })
    .nullable(),
  /** The SCIM 2.0 endpoint for IAM and other identity systems. */
  scimUrl: z.string(),
  scimPeople: z.number().int(),
});
export type DirectoryStatus = z.infer<typeof directoryStatusSchema>;

export const auditEntrySchema = z.object({
  id: idSchema,
  createdAt: z.string(),
  actorEmail: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  /** Short description, e.g. 'Connected the source Handbook'. Never contains secrets. */
  summary: z.string(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export const auditListQuerySchema = pageQuerySchema;
export const auditListSchema = z.object({ items: z.array(auditEntrySchema), total: z.number().int() });

/** What agents, bots and people asked, and what they got (oversight). */
export const activityEntrySchema = z.object({
  id: idSchema,
  createdAt: z.string(),
  actor: z.string(),
  channel: z.enum(["web", "token", "oauth", "service"]),
  /** The connected app or token name, e.g. "Claude". */
  client: z.string().nullable(),
  action: z.string(),
  query: z.string().nullable(),
  results: z.number().int(),
  /** How each source answered; `error` says why it failed. */
  sources: z.array(
    z.object({ slug: z.string(), ok: z.boolean(), count: z.number().int(), error: z.string().optional() }),
  ),
  ms: z.number().int(),
});
export type ActivityEntry = z.infer<typeof activityEntrySchema>;
export const activityListQuerySchema = pageQuerySchema.extend({
  q: nullableText(100).optional(),
});
export const activityListSchema = z.object({ items: z.array(activityEntrySchema), total: z.number().int() });
