import { Hono } from "hono";
import { proposalSchema, type ProposalResult } from "@connector/shared/api/search";
import { parseItemId } from "@connector/shared/sources";
import { getDb } from "../db/client";
import type { AppEnv } from "../http/env";
import { AppError, notFound, validationError } from "../http/errors";
import { jsonBody, requireUser } from "../http/middleware";
import { logActivity } from "../search/federate";
import { proposeHandbookChange } from "../sources/handbook";
import { usableSources } from "../sources/service";
import { useSource } from "../sources/use";

/**
 * Agents draft, people publish: a proposed Handbook change, made as the
 * person through their linked Handbook account and submitted for review.
 */
/** A Handbook page ID: a UUID, and nothing that could change the address. */
const PAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const router = new Hono<AppEnv>();

router.post("/proposals", async (c) => {
  const principal = requireUser(c);
  const input = await jsonBody(c, proposalSchema);
  const started = performance.now();
  const ref = input.page ? parseItemId(input.page) : null;
  // The ID becomes part of the address Connector asks Handbook for, with the person's token.
  if (input.page && (!ref || ref.type !== "page" || !PAGE_ID.test(ref.externalId))) {
    throw validationError({ page: "Use a page ID from search, e.g. handbook:page:…" });
  }
  const handbooks = (await usableSources(getDb(), principal)).filter((row) => row.kind === "handbook");
  const wanted = ref?.source ?? input.source;
  const source = wanted
    ? handbooks.find((row) => row.slug === wanted)
    : handbooks.length === 1
      ? handbooks[0]
      : undefined;
  if (!source) {
    throw handbooks.length > 1 && !wanted
      ? validationError({
          source: `Name the Handbook source: ${handbooks.map((row) => row.slug).join(", ")}`,
        })
      : notFound("No Handbook source you may use");
  }
  const use = await useSource(
    getDb(),
    principal,
    source,
    (_, context) =>
      proposeHandbookChange(context, {
        title: input.title,
        description: input.description,
        page: ref && input.edits ? { id: ref.externalId, edits: input.edits } : undefined,
        newPage: input.newPage,
      }),
    "propose",
  );
  if (!use) throw notFound("No Handbook source you may use");
  await logActivity(getDb(), principal, {
    action: "propose",
    query: input.title,
    results: use.outcome.count,
    sources: [use.logged],
    ms: Math.round(performance.now() - started),
  });
  if (!use.ok)
    throw new AppError(use.error.kind === "rejected" ? 422 : 409, "proposal_failed", use.error.message);
  const result: ProposalResult = use.value;
  return c.json(result, 201);
});

export default router;
