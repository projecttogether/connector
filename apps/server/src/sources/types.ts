import type { Authority, SourceKind } from "@connector/shared/sources";
import type { Item, SearchResult } from "@connector/shared/api/search";
import type { Db } from "../db/client";
import type { sources } from "../db/schema";
import type { Principal } from "../auth/principal";

export type SourceRow = typeof sources.$inferSelect;

/** A result before Connector adds the source's name and slug. */
export type Hit = Omit<SearchResult, "source" | "id"> & { type: string; externalId: string };

/** A fetched item before Connector adds the source. */
export type FetchedItem = Omit<Item, "source" | "id"> & { type: string; externalId: string };

/** What an adapter gets for one request. */
export type AdapterContext = {
  db: Db;
  source: SourceRow;
  config: Record<string, unknown>;
  secret: Record<string, unknown>;
  principal: Principal;
  /** Ends when the source's time is up or the caller went away. */
  signal: AbortSignal;
};

/**
 * One kind of app (docs/sources.md). Live adapters ask the app; webhook
 * adapters read Connector's index of what the app sent.
 */
export type Adapter = {
  kind: SourceKind;
  /** Checks address and credentials; returns a short message, throws `SourceError`. */
  check(context: AdapterContext): Promise<string>;
  search(context: AdapterContext, query: string, limit: number): Promise<Hit[]>;
  /** One item, or null when it does not exist or the caller may not see it. */
  fetch(context: AdapterContext, type: string, externalId: string): Promise<FetchedItem | null>;
  /** What changed since `since`, newest first. */
  recent(context: AdapterContext, since: Date, limit: number): Promise<Hit[]>;
};

/**
 * Why a source failed, for callers that act on it: the app has no such
 * thing; it refused the credentials or the grant; it refused the request
 * as invalid; anything else (unreachable, too slow, an answer Connector
 * does not understand, a setup that is missing).
 */
export type FailureKind = "not_found" | "refused" | "rejected" | "failed";

/**
 * A source that did not answer as expected. The message is shown to people
 * and agents and may quote the app; the diagnostic is Connector's own words
 * only, for the activity log (by default the message, when it quotes nothing).
 */
export class SourceError extends Error {
  readonly kind: FailureKind;
  readonly diagnostic: string;

  constructor(message: string, options: { kind?: FailureKind; diagnostic?: string } = {}) {
    super(message);
    this.name = "SourceError";
    this.kind = options.kind ?? "failed";
    this.diagnostic = options.diagnostic ?? message;
  }
}

export type { Authority };
