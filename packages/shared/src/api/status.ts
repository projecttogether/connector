import { z } from "zod";
import { idSchema } from "./common";
import { sourceStateSchema, sourceStatusSchema } from "./sources";
import { sourceKindSchema } from "../sources";

/** Apps with a setup guide in the web app (Administration → Status). */
export const SETUP_APPS = [
  "handbook",
  "logbook",
  "library",
  "crm",
  "notion",
  "iam",
  "support-agent",
] as const;
export const setupAppSchema = z.enum(SETUP_APPS);
export type SetupApp = z.infer<typeof setupAppSchema>;

export const sourceHealthSchema = z.object({
  id: idSchema,
  slug: z.string(),
  name: z.string(),
  kind: sourceKindSchema,
  enabled: z.boolean(),
  delivery: z.enum(["live", "webhook"]),
  state: sourceStateSchema,
  /** The last check or delivery. */
  status: sourceStatusSchema.nullable(),
  /** Webhook sources: indexed items and the last delivery. */
  items: z.number().int().nullable(),
  lastDeliveryAt: z.string().nullable(),
  /** Requests of agents and bots in the last 24 hours (the activity log). */
  requests: z.object({
    total: z.number().int(),
    failed: z.number().int(),
    lastError: z.object({ at: z.string(), message: z.string() }).nullable(),
  }),
});
export type SourceHealth = z.infer<typeof sourceHealthSchema>;

/** Where an admin fixes a problem; the web app links each area to its page. */
export const problemAreaSchema = z.enum(["source", "directory", "scim", "people", "service-tokens"]);
export type ProblemArea = z.infer<typeof problemAreaSchema>;

export const problemSchema = z.object({
  /** Stable while the problem lasts, e.g. `source:<id>`. */
  key: z.string(),
  severity: z.enum(["error", "warning"]),
  title: z.string(),
  detail: z.string(),
  area: problemAreaSchema,
  /** The source concerned (area `source`). */
  sourceId: idSchema.nullable(),
});
export type Problem = z.infer<typeof problemSchema>;

const lastRequestSchema = z.object({ at: z.string(), ok: z.boolean(), message: z.string() });

/** Everything an admin checks at a glance (GET /admin/status). */
export const adminStatusSchema = z.object({
  /** What needs an admin, errors first. */
  problems: z.array(problemSchema),
  sources: z.array(sourceHealthSchema),
  /** Checks of live sources by the worker (SOURCE_CHECK_MINUTES; null: off). */
  sourceChecks: z.object({ minutes: z.number().int().nullable(), lastRunAt: z.string().nullable() }),
  directory: z.object({
    mode: z.enum(["oidc", "keycloak"]),
    syncMinutes: z.number().int().nullable(),
    lastSync: z
      .object({
        at: z.string(),
        ok: z.boolean(),
        message: z.string(),
        people: z.number().int(),
        skipped: z.number().int(),
      })
      .nullable(),
    people: z.number().int(),
    groups: z.number().int(),
  }),
  scim: z.object({
    url: z.string(),
    tokens: z.number().int(),
    people: z.number().int(),
    /** The last use of any SCIM token. */
    lastUsedAt: z.string().nullable(),
    /** The last SCIM request and the last one that failed. */
    lastRequest: lastRequestSchema.nullable(),
    lastError: lastRequestSchema.nullable(),
  }),
  agents: z.object({
    /** Connected apps (OAuth) by name, with the people who connected them. */
    apps: z.array(
      z.object({ name: z.string(), people: z.number().int(), lastUsedAt: z.string().nullable() }),
    ),
    personalTokens: z.number().int(),
    serviceTokens: z.number().int(),
    /** The last use of any service token (bots). */
    serviceLastUsedAt: z.string().nullable(),
    /** Requests of agents and bots in the last 7 days. */
    week: z.object({
      requests: z.number().int(),
      failed: z.number().int(),
      people: z.number().int(),
      bots: z.number().int(),
    }),
  }),
});
export type AdminStatus = z.infer<typeof adminStatusSchema>;
