import { and, count, desc, eq, inArray, isNull, like, or, gt, sql } from "drizzle-orm";
import type { AdminStatus, Problem } from "@connector/shared/api/status";
import { config } from "../config";
import type { Db } from "../db/client";
import { activity, credentials, groups, oauthClients, oauthGrants, users } from "../db/schema";
import { getSetting } from "../core/settings";
import { notRemoved } from "../people/lifecycle";
import { CONFLICT_EMAIL_DOMAIN, directoryStatus } from "../directory/sync";
import { SCIM_LAST_ERROR, SCIM_LAST_REQUEST } from "../scim/routes";
import { sourcesHealth } from "../sources/health";

/*
 * The admin status page (GET /admin/status): how every source (source
 * health, `sources/health.ts`), the directory, SCIM and the agents are
 * doing, and the problems that need an admin. Everything is read from the
 * database; nothing calls the apps.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Epoch milliseconds from SQL (`extract(epoch …) * 1000`), as an ISO date. */
const isoOfMs = (value: unknown) => (typeof value === "number" ? new Date(value).toISOString() : null);
const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);
const msOf = (value: string | null | undefined) => (value ? Date.parse(value) : 0);

const TOKEN_LABEL = { service: "service token", scim: "SCIM token" } as const;

export async function adminStatus(db: Db): Promise<AdminStatus> {
  const now = Date.now();
  // Sources, and the worker's checks of them.
  const health = await sourcesHealth(db);
  const problems: Problem[] = [...health.problems];

  // Directory.
  const directory = await directoryStatus(db);
  if (directory.mode === "keycloak") {
    const minutes = directory.syncMinutes ?? config().DIRECTORY_SYNC_MINUTES;
    const late = Math.max(3 * minutes, 30) * MINUTE;
    const lastSync = directory.lastSync;
    if (lastSync && !lastSync.ok) {
      problems.push({
        key: "directory",
        area: "directory",
        sourceId: null,
        severity: "error",
        title: "The Keycloak sync failed",
        detail: lastSync.message,
      });
    } else if (lastSync ? now - msOf(lastSync.at) > late : process.uptime() * 1000 > late) {
      problems.push({
        key: "directory",
        area: "directory",
        sourceId: null,
        severity: "warning",
        title: lastSync ? "The Keycloak sync has stopped" : "The Keycloak directory was never synced",
        detail: `The worker syncs it every ${minutes} minutes. Check that the worker runs, or sync now.`,
      });
    }
  }
  const [people] = await db.select({ value: count() }).from(users).where(notRemoved);
  const [groupCount] = await db.select({ value: count() }).from(groups);
  const [conflicts] = await db
    .select({ value: count() })
    .from(users)
    .where(like(users.email, `%@${CONFLICT_EMAIL_DOMAIN}`));
  const skipped = directory.mode === "keycloak" ? (directory.lastSync?.skipped ?? 0) : 0;
  if (skipped > 0) {
    problems.push({
      key: "directory:skipped",
      area: "directory",
      sourceId: null,
      severity: "warning",
      title:
        skipped === 1
          ? "The Keycloak sync left out 1 person"
          : `The Keycloak sync left out ${skipped} people`,
      detail:
        "Their email address in Keycloak is not verified, or another person in Connector has it. Correct it in Keycloak, or remove the other person; the next sync takes them in.",
    });
  }
  if (conflicts && conflicts.value > 0) {
    problems.push({
      key: "people:conflicts",
      area: "people",
      sourceId: null,
      severity: "warning",
      title:
        conflicts.value === 1
          ? "1 person has an email address that someone else has"
          : `${conflicts.value} people have an email address that someone else has`,
      detail: `Keycloak gives them the address of another person in Connector, so the sync set theirs to …@${CONFLICT_EMAIL_DOMAIN}. Correct the address in Keycloak; the next sync takes it over.`,
    });
  }

  // Service and SCIM tokens: expired, expiring, or still sent after they ended.
  const tokens = await db
    .select({
      id: credentials.id,
      kind: credentials.kind,
      name: credentials.name,
      expiresAt: credentials.expiresAt,
      lastUsedAt: credentials.lastUsedAt,
      lastRejectedAt: credentials.lastRejectedAt,
      revokedAt: credentials.revokedAt,
    })
    .from(credentials)
    .where(
      and(
        inArray(credentials.kind, ["service", "scim"]),
        or(isNull(credentials.revokedAt), gt(credentials.lastRejectedAt, new Date(now - 7 * DAY))),
      ),
    )
    .orderBy(desc(credentials.createdAt));
  const active = tokens.filter(
    (token) => !token.revokedAt && (!token.expiresAt || token.expiresAt.getTime() > now),
  );
  for (const token of tokens) {
    const kind = token.kind === "scim" ? "scim" : "service";
    const label = TOKEN_LABEL[kind];
    const area = kind === "scim" ? "scim" : "service-tokens";
    const rejected = token.lastRejectedAt && now - token.lastRejectedAt.getTime() < 7 * DAY;
    const expired = token.expiresAt && token.expiresAt.getTime() <= now;
    if (rejected && (token.revokedAt || expired)) {
      problems.push({
        key: `token:${token.id}`,
        area,
        sourceId: null,
        severity: "error",
        title: `Something still uses the ${label} “${token.name}”`,
        detail: `It ${token.revokedAt ? "was revoked" : "expired"}, so every request with it is refused. Give the ${
          kind === "scim" ? "identity system" : "bot"
        } a new token.`,
      });
    } else if (!token.revokedAt && expired && now - token.expiresAt!.getTime() < 30 * DAY) {
      problems.push({
        key: `token:${token.id}`,
        area,
        sourceId: null,
        severity: "error",
        title: `The ${label} “${token.name}” expired`,
        detail: `Whatever uses it can no longer connect. Create a new token and replace it there.`,
      });
    } else if (
      !token.revokedAt &&
      token.expiresAt &&
      !expired &&
      token.expiresAt.getTime() - now < 14 * DAY
    ) {
      problems.push({
        key: `token:${token.id}`,
        area,
        sourceId: null,
        severity: "warning",
        title: `The ${label} “${token.name}” expires soon`,
        detail: `It stops working on ${token.expiresAt.toISOString().slice(0, 10)}. Create a new token and replace it before then.`,
      });
    }
  }

  // SCIM.
  const lastRequest = await getSetting(db, SCIM_LAST_REQUEST);
  const lastError = await getSetting(db, SCIM_LAST_ERROR);
  const request = (value: Record<string, unknown> | undefined) =>
    value && typeof value.at === "string" && typeof value.message === "string"
      ? { at: value.at, ok: value.ok === true, message: value.message }
      : null;
  const scimLastError = request(lastError);
  if (scimLastError && now - msOf(scimLastError.at) < DAY) {
    problems.push({
      key: "scim",
      area: "scim",
      sourceId: null,
      severity: "warning",
      title: "A request of the identity system failed",
      detail: scimLastError.message,
    });
  }
  const scimTokens = active.filter((token) => token.kind === "scim");
  const serviceTokens = active.filter((token) => token.kind === "service");
  const latest = (list: typeof active) =>
    list.reduce<Date | null>(
      (max, token) => (token.lastUsedAt && (!max || token.lastUsedAt > max) ? token.lastUsedAt : max),
      null,
    );

  // Agents.
  const apps = await db
    .select({
      name: oauthClients.name,
      people: sql<number>`count(distinct ${oauthGrants.userId})::int`,
      lastUsedMs: sql<number | null>`(extract(epoch from max(${oauthGrants.lastUsedAt})) * 1000)::float8`,
    })
    .from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
    .innerJoin(users, eq(users.id, oauthGrants.userId))
    .where(and(isNull(oauthGrants.revokedAt), isNull(users.blockedAt)))
    .groupBy(oauthClients.name)
    .orderBy(sql`2 desc`, oauthClients.name);
  const [personal] = await db
    .select({ value: count() })
    .from(credentials)
    .innerJoin(users, eq(users.id, credentials.userId))
    .where(
      and(
        eq(credentials.kind, "personal"),
        isNull(credentials.revokedAt),
        or(isNull(credentials.expiresAt), gt(credentials.expiresAt, new Date(now))),
        isNull(users.blockedAt),
      ),
    );
  const {
    rows: [week],
  } = await db.execute<{ requests: number; failed: number; people: number; bots: number }>(sql`
    select count(*)::int as requests,
           (count(*) filter (
             where exists (select 1 from jsonb_array_elements(a.sources) s where (s->>'ok')::boolean is false)
           ))::int as failed,
           (count(distinct a.user_id))::int as people,
           (count(distinct a.credential_id) filter (where a.channel = 'service'))::int as bots
    from ${activity} a
    where a.created_at > now() - interval '7 days'`);

  problems.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  return {
    problems,
    sources: health.sources,
    sourceChecks: health.sourceChecks,
    directory: {
      mode: directory.mode,
      syncMinutes: directory.syncMinutes,
      lastSync: directory.lastSync,
      people: people?.value ?? 0,
      groups: groupCount?.value ?? 0,
    },
    scim: {
      url: directory.scimUrl,
      tokens: scimTokens.length,
      people: directory.scimPeople,
      lastUsedAt: iso(latest(scimTokens)),
      lastRequest: request(lastRequest),
      lastError: scimLastError,
    },
    agents: {
      apps: apps.map((app) => ({ name: app.name, people: app.people, lastUsedAt: isoOfMs(app.lastUsedMs) })),
      personalTokens: personal?.value ?? 0,
      serviceTokens: serviceTokens.length,
      serviceLastUsedAt: iso(latest(serviceTokens)),
      week: {
        requests: week?.requests ?? 0,
        failed: week?.failed ?? 0,
        people: week?.people ?? 0,
        bots: week?.bots ?? 0,
      },
    },
  };
}
