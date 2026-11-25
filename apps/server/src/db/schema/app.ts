import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";

/** PostgreSQL full-text search vector; written with SQL (`to_tsvector`), never read by the app. */
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/** App state by key (e.g. the search languages the index was built with). */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Changes by admins (sources, people, groups, tokens). Never stores secrets. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: text("actor_email"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    summary: text("summary").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_audit_log_created").on(table.createdAt)],
);

/**
 * A connected app (docs/sources.md): its kind, address, who may use it, and
 * its credentials. `secret_encrypted` holds a JSON object of the kind's
 * secrets (service token, API key, webhook secret), encrypted with
 * ENCRYPTION_KEY; it is never sent to the browser.
 */
export const sources = pgTable("sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Starts item IDs (`<slug>:<type>:<id>`) and the webhook URL (/hooks/<slug>). */
  slug: text("slug").notNull().unique(),
  /** handbook, logbook, library, crm, notion or itkb (`@connector/shared/sources`). */
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  enabled: boolean("enabled").notNull().default(true),
  /** Settings of the kind that are not secret (base URL, rule spaces, record types). */
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  secretEncrypted: text("secret_encrypted"),
  /** Groups whose members may use the source; empty: everyone signed in. */
  accessGroups: text("access_groups")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  /** Service tokens may read the content meant for everyone. */
  serviceAccess: boolean("service_access").notNull().default(false),
  /** Order among sources of the same level in lists. */
  position: integer("position").notNull().default(0),
  /** The last connection check or webhook delivery: { at, ok, message }. */
  status: jsonb("status").$type<{ at: string; ok: boolean; message: string }>(),
  lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),
  /**
   * Connector's own registration at the source's OAuth server (Handbook),
   * for linked accounts: { clientId, clientSecret?, issuer }, encrypted.
   */
  oauthClientEncrypted: text("oauth_client_encrypted"),
  ...timestamps,
});

/**
 * Content that webhook sources (Logbook, Library) sent, as the search index
 * of those sources. The app stays its home: every delivery replaces the
 * item, a removal deletes it, and deleting the source deletes its items.
 */
export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    /** The item's ID in the app. */
    externalId: text("external_id").notNull(),
    /** decision, update, learning, note. */
    type: text("type").notNull(),
    /** The app's reference, e.g. LB-12, LIB-3. */
    ref: text("ref"),
    title: text("title").notNull(),
    url: text("url").notNull(),
    /** One or two sentences, for results. */
    summary: text("summary").notNull().default(""),
    /** The whole item as text, for fetch and search. */
    body: text("body").notNull().default(""),
    /** E.g. "in force", "superseded by LB-14". */
    status: text("status"),
    /** decision only: in force (not superseded, not rejected). */
    inForce: boolean("in_force"),
    /** Facts shown with the item (team, tags, decider, …). */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    /** References of items it points to: { ref, relation }. */
    related: jsonb("related").$type<{ ref: string; relation: string }[]>().notNull().default([]),
    /**
     * Who may see it inside the source: `all` (everyone who may use the
     * source) or `groups` (members of `visibility_groups`, matched by name
     * or Keycloak group ID).
     */
    visibility: text("visibility").notNull().default("all"),
    visibilityGroups: text("visibility_groups")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Published, decided or last changed in the app. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    changedAt: timestamp("changed_at", { withTimezone: true }),
    searchVector: tsvector("search_vector"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("idx_items_source_external").on(table.sourceId, table.externalId),
    index("idx_items_source_ref").on(table.sourceId, table.ref),
    index("idx_items_changed").on(table.changedAt),
    index("idx_items_search").using("gin", table.searchVector),
  ],
);

/**
 * Groups of the directory: pushed by SCIM (e.g. IAM), synced from
 * Keycloak, or made in the app for SCIM clients that only fill groups.
 * Groups from the sign-in claim live on the person (`users.sign_in_groups`).
 */
export const groups = pgTable(
  "groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The display name or Keycloak path, e.g. /staff/it; what access rules name. */
    name: text("name").notNull().unique(),
    /** app, scim or keycloak. */
    source: text("source").notNull(),
    /** The ID in the identity system: SCIM externalId, Keycloak group ID. */
    externalId: text("external_id"),
    ...timestamps,
  },
  (table) => [index("idx_groups_external").on(table.externalId)],
);

export const groupMembers = pgTable(
  "group_members",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.userId] }),
    index("idx_group_members_user").on(table.userId),
  ],
);

/**
 * A person's account at a source, linked through the source's OAuth server
 * (Handbook): Connector then reads and proposes there as that person.
 * `tokens_encrypted`: { accessToken, refreshToken, expiresAt }.
 */
export const sourceLinks = pgTable(
  "source_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokensEncrypted: text("tokens_encrypted").notNull(),
    /** Who the account is at the source (name or email), when it says. */
    label: text("label"),
    ...timestamps,
  },
  (table) => [uniqueIndex("idx_source_links_source_user").on(table.sourceId, table.userId)],
);

/** A link being made: from Connector to the source's consent screen and back. */
export const linkRequests = pgTable("link_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id")
    .notNull()
    .references(() => sources.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** SHA-256 of the state parameter. */
  stateHash: text("state_hash").notNull().unique(),
  /** The PKCE verifier, encrypted. */
  verifierEncrypted: text("verifier_encrypted").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * What people, agents and bots asked and what they got (oversight): who,
 * through which app, which tool, the search words, and how each source
 * answered. Kept ACTIVITY_LOG_DAYS days; never the results' content.
 */
export const activity = pgTable(
  "activity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    credentialId: uuid("credential_id"),
    /** The person's name, or the service token's name. */
    actor: text("actor").notNull(),
    channel: text("channel").notNull(),
    client: text("client"),
    /** search, fetch, context, recent, people, knowledge, propose. */
    action: text("action").notNull(),
    query: text("query"),
    results: integer("results").notNull().default(0),
    /** How each source answered; `error` is the source's short failure message. */
    sources: jsonb("sources")
      .$type<{ slug: string; ok: boolean; count: number; error?: string }[]>()
      .notNull()
      .default([]),
    ms: integer("ms").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_activity_created").on(table.createdAt)],
);

/**
 * Credentials of agents and integrations, stored as SHA-256 hashes:
 * personal access tokens, service tokens (bots), SCIM tokens (identity
 * systems), and the access and refresh tokens of connected apps (OAuth).
 */
export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** personal, service, scim, oauth_access or oauth_refresh. */
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    prefix: text("prefix").notNull(),
    /** The person a personal or OAuth token acts as; null for service tokens. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    grantId: uuid("grant_id"),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    /** Created with the operator command, so by no user. */
    createdByOperator: boolean("created_by_operator").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** Service and SCIM tokens: the last time something sent it after it was revoked or expired. */
    lastRejectedAt: timestamp("last_rejected_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_credentials_user").on(table.userId),
    index("idx_credentials_grant").on(table.grantId),
  ],
);

/** Apps that may ask people to connect them (OAuth clients): registered or by metadata document. */
export const oauthClients = pgTable("oauth_clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Generated for dynamic registration; the document URL for metadata documents. */
  clientId: text("client_id").notNull().unique(),
  /** dynamic or metadata_document. */
  registration: text("registration").notNull(),
  secretHash: text("secret_hash"),
  name: text("name").notNull(),
  clientUri: text("client_uri"),
  redirectUris: text("redirect_uris").array().notNull(),
  /** none, client_secret_post or client_secret_basic. */
  tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull().default("none"),
  /** When the metadata document was last read. */
  fetchedAt: timestamp("fetched_at", { withTimezone: true }),
  ...timestamps,
});

/** A person's consent for a connected app; revoking it ends all its tokens. */
export const oauthGrants = pgTable(
  "oauth_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_oauth_grants_user").on(table.userId)],
);

/** A pending sign-in of a connected app, from /oauth/authorize to the consent and code. */
export const oauthRequests = pgTable("oauth_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => oauthClients.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  state: text("state"),
  codeChallenge: text("code_challenge").notNull(),
  scope: text("scope"),
  resource: text("resource"),
  /** The person who opened the consent screen first; only they may decide. */
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  /** SHA-256 of the authorization code, once approved. */
  codeHash: text("code_hash").unique(),
  grantId: uuid("grant_id"),
  codeUsedAt: timestamp("code_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
