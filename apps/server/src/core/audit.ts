import { lt, sql } from "drizzle-orm";
import { config } from "../config";
import type { DbOrTx } from "../db/client";
import { auditLog } from "../db/schema";
import { isOperator, type Actor } from "../auth/principal";

/**
 * Records a change by an admin, or by the operator command, which shows as
 * the actor `operator` with its command after the summary. `summary` must
 * never contain secrets.
 */
export async function audit(
  db: DbOrTx,
  actor: Actor | null,
  entry: { action: string; entityType: string; entityId?: string | null; summary: string },
) {
  const operator = isOperator(actor) ? actor : null;
  const user = isOperator(actor) ? null : actor;
  await db.insert(auditLog).values({
    actorUserId: user?.id ?? null,
    actorEmail: operator ? "operator" : (user?.email ?? null),
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    // The command stays whole, also after a long summary.
    summary: operator
      ? `${entry.summary.slice(0, 500 - operator.command.length - 3)} (${operator.command})`
      : entry.summary.slice(0, 500),
  });
}

/** Deletes entries older than AUDIT_LOG_DAYS (the worker's cleanup); 0 keeps them all. */
export async function pruneAuditLog(db: DbOrTx, days = config().AUDIT_LOG_DAYS): Promise<number> {
  if (days === 0) return 0;
  const result = await db
    .delete(auditLog)
    .where(lt(auditLog.createdAt, sql`now() - make_interval(days => ${days})`));
  return result.rowCount ?? 0;
}
