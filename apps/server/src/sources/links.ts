import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { config } from "../config";
import type { Db, DbOrTx } from "../db/client";
import { linkRequests, sourceLinks, sources } from "../db/schema";
import { decryptJson, decryptSecret, encryptJson, encryptSecret } from "../core/crypto";
import { logger } from "../logger";
import type { UserPrincipal } from "../auth/principal";
import { mayUse } from "./service";
import { sourceFetch } from "./http";
import { SourceError, type SourceRow } from "./types";

/*
 * Linked accounts (docs/sources.md, "Linked accounts"): Connector is an
 * OAuth 2.1 client of a source's authorization server, the same way MCP
 * clients connect: protected resource metadata (RFC 9728), authorization
 * server metadata (RFC 8414), dynamic client registration (RFC 7591),
 * authorization code with PKCE (S256) and the resource indicator
 * (RFC 8707). Handbook runs such a server. Tokens are stored encrypted;
 * refreshing takes a row lock, because a refresh token works once.
 */

/** Linking and unlinking in the web app: discovery, registration and the token request together. */
const FLOW_TIMEOUT_MS = 20_000;
const REQUEST_MINUTES = 10;
const DISCOVERY_CACHE_MS = 60 * 60_000;

const resourceMetadataSchema = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()).min(1),
});
const serverMetadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string().optional(),
  revocation_endpoint: z.string().optional(),
  scopes_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
});
const registrationSchema = z.object({ client_id: z.string(), client_secret: z.string().optional() });
const tokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
});

type Discovery = { resource: string; server: z.infer<typeof serverMetadataSchema> };
type OAuthClient = { clientId: string; clientSecret?: string; issuer: string; redirectUri: string };
type Tokens = { accessToken: string; refreshToken?: string; expiresAt: number };

const discoveries = new Map<string, { at: number; value: Discovery }>();

export const linkRedirectUri = () => `${config().APP_URL}/api/v1/links/callback`;

const baseUrlOf = (source: SourceRow) => String(source.config.baseUrl ?? "").replace(/\/+$/, "");

/** Whether a person may link their account at a source: Handbook, linking on, open to them. */
export function mayLink(principal: UserPrincipal, source: SourceRow): boolean {
  return source.kind === "handbook" && source.config.allowLinking !== false && mayUse(principal, source);
}

/** Every discovered address must be on the source's own origin: tokens and the client secret go there. */
function sameOrigin(source: SourceRow, address: string): boolean {
  try {
    return new URL(address).origin === new URL(baseUrlOf(source)).origin;
  } catch {
    return false;
  }
}

async function getJson<T extends z.ZodType>(
  source: SourceRow,
  url: string,
  schema: T,
  signal: AbortSignal,
): Promise<z.infer<T>> {
  const answer = await sourceFetch(url, { signal, app: source.name });
  // Fixed words: the address can come from the source's metadata (and end up in the activity log).
  if (!answer.ok) throw new SourceError(`The source's sign-in metadata answered HTTP ${answer.status}`);
  const parsed = schema.safeParse(answer.data);
  if (!parsed.success)
    throw new SourceError("The source's sign-in metadata is not what Connector understands");
  return parsed.data;
}

/** An OAuth request; 400 and 401 mean the server refused the grant or the client. */
async function postForm<T extends z.ZodType>(
  source: SourceRow,
  url: string,
  form: Record<string, string>,
  schema: T,
  signal: AbortSignal,
): Promise<z.infer<T>> {
  const answer = await sourceFetch(url, { signal, app: source.name, form });
  if (!answer.ok) {
    const code = (answer.data as { error?: unknown } | null)?.error;
    throw new SourceError(
      `The sign-in server refused: ${typeof code === "string" ? code : `HTTP ${answer.status}`}`,
      {
        kind: answer.status === 400 || answer.status === 401 ? "refused" : "failed",
        diagnostic: "The sign-in server refused",
      },
    );
  }
  const parsed = schema.safeParse(answer.data);
  if (!parsed.success)
    throw new SourceError("The sign-in server sent an answer Connector does not understand");
  return parsed.data;
}

/** The source's protected resource and authorization server, cached for an hour. */
export async function discover(source: SourceRow, signal: AbortSignal): Promise<Discovery> {
  const base = baseUrlOf(source);
  const cached = discoveries.get(base);
  if (cached && Date.now() - cached.at < DISCOVERY_CACHE_MS) return cached.value;
  const resource = await getJson(
    source,
    `${base}/.well-known/oauth-protected-resource`,
    resourceMetadataSchema,
    signal,
  );
  const issuer = resource.authorization_servers[0]!.replace(/\/+$/, "");
  if (!sameOrigin(source, issuer)) {
    throw new SourceError("The source's sign-in server is on another address than the source");
  }
  const server = await getJson(
    source,
    `${issuer}/.well-known/oauth-authorization-server`,
    serverMetadataSchema,
    signal,
  );
  if (!(server.code_challenge_methods_supported ?? []).includes("S256")) {
    throw new SourceError("The source's sign-in server does not support PKCE (S256)");
  }
  const endpoints = [
    issuer,
    server.issuer,
    server.authorization_endpoint,
    server.token_endpoint,
    server.registration_endpoint,
    server.revocation_endpoint,
  ].filter((address): address is string => typeof address === "string");
  if (!endpoints.every((address) => sameOrigin(source, address))) {
    throw new SourceError("The source's sign-in server is on another address than the source");
  }
  const value = { resource: resource.resource, server };
  discoveries.set(base, { at: Date.now(), value });
  return value;
}

/** Connector's registration at the source (dynamic client registration), made once. */
async function oauthClient(
  db: DbOrTx,
  source: SourceRow,
  discovery: Discovery,
  signal: AbortSignal,
): Promise<OAuthClient> {
  const fits = (stored: Partial<OAuthClient>): stored is OAuthClient =>
    Boolean(stored.clientId) &&
    stored.issuer === discovery.server.issuer &&
    stored.redirectUri === linkRedirectUri();
  const known = source.oauthClientEncrypted ? decryptJson<OAuthClient>(source.oauthClientEncrypted) : {};
  if (fits(known)) return known;
  // One registration per source: the first request registers under the row
  // lock; one that waited reads the registration it made.
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ stored: sources.oauthClientEncrypted, config: sources.config })
      .from(sources)
      .where(eq(sources.id, source.id))
      .for("update");
    // The discovery belongs to the address the request started with; a moved source registers anew.
    if (!row || baseUrlOf({ ...source, config: row.config }) !== baseUrlOf(source)) {
      throw new SourceError("The source moved meanwhile; try again");
    }
    const stored = row.stored ? decryptJson<OAuthClient>(row.stored) : {};
    if (fits(stored)) return stored;
    if (!discovery.server.registration_endpoint) {
      throw new SourceError("The source's sign-in server does not offer dynamic client registration");
    }
    const answer = await sourceFetch(discovery.server.registration_endpoint, {
      signal,
      app: source.name,
      json: {
        client_name: /^connector$/i.test(config().APP_NAME)
          ? "Connector"
          : `${config().APP_NAME} (Connector)`,
        client_uri: config().APP_URL,
        redirect_uris: [linkRedirectUri()],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post",
      },
    });
    const parsed = registrationSchema.safeParse(answer.data);
    if (!answer.ok || !parsed.success) {
      const description = (answer.data as { error_description?: unknown } | null)?.error_description;
      throw new SourceError(
        `The source refused Connector's registration${typeof description === "string" ? `: ${description.slice(0, 200)}` : ""}`,
        { diagnostic: "The source refused Connector's registration" },
      );
    }
    const client: OAuthClient = {
      clientId: parsed.data.client_id,
      clientSecret: parsed.data.client_secret,
      issuer: discovery.server.issuer,
      redirectUri: linkRedirectUri(),
    };
    await tx
      .update(sources)
      .set({ oauthClientEncrypted: encryptJson(client), updatedAt: sql`now()` })
      .where(eq(sources.id, source.id));
    return client;
  });
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Starts linking: the URL of the source's consent screen. */
export async function startLink(db: Db, source: SourceRow, userId: string): Promise<string> {
  const signal = AbortSignal.timeout(FLOW_TIMEOUT_MS);
  const discovery = await discover(source, signal);
  const client = await oauthClient(db, source, discovery, signal);
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  await db.insert(linkRequests).values({
    sourceId: source.id,
    userId,
    stateHash: sha256(state),
    verifierEncrypted: encryptSecret(verifier),
    expiresAt: new Date(Date.now() + REQUEST_MINUTES * 60_000),
  });
  const url = new URL(discovery.server.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", client.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", discovery.resource);
  if (discovery.server.scopes_supported?.length)
    url.searchParams.set("scope", discovery.server.scopes_supported.join(" "));
  return url.toString();
}

function clientAuth(client: OAuthClient): Record<string, string> {
  return client.clientSecret
    ? { client_id: client.clientId, client_secret: client.clientSecret }
    : { client_id: client.clientId };
}

function tokensOf(answer: z.infer<typeof tokenSchema>, previous?: Tokens): Tokens {
  return {
    accessToken: answer.access_token,
    refreshToken: answer.refresh_token ?? previous?.refreshToken,
    expiresAt: Date.now() + (answer.expires_in ?? 3600) * 1000,
  };
}

/** Who the account is at the source, for the settings page (Handbook: GET /api/v1/me). */
async function accountLabel(
  source: SourceRow,
  accessToken: string,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const answer = await sourceFetch(`${baseUrlOf(source)}/api/v1/me`, {
      signal,
      app: source.name,
      token: accessToken,
    });
    if (!answer.ok) return null;
    const me = answer.data as { email?: unknown; name?: unknown } | null;
    return typeof me?.email === "string" ? me.email : typeof me?.name === "string" ? me.name : null;
  } catch {
    return null;
  }
}

/**
 * Finishes linking on the way back from the consent screen. Only the person
 * who started may finish. Returns the source's slug.
 */
export async function finishLink(
  db: Db,
  principal: UserPrincipal,
  query: { code?: string; state?: string; error?: string; iss?: string },
): Promise<string> {
  const userId = principal.id;
  if (!query.state) throw new SourceError("The link request is incomplete");
  const [request] = await db
    .delete(linkRequests)
    .where(eq(linkRequests.stateHash, sha256(query.state)))
    .returning();
  if (!request || request.expiresAt < new Date())
    throw new SourceError("The link request expired; start again");
  if (request.userId !== userId) throw new SourceError("This link was started by someone else");
  const [source] = await db.select().from(sources).where(eq(sources.id, request.sourceId));
  if (!source || !mayLink(principal, source)) throw new SourceError("You may no longer link this source");
  if (query.error)
    throw new SourceError(
      query.error === "access_denied" ? "You declined the link" : `The source refused: ${query.error}`,
    );
  if (!query.code) throw new SourceError("The source sent no authorization code");
  const signal = AbortSignal.timeout(FLOW_TIMEOUT_MS);
  const discovery = await discover(source, signal);
  if (query.iss && query.iss.replace(/\/+$/, "") !== discovery.server.issuer.replace(/\/+$/, "")) {
    throw new SourceError("The answer came from another sign-in server");
  }
  const client = await oauthClient(db, source, discovery, signal);
  const answer = await postForm(
    source,
    discovery.server.token_endpoint,
    {
      grant_type: "authorization_code",
      code: query.code,
      redirect_uri: client.redirectUri,
      code_verifier: decryptSecret(request.verifierEncrypted),
      resource: discovery.resource,
      ...clientAuth(client),
    },
    tokenSchema,
    signal,
  );
  const tokens = tokensOf(answer);
  const label = await accountLabel(source, tokens.accessToken, signal);
  await db.transaction(async (tx) => {
    // The tokens belong to the address the link started at; a source moved meanwhile gets none.
    const [now] = await tx
      .select({ config: sources.config })
      .from(sources)
      .where(eq(sources.id, source.id))
      .for("update");
    if (!now || baseUrlOf({ ...source, config: now.config }) !== baseUrlOf(source)) {
      throw new SourceError("The source moved while you linked it; start again");
    }
    await tx
      .insert(sourceLinks)
      .values({ sourceId: source.id, userId, tokensEncrypted: encryptJson(tokens), label })
      .onConflictDoUpdate({
        target: [sourceLinks.sourceId, sourceLinks.userId],
        set: { tokensEncrypted: encryptJson(tokens), label, updatedAt: sql`now()` },
      });
  });
  return source.slug;
}

/**
 * The person's access token at the source, refreshed when it ends within a
 * minute; null without a link, or when the source ended it (the link is then
 * removed and the person links again).
 */
export async function linkedAccessToken(
  db: Db,
  source: SourceRow,
  userId: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (source.kind !== "handbook" || source.config.allowLinking === false) return null;
  const [link] = await db
    .select()
    .from(sourceLinks)
    .where(and(eq(sourceLinks.sourceId, source.id), eq(sourceLinks.userId, userId)));
  if (!link) return null;
  const tokens = decryptJson<Tokens>(link.tokensEncrypted) as Tokens;
  if (tokens.expiresAt - Date.now() > 60_000) return tokens.accessToken;
  return refresh(db, source, link.id, signal);
}

async function refresh(
  db: Db,
  source: SourceRow,
  linkId: string,
  signal: AbortSignal,
): Promise<string | null> {
  // Registration (if any) before the transaction, so the source lock below stays shared.
  const discovery = await discover(source, signal);
  const client = await oauthClient(db, source, discovery, signal);
  return db.transaction(async (tx) => {
    // Source row first (shared: refreshes of different links run side by
    // side), then the link: the order every change of a source takes.
    await tx.select({ id: sources.id }).from(sources).where(eq(sources.id, source.id)).for("share");
    const [link] = await tx.select().from(sourceLinks).where(eq(sourceLinks.id, linkId)).for("update");
    if (!link) return null;
    const tokens = decryptJson<Tokens>(link.tokensEncrypted) as Tokens;
    // Another request refreshed it while this one waited for the lock.
    if (tokens.expiresAt - Date.now() > 60_000) return tokens.accessToken;
    if (!tokens.refreshToken) {
      await tx.delete(sourceLinks).where(eq(sourceLinks.id, linkId));
      return null;
    }
    try {
      const answer = await postForm(
        source,
        discovery.server.token_endpoint,
        {
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
          resource: discovery.resource,
          ...clientAuth(client),
        },
        tokenSchema,
        signal,
      );
      const next = tokensOf(answer, tokens);
      await tx
        .update(sourceLinks)
        .set({ tokensEncrypted: encryptJson(next), updatedAt: sql`now()` })
        .where(eq(sourceLinks.id, linkId));
      return next.accessToken;
    } catch (error) {
      if (error instanceof SourceError && error.kind === "refused") {
        logger.info({ linkId }, "the source ended a linked account; removed");
        await tx.delete(sourceLinks).where(eq(sourceLinks.id, linkId));
        return null;
      }
      throw error;
    }
  });
}

/** Removes a link and revokes its tokens at the source (best effort). */
export async function unlink(db: Db, source: SourceRow, userId: string): Promise<boolean> {
  const [link] = await db
    .delete(sourceLinks)
    .where(and(eq(sourceLinks.sourceId, source.id), eq(sourceLinks.userId, userId)))
    .returning();
  if (!link) return false;
  try {
    const tokens = decryptJson<Tokens>(link.tokensEncrypted) as Tokens;
    const signal = AbortSignal.timeout(FLOW_TIMEOUT_MS);
    const discovery = await discover(source, signal);
    if (discovery.server.revocation_endpoint && tokens.refreshToken) {
      const client = await oauthClient(db, source, discovery, signal);
      await postForm(
        source,
        discovery.server.revocation_endpoint,
        { token: tokens.refreshToken, token_type_hint: "refresh_token", ...clientAuth(client) },
        z.unknown(),
        signal,
      );
    }
  } catch (error) {
    // A source's failure in Connector's own words: its answer could echo the token.
    if (error instanceof SourceError) {
      logger.info(
        { sourceId: source.id, reason: error.diagnostic },
        "could not revoke a linked account at the source",
      );
    } else
      logger.warn({ err: error, sourceId: source.id }, "could not revoke a linked account at the source");
  }
  return true;
}

/** Removes link requests that were never finished. */
export async function pruneLinkRequests(db: DbOrTx) {
  await db.delete(linkRequests).where(lt(linkRequests.expiresAt, new Date()));
}

/** Tests only. */
export function clearDiscoveryCache() {
  discoveries.clear();
}
