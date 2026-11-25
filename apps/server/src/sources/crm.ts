import { z } from "zod";
import { MAX_ITEM_TEXT, MAX_SNIPPET } from "@connector/shared/limits";
import { crmConfigSchema, CRM_RECORD_TYPES, type CrmRecordType } from "@connector/shared/api/sources";
import { sourceRequest } from "./http";
import { SourceError, type Adapter, type AdapterContext, type FetchedItem, type Hit } from "./types";

/*
 * CRM (live): its REST API with an API key. A key sees the
 * records shared with it or with the whole organization (CRM docs/api.md),
 * so admins create one for Connector and share with it what everyone who
 * may use this source may see. Webhooks are not used: their payloads skip
 * the CRM's sharing rules.
 */

const APP = "CRM";

const PLURAL: Record<CrmRecordType, string> = {
  contact: "contacts",
  organization: "organizations",
  deal: "deals",
  event: "events",
  meeting: "meetings",
  segment: "segments",
};

const searchSchema = z.object({
  results: z.array(
    z.object({
      type: z.enum(CRM_RECORD_TYPES),
      id: z.string(),
      title: z.string(),
      subtitle: z.string().nullable(),
    }),
  ),
});
const recordSchema = z.looseObject({ id: z.string(), updatedAt: z.string().optional() });
const activitiesSchema = z.object({
  items: z.array(
    z.looseObject({
      type: z.string(),
      title: z.string().nullable().optional(),
      body: z.string().nullable().optional(),
      occurredAt: z.string(),
    }),
  ),
});

function crmConfig(context: Pick<AdapterContext, "config">) {
  return crmConfigSchema.parse(context.config);
}

function apiKey(context: AdapterContext): string {
  const key = context.secret.apiKey;
  if (typeof key !== "string" || key === "")
    throw new SourceError("CRM has no API key: an admin adds one in Connector");
  return key;
}

export const recordUrl = (base: string, type: CrmRecordType, id: string) => `${base}/${PLURAL[type]}/${id}`;

/** Fields never shown: internals and links that only the CRM's browser app uses. */
const HIDDEN = new Set([
  "id",
  "version",
  "access",
  "customFields",
  "createdBy",
  "updatedBy",
  "avatarUrl",
  "autoCreated",
  "emailStatus",
  "deletedAt",
  "firstName",
  "lastName",
  "createdAt",
  "updatedAt",
]);

const label = (key: string) =>
  key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (first) => first.toUpperCase())
    .replace(/\bUrl\b/, "URL");

/** A value as text: refs by their label, lists joined. */
function show(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(show).filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join(", ") : null;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["label", "name", "title", "email"]) {
      if (typeof record[key] === "string" && record[key] !== "") {
        const role = typeof record.role === "string" && record.role ? ` (${record.role})` : "";
        return `${record[key] as string}${role}`;
      }
    }
  }
  return null;
}

/** A record as Markdown: its title, then one line per filled field. */
export function recordText(title: string, record: Record<string, unknown>): string {
  const lines = [`# ${title}`, ""];
  for (const [key, value] of Object.entries(record)) {
    if (HIDDEN.has(key)) continue;
    const text = show(value);
    if (!text) continue;
    if (key === "notes" || text.includes("\n")) lines.push(`**${label(key)}:**`, "", text, "");
    else lines.push(`- **${label(key)}:** ${text}`);
  }
  const custom = record.customFields;
  if (custom && typeof custom === "object") {
    for (const [key, value] of Object.entries(custom as Record<string, unknown>)) {
      const text = show(value);
      if (text) lines.push(`- **${label(key)}:** ${text}`);
    }
  }
  return lines.join("\n").trim();
}

function titleOf(record: Record<string, unknown>, fallback: string): string {
  for (const key of ["name", "title", "label"]) {
    if (typeof record[key] === "string" && record[key] !== "") return record[key] as string;
  }
  return fallback;
}

export const crmAdapter: Adapter = {
  kind: "crm",

  async check(context) {
    const config = crmConfig(context);
    const url = new URL(`${config.baseUrl}/api/v1/search`);
    url.searchParams.set("q", "connector");
    url.searchParams.set("types", config.types.join(","));
    url.searchParams.set("limit", "1");
    await sourceRequest(url.toString(), {
      token: apiKey(context),
      signal: context.signal,
      schema: searchSchema,
      app: APP,
    });
    return `Reached the CRM; searching ${config.types.map((type) => PLURAL[type]).join(", ")}`;
  },

  async search(context, query, limit) {
    const config = crmConfig(context);
    const url = new URL(`${config.baseUrl}/api/v1/search`);
    url.searchParams.set("q", query.slice(0, 200));
    url.searchParams.set("types", config.types.join(","));
    url.searchParams.set("limit", String(Math.min(limit, 50)));
    const data = await sourceRequest(url.toString(), {
      token: apiKey(context),
      signal: context.signal,
      schema: searchSchema,
      app: APP,
    });
    return data.results.slice(0, limit).map((result): Hit => ({
      type: result.type,
      externalId: result.id,
      title: result.title,
      url: recordUrl(config.baseUrl, result.type, result.id),
      snippet: (result.subtitle ?? "").slice(0, MAX_SNIPPET),
      authority: "record",
      date: null,
      status: null,
    }));
  },

  async fetch(context, type, externalId) {
    const parsedType = z.enum(CRM_RECORD_TYPES).safeParse(type);
    if (!parsedType.success || !/^[0-9a-f-]{36}$/i.test(externalId)) return null;
    const config = crmConfig(context);
    const token = apiKey(context);
    let record: z.infer<typeof recordSchema>;
    try {
      record = await sourceRequest(`${config.baseUrl}/api/v1/${PLURAL[parsedType.data]}/${externalId}`, {
        token,
        signal: context.signal,
        schema: recordSchema,
        app: APP,
      });
    } catch (error) {
      if (error instanceof SourceError && error.kind === "not_found") return null;
      throw error;
    }
    const title = titleOf(record, parsedType.data);
    let text = recordText(title, record);
    // The timeline needs activities:read; without it the record stands alone.
    const activities = await sourceRequest(
      `${config.baseUrl}/api/v1/activities?entityType=${parsedType.data}&entityId=${externalId}`,
      { token, signal: context.signal, schema: activitiesSchema, app: APP },
    ).catch(() => null);
    if (activities && activities.items.length > 0) {
      text += "\n\n## Recent activity\n";
      for (const activity of activities.items.slice(0, 15)) {
        const body = (activity.body ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
        text += `\n- ${activity.occurredAt.slice(0, 10)} · ${activity.type}${activity.title ? `: ${activity.title}` : ""}${body ? ` — ${body}` : ""}`;
      }
    }
    const item: FetchedItem = {
      type: parsedType.data,
      externalId,
      title,
      url: recordUrl(config.baseUrl, parsedType.data, externalId),
      authority: "record",
      date: record.updatedAt ?? null,
      status: null,
      text: text.slice(0, MAX_ITEM_TEXT),
      metadata: {
        owner: show(record.owner),
        team: show(record.team),
        tags: Array.isArray(record.tags)
          ? record.tags.filter((tag): tag is string => typeof tag === "string")
          : [],
      },
      related: [],
    };
    return item;
  },

  // The CRM's lists have no change feed that fits every record type.
  async recent() {
    return [];
  },
};
