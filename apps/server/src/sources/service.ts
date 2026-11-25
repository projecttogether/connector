import { randomBytes } from "node:crypto";
import { asc, count, eq, max, sql } from "drizzle-orm";
import {
  NOTION_API_URL,
  type Source,
  type SourceCreate,
  type SourceSummary,
  type SourceUpdate,
} from "@connector/shared/api/sources";
import { SOURCE_KIND_INFO, type SourceKind } from "@connector/shared/sources";
import { config } from "../config";
import type { Db } from "../db/client";
import { items, linkRequests, sourceLinks, sources } from "../db/schema";
import type { Actor, Principal } from "../auth/principal";
import { decryptJson, encryptJson, secretHint, SecretDecryptionError } from "../core/crypto";
import { audit } from "../core/audit";
import { inAnyGroup, inAnyGroupExactly } from "../directory/groups";
import { conflict, notFound, validationError, zodFieldErrors } from "../http/errors";
import { logger } from "../logger";
import { sourceStateJudge } from "./health";
import { KINDS, isSourceKind } from "./registry";
import type { SourceRow } from "./types";

/*
 * Sources: connected apps, their settings and secrets, and who may use
 * them (docs/sources.md). Secrets are stored encrypted and never leave the
 * server; admins see their last characters.
 */

const WEBHOOK_KINDS = new Set<SourceKind>(["logbook", "library", "itkb"]);

export const isWebhookKind = (kind: string) => WEBHOOK_KINDS.has(kind as SourceKind);

/**
 * Kinds whose app admits only members of a group itself, not of its
 * subgroups: the IT Knowledge Base's sign-in proxy. Their access groups do
 * the same, so everyone who may use the source may read what is meant for it.
 */
const EXACT_GROUP_KINDS = new Set<SourceKind>(["itkb"]);

/** The kind of a stored source (rows are written only with known kinds). */
export function kindOf(row: SourceRow): SourceKind {
  if (!isSourceKind(row.kind)) throw new Error(`Unknown source kind: ${row.kind}`);
  return row.kind;
}

export function secretOf(row: SourceRow): Record<string, unknown> {
  try {
    return decryptJson(row.secretEncrypted);
  } catch (error) {
    if (error instanceof SecretDecryptionError) {
      logger.error({ sourceId: row.id }, "a source's secrets cannot be decrypted (ENCRYPTION_KEY changed?)");
      return {};
    }
    throw error;
  }
}

/** Whether a source has stored secrets, and whether ENCRYPTION_KEY still opens them. */
export function secretState(row: SourceRow): "none" | "ok" | "unreadable" {
  if (!row.secretEncrypted) return "none";
  try {
    decryptJson(row.secretEncrypted);
    return "ok";
  } catch (error) {
    if (error instanceof SecretDecryptionError) return "unreadable";
    throw error;
  }
}

function originOf(value: unknown): string | null {
  try {
    return typeof value === "string" ? new URL(value).origin : null;
  } catch {
    return null;
  }
}

/**
 * Where a live source's credentials go: Notion's API, else the app's
 * address. Webhook sources send none.
 */
function credentialsOrigin(kind: string, config: Record<string, unknown>): string | null {
  if (isWebhookKind(kind)) return null;
  return originOf(kind === "notion" ? (config.apiUrl ?? NOTION_API_URL) : config.baseUrl);
}

export const webhookUrl = (slug: string) => `${config().APP_URL}/hooks/${slug}`;

export async function sourceView(db: Db, row: SourceRow): Promise<Source> {
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(secretOf(row))) {
    if (typeof value === "string" && value !== "") secrets[key] = secretHint(value);
  }
  let stats: Source["stats"] = null;
  if (isWebhookKind(row.kind)) {
    const [counted] = await db.select({ value: count() }).from(items).where(eq(items.sourceId, row.id));
    stats = { items: counted?.value ?? 0, lastDeliveryAt: row.lastDeliveryAt?.toISOString() ?? null };
  }
  return {
    id: row.id,
    slug: row.slug,
    kind: kindOf(row),
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    accessGroups: row.accessGroups,
    serviceAccess: row.serviceAccess,
    position: row.position,
    config: row.config,
    secrets,
    webhookUrl: isWebhookKind(row.kind) ? webhookUrl(row.slug) : null,
    status: row.status ?? null,
    stats,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Kinds in the source order of their strongest items: rules (Handbook, IT Knowledge Base), decisions, knowledge (Notion), records, library. */
const KIND_ORDER: Record<SourceKind, number> = {
  handbook: 0,
  itkb: 1,
  logbook: 2,
  notion: 3,
  crm: 4,
  library: 5,
};

/** Sources in the source order of their kind, then by position and name. */
export function inSourceOrder(rows: SourceRow[]): SourceRow[] {
  return [...rows].sort(
    (a, b) =>
      (KIND_ORDER[a.kind as SourceKind] ?? 9) - (KIND_ORDER[b.kind as SourceKind] ?? 9) ||
      a.position - b.position ||
      a.name.localeCompare(b.name),
  );
}

export async function listSources(db: Db): Promise<Source[]> {
  const rows = inSourceOrder(await db.select().from(sources).orderBy(asc(sources.name)));
  return Promise.all(rows.map((row) => sourceView(db, row)));
}

export async function getSource(db: Db, id: string): Promise<SourceRow> {
  const [row] = await db.select().from(sources).where(eq(sources.id, id));
  if (!row) throw notFound("No such source");
  return row;
}

export async function sourceBySlug(db: Db, slug: string): Promise<SourceRow | null> {
  const [row] = await db.select().from(sources).where(eq(sources.slug, slug));
  return row ?? null;
}

function cleanSecret(input: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
    ),
  );
}

export async function createSource(db: Db, actor: Actor, input: SourceCreate): Promise<Source> {
  if (await sourceBySlug(db, input.slug)) {
    throw validationError({ slug: "Another source has this slug" }, "Another source has this slug");
  }
  const [last] = await db.select({ value: max(sources.position) }).from(sources);
  const secret = cleanSecret(input.secret);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(sources)
      .values({
        slug: input.slug,
        kind: input.kind,
        name: input.name,
        description: input.description,
        enabled: input.enabled,
        accessGroups: input.accessGroups,
        serviceAccess: input.serviceAccess,
        position: (last?.value ?? -1) + 1,
        config: input.config,
        secretEncrypted: Object.keys(secret).length > 0 ? encryptJson(secret) : null,
      })
      .returning();
    await audit(tx, actor, {
      action: "source.create",
      entityType: "source",
      entityId: created!.id,
      summary: `Connected the source “${input.name}” (${SOURCE_KIND_INFO[input.kind].label})`,
    });
    return created!;
  });
  return sourceView(db, row);
}

export async function updateSource(db: Db, actor: Actor, id: string, input: SourceUpdate): Promise<Source> {
  const row = await getSource(db, id);
  const kind = KINDS[kindOf(row)];
  const set: Partial<typeof sources.$inferInsert> = { updatedAt: new Date() };
  const changes: string[] = [];
  if (input.name !== undefined && input.name !== row.name) {
    set.name = input.name;
    changes.push(`renamed to “${input.name}”`);
  }
  if (input.description !== undefined && input.description !== row.description) {
    set.description = input.description;
    changes.push("changed its description");
  }
  if (input.enabled !== undefined && input.enabled !== row.enabled) {
    set.enabled = input.enabled;
    changes.push(input.enabled ? "turned on" : "turned off");
  }
  if (input.accessGroups !== undefined) {
    set.accessGroups = input.accessGroups;
    changes.push(
      input.accessGroups.length > 0
        ? `open to ${input.accessGroups.join(", ")}`
        : "open to everyone signed in",
    );
  }
  if (input.serviceAccess !== undefined && input.serviceAccess !== row.serviceAccess) {
    set.serviceAccess = input.serviceAccess;
    changes.push(input.serviceAccess ? "opened to service tokens" : "closed to service tokens");
  }
  if (input.position !== undefined && input.position !== row.position) {
    set.position = input.position;
    changes.push("changed its place in the list");
  }
  if (input.config !== undefined) {
    const parsed = kind.config.safeParse(input.config);
    if (!parsed.success) {
      const fields = Object.fromEntries(
        Object.entries(zodFieldErrors(parsed.error)).map(([key, message]) => [`config.${key}`, message]),
      );
      throw validationError(fields);
    }
    set.config = parsed.data;
    changes.push("changed its settings");
  }
  // Credentials of a live source belong to the address they go to: a new
  // origin drops them (unless new ones come along), the linked accounts and
  // Connector's registration there, so nothing is sent to the new address unasked.
  const moved =
    !isWebhookKind(row.kind) &&
    set.config !== undefined &&
    credentialsOrigin(row.kind, set.config) !== credentialsOrigin(row.kind, row.config);
  if (moved) {
    set.secretEncrypted = null;
    set.oauthClientEncrypted = null;
    set.status = null;
    changes.push("moved to a new address; its credentials and linked accounts were removed");
  }
  if (input.secret !== undefined) {
    const parsed = kind.secret.safeParse(input.secret);
    if (!parsed.success) {
      const fields = Object.fromEntries(
        Object.entries(zodFieldErrors(parsed.error)).map(([key, message]) => [`secret.${key}`, message]),
      );
      throw validationError(fields);
    }
    const given = cleanSecret(parsed.data);
    if (Object.keys(given).length > 0) {
      set.secretEncrypted = encryptJson({ ...(moved ? {} : secretOf(row)), ...given });
      changes.push(`replaced ${Object.keys(given).join(", ")}`);
    }
  }
  const [updated] = await db.transaction(async (tx) => {
    const result = await tx.update(sources).set(set).where(eq(sources.id, id)).returning();
    if (moved) {
      await tx.delete(sourceLinks).where(eq(sourceLinks.sourceId, id));
      await tx.delete(linkRequests).where(eq(linkRequests.sourceId, id));
    }
    if (changes.length > 0) {
      await audit(tx, actor, {
        action: "source.update",
        entityType: "source",
        entityId: id,
        summary: `Source “${row.name}”: ${changes.join("; ")}`,
      });
    }
    return result;
  });
  return sourceView(db, updated!);
}

export async function deleteSource(db: Db, actor: Actor, id: string): Promise<void> {
  const row = await getSource(db, id);
  await db.transaction(async (tx) => {
    // Items, linked accounts and link requests go with it (foreign keys).
    await tx.delete(sources).where(eq(sources.id, id));
    await audit(tx, actor, {
      action: "source.delete",
      entityType: "source",
      entityId: id,
      summary: `Removed the source “${row.name}” and everything Connector kept of it`,
    });
  });
}

/**
 * A new random webhook secret for a webhook source, stored and shown once,
 * with the database time after it took effect: deliveries recorded later
 * were checked against the new secret (setup guide).
 */
export async function rotateWebhookSecret(
  db: Db,
  actor: Actor,
  id: string,
): Promise<{ webhookSecret: string; createdAt: string }> {
  const row = await getSource(db, id);
  if (!isWebhookKind(row.kind)) throw conflict("Only webhook sources have a webhook secret");
  const webhookSecret = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    await tx
      .update(sources)
      .set({ secretEncrypted: encryptJson({ ...secretOf(row), webhookSecret }), updatedAt: new Date() })
      .where(eq(sources.id, id));
    await audit(tx, actor, {
      action: "source.webhook_secret",
      entityType: "source",
      entityId: id,
      summary: `New webhook secret for the source “${row.name}”`,
    });
  });
  const {
    rows: [after],
  } = await db.execute<{ ms: number }>(sql`select (extract(epoch from now()) * 1000)::float8 as ms`);
  return { webhookSecret, createdAt: new Date(after!.ms).toISOString() };
}

/** Whether a caller may use a source (enabled; open to them or to service tokens). */
export function mayUse(principal: Principal, row: SourceRow): boolean {
  if (!row.enabled) return false;
  if (principal.kind === "service") return row.serviceAccess;
  if (row.accessGroups.length === 0) return true;
  const member = EXACT_GROUP_KINDS.has(row.kind as SourceKind) ? inAnyGroupExactly : inAnyGroup;
  return member(principal.groups, row.accessGroups);
}

/** The sources a caller may use, in the source order; `slugs` narrows them. */
export async function usableSources(db: Db, principal: Principal, slugs?: string[]): Promise<SourceRow[]> {
  const rows = inSourceOrder(await db.select().from(sources).where(eq(sources.enabled, true)));
  return rows.filter(
    (row) => mayUse(principal, row) && (!slugs || slugs.length === 0 || slugs.includes(row.slug)),
  );
}

export async function sourceSummaries(db: Db, principal: Principal): Promise<SourceSummary[]> {
  const rows = await usableSources(db, principal);
  const stateOf = await sourceStateJudge(db);
  const links =
    principal.kind === "user"
      ? await db
          .select({ sourceId: sourceLinks.sourceId })
          .from(sourceLinks)
          .where(eq(sourceLinks.userId, principal.id))
      : [];
  return rows.map((row) => {
    const kind = kindOf(row);
    return {
      slug: row.slug,
      kind,
      name: row.name,
      description: row.description,
      holds: SOURCE_KIND_INFO[kind].holds,
      delivery: SOURCE_KIND_INFO[kind].delivery,
      url: String(row.config.baseUrl ?? ""),
      state: stateOf(row),
      linkable: kind === "handbook" && row.config.allowLinking !== false && principal.kind === "user",
      linked: links.some((link) => link.sourceId === row.id),
    };
  });
}
