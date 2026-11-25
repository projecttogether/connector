import { lt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { oauthRequests } from "../db/schema";
import { pruneExpiredCredentials } from "../auth/credentials";
import { pruneUnusedClients } from "../oauth/clients";
import { pruneAuditLog } from "../core/audit";
import { pruneActivity } from "../search/federate";
import { pruneLinkRequests } from "../sources/links";

/**
 * Removes expired sign-in requests and tokens of connected apps, unused
 * OAuth clients, unfinished account links, and old audit and activity log
 * entries.
 */
export async function pruneExpired(db: Db) {
  await db.delete(oauthRequests).where(lt(oauthRequests.expiresAt, sql`now() - interval '1 day'`));
  await pruneUnusedClients(db);
  await pruneExpiredCredentials(db);
  await pruneLinkRequests(db);
  await pruneAuditLog(db);
  await pruneActivity(db);
}
