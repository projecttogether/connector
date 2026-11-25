import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getDb } from "../db/client";
import type { AppEnv } from "../http/env";
import { logger } from "../logger";
import { removeItem, removeItemsExcept, upsertItem } from "./index-store";
import { itkbItem, itkbPayloadSchema } from "./itkb";
import { libraryItem, libraryPayloadSchema } from "./library";
import { logbookItem, logbookPayloadSchema } from "./logbook";
import { recordDelivery } from "./health";
import { isWebhookKind, secretOf, sourceBySlug } from "./service";

/**
 * Webhooks of the apps at /hooks/<source slug> (docs/sources.md).
 * Logbook, Library and the IT Knowledge Base sign `<timestamp>.<raw body>` with HMAC-SHA256 and
 * the shared webhook secret; Connector checks the signature against the raw
 * body before reading it, in constant time, and refuses timestamps more
 * than five minutes off. Deliveries are idempotent: each carries the whole
 * item, so repeats and retries replace it with the same content.
 */

const MAX_SKEW_SECONDS = 300;

/** Header names of each app; Logbook still sends its old name (Logbuch) too. */
const HEADERS = {
  logbook: {
    timestamp: ["logbook-timestamp", "logbuch-timestamp"],
    signature: ["logbook-signature", "logbuch-signature"],
  },
  library: { timestamp: ["library-timestamp"], signature: ["library-signature"] },
  itkb: { timestamp: ["itkb-timestamp"], signature: ["itkb-signature"] },
} as const;

export function signatureOf(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function validSignature(input: {
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  body: string;
  now?: number;
}): boolean {
  if (!input.timestamp || !input.signature || !/^\d{1,12}$/.test(input.timestamp)) return false;
  const now = input.now ?? Date.now() / 1000;
  if (Math.abs(now - Number(input.timestamp)) > MAX_SKEW_SECONDS) return false;
  const expected = Buffer.from(signatureOf(input.secret, input.timestamp, input.body));
  const received = Buffer.from(input.signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function header(c: Context<AppEnv>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = c.req.header(name);
    if (value) return value;
  }
  return undefined;
}

const pages = (count: number) => (count === 1 ? "1 page" : `${count} pages`);

const reply = (c: Context<AppEnv>, status: 200 | 400 | 401 | 404 | 503, message: string) =>
  c.json(status === 200 ? { ok: true, message } : { error: { code: "webhook_rejected", message } }, status);

export function webhookRoutes() {
  const hooks = new Hono<AppEnv>();
  hooks.use("*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));

  hooks.post("/:slug", async (c) => {
    const db = getDb();
    const source = await sourceBySlug(db, c.req.param("slug"));
    if (!source || !isWebhookKind(source.kind)) return reply(c, 404, "No such webhook");
    const secret = secretOf(source).webhookSecret;
    if (typeof secret !== "string" || secret === "")
      return reply(c, 503, "This source has no webhook secret yet");

    const body = await c.req.text();
    const names = HEADERS[source.kind as keyof typeof HEADERS];
    if (
      !validSignature({
        secret,
        timestamp: header(c, names.timestamp),
        signature: header(c, names.signature),
        body,
      })
    ) {
      logger.warn({ sourceId: source.id }, "webhook refused: bad signature or old timestamp");
      await recordDelivery(db, source, { ok: false, refused: "signature" });
      return reply(c, 401, "Invalid signature");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return reply(c, 400, "The body is not JSON");
    }

    if (source.kind === "logbook") {
      const parsed = logbookPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        await recordDelivery(db, source, { ok: false, refused: "payload" });
        return reply(c, 400, "Not a Logbook entry");
      }
      const item = logbookItem(parsed.data);
      await upsertItem(db, source.id, item);
      await recordDelivery(db, source, { ok: true, message: `Received ${item.ref}` });
      return reply(c, 200, `Stored ${item.ref}`);
    }

    if (source.kind === "itkb") {
      const parsed = itkbPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        await recordDelivery(db, source, { ok: false, refused: "payload" });
        return reply(c, 400, "Not an IT Knowledge Base page");
      }
      if (parsed.data.event === "export.completed") {
        const removed = await removeItemsExcept(db, source.id, parsed.data.page_ids);
        await recordDelivery(db, source, {
          ok: true,
          message: `Received the export of ${pages(parsed.data.page_ids.length)}`,
        });
        return reply(c, 200, removed > 0 ? `Removed ${pages(removed)}` : "Nothing to remove");
      }
      const item = itkbItem(parsed.data.page, parsed.data.chunks);
      if (!item) {
        // Not for answers: what Connector had of it goes.
        await removeItem(db, source.id, parsed.data.page.id);
        await recordDelivery(db, source, { ok: true, message: "Left out a page not meant for answers" });
        return reply(c, 200, "Left out: not meant for answers");
      }
      await upsertItem(db, source.id, item);
      await recordDelivery(db, source, { ok: true, message: `Received ${item.externalId}` });
      return reply(c, 200, "Stored");
    }

    const parsed = libraryPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      await recordDelivery(db, source, { ok: false, refused: "payload" });
      return reply(c, 400, "Not a Library note");
    }
    if (parsed.data.event === "note.removed") {
      await removeItem(db, source.id, parsed.data.note.id);
      await recordDelivery(db, source, { ok: true, message: "Removed a note" });
      return reply(c, 200, "Removed");
    }
    const item = libraryItem(parsed.data.note);
    await upsertItem(db, source.id, item);
    await recordDelivery(db, source, { ok: true, message: `Received ${item.ref}` });
    return reply(c, 200, `Stored ${item.ref}`);
  });

  return hooks;
}
