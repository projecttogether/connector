import { count, eq, sql } from "drizzle-orm";
import type { SourceCheck, SourceState } from "@connector/shared/api/sources";
import type { Problem, SourceHealth } from "@connector/shared/api/status";
import { SOURCE_KIND_INFO } from "@connector/shared/sources";
import { config } from "../config";
import type { Db } from "../db/client";
import { activity, items, sources } from "../db/schema";
import { getSetting, putSetting } from "../core/settings";
import { getSource, inSourceOrder, isWebhookKind, kindOf, secretOf, secretState } from "./service";
import type { SourceRow } from "./types";
import { administerSource } from "./use";

/*
 * Source health (docs/architecture.md, "Source health"): how each source is
 * doing. Four signals make it up: the last check of a live source (an
 * admin's button or the worker, as Connector itself), the last delivery or
 * refused delivery of a webhook source, the reads of agents and bots in the
 * activity log, and whether its credentials are there and readable. This
 * module records checks and deliveries, and judges all four signals.
 *
 * One judgment, so "working" means the same everywhere, for two readers:
 * - `sourcesHealth` (the status page): a state per source, the problems
 *   that need an admin, agents' reads and the worker's checks.
 * - `sourceStateJudge` (the home page and `list_sources`): the same state,
 *   nothing more.
 */

const MINUTE = 60_000;

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);
const msOf = (value: string | null | undefined) => (value ? Date.parse(value) : 0);

/** Settings key: when the worker last checked the live sources. */
const SOURCE_CHECKS_SETTING = "source_checks";

/**
 * A status `{ at, ok, message }` stamped with the database's time, like
 * deliveries and webhook secrets, so the setup guide compares one clock.
 */
const statusNow = (ok: boolean, message: string) =>
  sql`jsonb_build_object('at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'ok', ${ok}::boolean, 'message', ${message.slice(0, 300)}::text)`;

async function recordStatus(db: Db, id: string, ok: boolean, message: string) {
  await db
    .update(sources)
    .set({ status: statusNow(ok, message) })
    .where(eq(sources.id, id));
}

/** A check uses only the source's own credentials (service token, API key), never a person's. */
async function runCheck(db: Db, row: SourceRow): Promise<SourceCheck> {
  const use = await administerSource(db, row, (adapter, context) => adapter.check(context), "check");
  const result: SourceCheck = use.ok
    ? { ok: true, message: use.value }
    : { ok: false, message: use.error.message };
  await recordStatus(db, row.id, result.ok, result.message);
  return result;
}

/** Checks a source's address and credentials and stores the outcome. */
export async function checkSource(db: Db, id: string): Promise<SourceCheck> {
  return runCheck(db, await getSource(db, id));
}

/**
 * Checks every enabled live source (SOURCE_CHECK_MINUTES), so a refused
 * token or an app that is down shows on the status page before people
 * notice. Webhook sources report through their deliveries instead.
 */
export async function checkLiveSources(db: Db): Promise<number> {
  const rows = (await db.select().from(sources).where(eq(sources.enabled, true))).filter(
    (row) => !isWebhookKind(row.kind),
  );
  await Promise.all(rows.map((row) => runCheck(db, row)));
  await putSetting(db, SOURCE_CHECKS_SETTING, { at: new Date().toISOString() });
  return rows.length;
}

/**
 * What a webhook source sent: a delivery Connector took (`message` says
 * what), or one it refused for its signature or for a payload that is not
 * of the source's kind.
 */
export type Delivery = { ok: true; message: string } | { ok: false; refused: "signature" | "payload" };

/** What each webhook kind delivers, for the refusal of a payload of another kind. */
const DELIVERS: Record<string, string> = { logbook: "a Logbook entry", library: "a Library note" };

/** Marks a delivery: the last delivery time and the status; a refusal changes the status only. */
export async function recordDelivery(db: Db, row: SourceRow, delivery: Delivery) {
  if (!delivery.ok) {
    await recordStatus(
      db,
      row.id,
      false,
      delivery.refused === "signature"
        ? "A delivery had a wrong signature: check that both sides use the same secret"
        : `A delivery did not look like ${DELIVERS[row.kind] ?? "what Connector understands"}`,
    );
    return;
  }
  await db
    .update(sources)
    .set({ lastDeliveryAt: sql`now()`, status: statusNow(true, delivery.message) })
    .where(eq(sources.id, row.id));
}

type Requests = {
  total: number;
  failed: number;
  lastOkAt: number;
  lastFailedAt: number;
  lastError: string | null;
};

/**
 * Requests of agents and bots per source slug in the last 24 hours (the
 * activity log), since the current source with that slug was created.
 * Reads only: a proposal that fails says more about the proposal (a page
 * that moved, no linked account) than about the source.
 */
async function requestsBySlug(db: Db): Promise<Map<string, Requests>> {
  const { rows } = await db.execute<{
    slug: string;
    total: number;
    failed: number;
    last_ok_ms: number | null;
    last_failed_ms: number | null;
    last_error: string | null;
  }>(sql`
    select s->>'slug' as slug,
           count(*)::int as total,
           (count(*) filter (where (s->>'ok')::boolean is false))::int as failed,
           (extract(epoch from max(a.created_at) filter (where (s->>'ok')::boolean)) * 1000)::float8 as last_ok_ms,
           (extract(epoch from max(a.created_at) filter (where (s->>'ok')::boolean is false)) * 1000)::float8
             as last_failed_ms,
           (array_agg(s->>'error' order by a.created_at desc) filter (where (s->>'ok')::boolean is false))[1]
             as last_error
    from ${activity} a
      cross join lateral jsonb_array_elements(a.sources) s
      join ${sources} src on src.slug = s->>'slug' and a.created_at >= src.created_at
    where a.created_at > now() - interval '24 hours' and a.action <> 'propose'
    group by 1`);
  return new Map(
    rows.map((row) => [
      row.slug,
      {
        total: row.total,
        failed: row.failed,
        lastOkAt: row.last_ok_ms ?? 0,
        lastFailedAt: row.last_failed_ms ?? 0,
        lastError: row.last_error,
      },
    ]),
  );
}

type SourceVerdict = { state: SourceState; problem: Omit<Problem, "key" | "area" | "sourceId"> | null };

/** A source's state and the problem it has, the most urgent first. */
function judgeSource(row: SourceRow, requests: Requests | undefined): SourceVerdict {
  const kind = kindOf(row);
  const name = row.name;
  const app = SOURCE_KIND_INFO[kind].label;
  if (!row.enabled) return { state: "off", problem: null };
  const secrets = secretState(row);
  if (secrets === "unreadable") {
    return {
      state: "setup",
      problem: {
        severity: "error",
        title: `Connector cannot read the credentials of ${name}`,
        detail: "ENCRYPTION_KEY changed since they were saved. Enter them again.",
      },
    };
  }
  const secret = secrets === "ok" ? secretOf(row) : {};
  const has = (key: string) => typeof secret[key] === "string" && secret[key] !== "";
  if (kind === "crm" && !has("apiKey")) {
    return {
      state: "setup",
      problem: {
        severity: "error",
        title: `${name} has no API key`,
        detail: "Create one in the CRM and add it here; until then the CRM is not searched.",
      },
    };
  }
  if (kind === "notion" && !has("integrationSecret")) {
    return {
      state: "setup",
      problem: {
        severity: "error",
        title: `${name} has no integration secret`,
        detail: "Create an integration in Notion and add its secret here; until then Notion is not searched.",
      },
    };
  }
  if (kind === "handbook" && !has("serviceToken")) {
    const linking = row.config.allowLinking !== false;
    return {
      state: "setup",
      problem: {
        severity: linking ? "warning" : "error",
        title: `${name} has no service token`,
        detail: linking
          ? "Only people who linked their Handbook account get its pages; bots get none."
          : "Nobody gets its pages until an admin adds a service token from Handbook.",
      },
    };
  }
  const webhook = isWebhookKind(kind);
  if (webhook && !has("webhookSecret")) {
    return {
      state: "setup",
      problem: {
        severity: "error",
        title: `${name} has no webhook secret`,
        detail: `Connector refuses deliveries from ${app} until both sides share a secret.`,
      },
    };
  }
  if (row.status && !row.status.ok) {
    return {
      state: "failing",
      problem: { severity: "error", title: `${name} is failing`, detail: row.status.message },
    };
  }
  // The latest request of an agent or bot failed: failing until a request works
  // again, whatever a check says (a check may test another path, e.g. the
  // service token instead of linked accounts). Earlier failures only count.
  if (requests && requests.failed > 0 && requests.lastFailedAt > requests.lastOkAt) {
    return {
      state: "failing",
      problem: {
        severity: "error",
        title: `${name} failed its latest requests`,
        detail: `${requests.failed} of ${requests.total} requests of agents and bots failed in the last 24 hours${
          requests.lastError ? `; the last one: ${requests.lastError}` : ""
        }. This clears with the next request that works.`,
      },
    };
  }
  if (webhook && !row.lastDeliveryAt) {
    return {
      state: "waiting",
      problem: {
        severity: "warning",
        title: `Waiting for the first delivery from ${name}`,
        detail:
          kind === "itkb"
            ? `Add the webhook's URL and secret to the ${app}'s CI secrets. It sends every page after each deploy of its main branch.`
            : `Enter the webhook's URL and secret in ${app}. It delivers when something is published or changed there, and everything in its first nightly run (02:30) at the latest.`,
      },
    };
  }
  if (!webhook && !row.status) return { state: "unchecked", problem: null };
  return { state: "ok", problem: null };
}

/**
 * How every source is doing, in the source order, with the problems that
 * need an admin, and whether the worker still checks the live sources (the
 * status page). Everything is read from the database; nothing calls the apps.
 */
export async function sourcesHealth(db: Db): Promise<{
  sources: SourceHealth[];
  problems: Problem[];
  sourceChecks: { minutes: number | null; lastRunAt: string | null };
}> {
  const now = Date.now();
  const problems: Problem[] = [];

  const rows = inSourceOrder(await db.select().from(sources));
  const counted = await db
    .select({ sourceId: items.sourceId, value: count() })
    .from(items)
    .groupBy(items.sourceId);
  const itemCounts = new Map(counted.map((row) => [row.sourceId, row.value]));
  const requests = await requestsBySlug(db);
  const sourceHealth: SourceHealth[] = rows.map((row) => {
    const kind = kindOf(row);
    const webhook = isWebhookKind(kind);
    const used = requests.get(row.slug);
    const verdict = judgeSource(row, used);
    if (verdict.problem) {
      problems.push({ key: `source:${row.id}`, area: "source", sourceId: row.id, ...verdict.problem });
    }
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      kind,
      enabled: row.enabled,
      delivery: webhook ? "webhook" : "live",
      state: verdict.state,
      status: row.status ?? null,
      items: webhook ? (itemCounts.get(row.id) ?? 0) : null,
      lastDeliveryAt: iso(row.lastDeliveryAt),
      requests: {
        total: used?.total ?? 0,
        failed: used?.failed ?? 0,
        lastError:
          used?.lastError && used.lastFailedAt
            ? { at: new Date(used.lastFailedAt).toISOString(), message: used.lastError }
            : null,
      },
    };
  });

  // The worker: its source checks show that it runs.
  const checkMinutes = config().SOURCE_CHECK_MINUTES || null;
  const checks = await getSetting(db, SOURCE_CHECKS_SETTING);
  const lastRunAt = typeof checks?.at === "string" ? checks.at : null;
  if (checkMinutes) {
    const late = (3 * checkMinutes + 5) * MINUTE;
    const stale = lastRunAt ? now - msOf(lastRunAt) > late : process.uptime() * 1000 > late;
    if (stale) {
      problems.push({
        key: "worker",
        area: "source",
        sourceId: null,
        severity: "warning",
        title: "The worker seems to be stopped",
        detail: `It checks the live sources every ${checkMinutes} minutes, but ${
          lastRunAt ? "the last check is much older" : "it has not checked them yet"
        }. Check that the worker process runs.`,
      });
    }
  }

  return { sources: sourceHealth, problems, sourceChecks: { minutes: checkMinutes, lastRunAt } };
}

/**
 * How sources are doing for people (the home page) and agents
 * (`list_sources`): the state the status page shows, without the problems,
 * which are for admins. Reads the activity log once; the judge it returns
 * gives each source's state.
 */
export async function sourceStateJudge(db: Db): Promise<(row: SourceRow) => SourceState> {
  const requests = await requestsBySlug(db);
  return (row) => judgeSource(row, requests.get(row.slug)).state;
}
