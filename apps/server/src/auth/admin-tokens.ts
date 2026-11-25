import { and, desc, eq, isNull } from "drizzle-orm";
import type { ServiceToken, TokenCreate, TokenCreated } from "@connector/shared/api/tokens";
import type { Db } from "../db/client";
import { credentials, users } from "../db/schema";
import { audit } from "../core/audit";
import { notFound } from "../http/errors";
import { expiryIn, issueCredential, tokenView } from "./credentials";
import { isOperator, type Actor } from "./principal";

/*
 * Admin tokens: service tokens (bots) and SCIM tokens (identity systems).
 * The admin pages and the operator command (`cli tokens`) run the same code.
 */

export const ADMIN_TOKEN_KINDS = ["service", "scim"] as const;
export type AdminTokenKind = (typeof ADMIN_TOKEN_KINDS)[number];

const LABELS: Record<AdminTokenKind, string> = { service: "service token", scim: "SCIM token" };

/** Who created a token that was made with the operator command. */
const OPERATOR_LABEL = "Operator";

/** The tokens of a kind that are not revoked, newest first. */
export async function listAdminTokens(db: Db, kind: AdminTokenKind): Promise<ServiceToken[]> {
  const rows = await db
    .select({ credential: credentials, createdBy: users.email })
    .from(credentials)
    .leftJoin(users, eq(users.id, credentials.createdById))
    .where(and(eq(credentials.kind, kind), isNull(credentials.revokedAt)))
    .orderBy(desc(credentials.createdAt));
  return rows.map((row) => ({
    ...tokenView(row.credential),
    createdBy: row.credential.createdByOperator ? OPERATOR_LABEL : row.createdBy,
  }));
}

/** A new token; `secret` is shown once and never stored. */
export async function createAdminToken(
  db: Db,
  actor: Actor,
  kind: AdminTokenKind,
  input: TokenCreate,
): Promise<ServiceToken & TokenCreated> {
  const user = isOperator(actor) ? null : actor;
  const created = await db.transaction(async (tx) => {
    const issued = await issueCredential(tx, {
      kind,
      name: input.name,
      userId: null,
      createdById: user?.id ?? null,
      createdByOperator: isOperator(actor),
      expiresAt: expiryIn(input.expiresInDays),
    });
    await audit(tx, actor, {
      action: `${kind}_token.create`,
      entityType: `${kind}_token`,
      entityId: issued.id,
      summary: `Created the ${LABELS[kind]} “${input.name}”`,
    });
    return issued;
  });
  const [row] = await db.select().from(credentials).where(eq(credentials.id, created.id));
  return { ...tokenView(row!), createdBy: user?.email ?? OPERATOR_LABEL, secret: created.secret };
}

/** Ends a token for good. */
export async function revokeAdminToken(
  db: Db,
  actor: Actor,
  kind: AdminTokenKind,
  id: string,
): Promise<{ name: string }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(credentials)
      .set({ revokedAt: new Date() })
      .where(and(eq(credentials.id, id), eq(credentials.kind, kind), isNull(credentials.revokedAt)))
      .returning({ id: credentials.id, name: credentials.name });
    if (!row) throw notFound(`No such ${LABELS[kind]}`);
    await audit(tx, actor, {
      action: `${kind}_token.revoke`,
      entityType: `${kind}_token`,
      entityId: row.id,
      summary: `Revoked the ${LABELS[kind]} “${row.name}”`,
    });
    return { name: row.name };
  });
}
