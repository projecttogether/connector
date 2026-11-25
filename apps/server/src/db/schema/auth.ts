import { sql } from "drizzle-orm";
import { bigint, boolean, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * People who sign in, and people the directory (SCIM, Keycloak) knows
 * before their first sign-in. The authentication library reads and writes
 * this table and the ones below; property names follow its field names.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** Always lowercase. */
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    /** Job title, from the directory (SCIM). */
    title: text("title"),
    /** Admins connect sources and manage people, groups and tokens. */
    isAdmin: boolean("is_admin").notNull().default(false),
    /** environment (ADMIN_EMAILS) or app (made admin by another admin); null when not an admin. */
    adminSource: text("admin_source"),
    /** Blocked people cannot sign in; their sessions and tokens stop working. */
    blockedAt: timestamp("blocked_at", { withTimezone: true }),
    /** app (an admin) or directory (SCIM or Keycloak deactivated them); the directory lifts only its own blocks. */
    blockedBy: text("blocked_by"),
    /** Groups of the last sign-in (OIDC_GROUPS_CLAIM). */
    signInGroups: text("sign_in_groups")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** scim or keycloak: who keeps this person up to date; null when nobody does. */
    directorySource: text("directory_source"),
    /** The person's ID there: the SCIM externalId, or the Keycloak user ID. */
    directoryId: text("directory_id"),
    lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_users_admin").on(table.isAdmin), index("idx_users_directory").on(table.directoryId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_sessions_user").on(table.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_accounts_user").on(table.userId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_verifications_identifier").on(table.identifier)],
);

export const authRateLimits = pgTable("auth_rate_limits", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});
