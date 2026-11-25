import type { z } from "zod";
import { SourceError, type FailureKind } from "./types";

/*
 * Every call to an app goes through here: the caller's signal, no
 * redirects (a moved app is a configuration error), a size limit and
 * Connector's user agent. Failures become `SourceError` with a kind and a
 * diagnostic in Connector's own words, never the token or the body.
 */

/** Largest answer read from a source. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const USER_AGENT = "Connector";

/** An app's answer: its status and its JSON (null when empty; `json` false when not JSON). */
export type SourceAnswer = { status: number; ok: boolean; data: unknown; json: boolean };

/**
 * One request to an app. Whatever the status, the answer comes back;
 * unreachable, too slow, redirected or too large is a `SourceError`.
 */
export async function sourceFetch(
  url: string,
  options: {
    signal: AbortSignal;
    /** What to call the app in messages, e.g. "Handbook". */
    app: string;
    method?: "GET" | "POST" | "PUT" | "DELETE";
    token?: string | null;
    /** A JSON body, or a form (`application/x-www-form-urlencoded`). */
    json?: unknown;
    form?: Record<string, string>;
  },
): Promise<SourceAnswer> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? (options.json === undefined && !options.form ? "GET" : "POST"),
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.json !== undefined ? { "content-type": "application/json" } : {}),
        ...(options.form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: options.form
        ? new URLSearchParams(options.form)
        : options.json === undefined
          ? undefined
          : JSON.stringify(options.json),
      redirect: "manual",
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal.aborted) throw new SourceError(`${options.app} did not answer in time`);
    throw new SourceError(
      `Could not reach ${options.app} at ${new URL(url).origin}: ${fetchErrorCode(error)}`,
    );
  }
  if (response.status >= 300 && response.status < 400) {
    throw new SourceError(`${options.app} redirected the request; check the address`);
  }
  const text = await readLimited(response, options.app, options.signal);
  try {
    return { status: response.status, ok: response.ok, data: text ? JSON.parse(text) : null, json: true };
  } catch {
    return { status: response.status, ok: response.ok, data: null, json: false };
  }
}

/**
 * A request to a connected app's JSON API with a bearer token; the answer
 * must match `schema`. An error status becomes a `SourceError` of its kind,
 * quoting the app's `{ error: { message } }` for people and agents.
 */
export async function sourceRequest<T extends z.ZodType>(
  url: string,
  options: {
    token: string | null;
    signal: AbortSignal;
    schema: T;
    method?: "GET" | "POST" | "PUT" | "DELETE";
    body?: unknown;
    /** What to call the app in messages, e.g. "Handbook". */
    app: string;
  },
): Promise<z.infer<T>> {
  const answer = await sourceFetch(url, {
    signal: options.signal,
    app: options.app,
    method: options.method ?? "GET",
    token: options.token,
    json: options.body,
  });
  if (!answer.ok) {
    const quoted = errorMessage(answer.data, options.token);
    const fail = (kind: FailureKind, words: string, quote: string | null = null) =>
      new SourceError(quote ? `${words}: ${quote}` : words, { kind, diagnostic: words });
    if (answer.status === 401) throw fail("refused", `${options.app} refused the credentials`, quoted);
    if (answer.status === 403) throw fail("refused", `${options.app} does not allow this`, quoted);
    if (answer.status === 404) throw fail("not_found", `${options.app} has no such item`);
    throw fail(
      answer.status === 422 ? "rejected" : "failed",
      `${options.app} answered HTTP ${answer.status}`,
      quoted,
    );
  }
  if (!answer.json) throw new SourceError(`${options.app} did not answer with JSON; check the address`);
  const parsed = options.schema.safeParse(answer.data);
  if (!parsed.success) throw new SourceError(`${options.app} sent an answer Connector does not understand`);
  return parsed.data;
}

/** The body, read as it arrives and given up beyond the size limit. */
async function readLimited(response: Response, app: string, signal: AbortSignal): Promise<string> {
  const tooMuch = () => new SourceError(`${app} sent too much data`);
  if (Number(response.headers.get("content-length") ?? "0") > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw tooMuch();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw tooMuch();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SourceError) throw error;
    if (signal.aborted) throw new SourceError(`${app} did not answer in time`);
    throw new SourceError(`${app} broke off its answer`);
  }
  // TextDecoder drops a byte order mark, as JSON.parse needs.
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Why a request failed, as a code (ECONNREFUSED, ENOTFOUND, …): never the
 * error's message, which can quote request headers.
 */
function fetchErrorCode(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" ? cause.code : "connection failed";
}

/** The `{ error: { message } }` of a connected app, shortened, and never with the token it got. */
function errorMessage(data: unknown, token: string | null): string | null {
  const error = (data as { error?: unknown } | null)?.error;
  const message =
    typeof error === "object" && error !== null ? (error as { message?: unknown }).message : undefined;
  if (typeof message !== "string") return null;
  return (token ? message.replaceAll(token, "…") : message).slice(0, 200);
}
