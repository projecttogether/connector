import { z } from "zod";
import { indexAdapter, type IndexedItem } from "./index-store";

/*
 * Logbook (webhook): `entry.changed` carries the whole entry
 * (Logbook docs/webhooks.md). Published updates, learnings and decisions
 * arrive; drafts and open proposals never do. Everyone with access to
 * Logbook reads every entry, so items are visible to everyone who may use
 * the source. Decisions in force rank high in the source order; the newest
 * wins.
 */

const nullableString = z.string().nullable().optional();

export const logbookPayloadSchema = z.object({
  event: z.literal("entry.changed"),
  entry: z.object({
    id: z.string().min(1).max(200),
    ref: z.string().max(40),
    url: z.url(),
    type: z.enum(["decision", "update", "learning"]),
    status: z.string().max(40),
    title: z.string().max(1000),
    summary: z.string().max(10_000).default(""),
    details: z.string().max(200_000).default(""),
    rationale: z.string().max(200_000).default(""),
    impact: nullableString,
    team: z.string().max(200).default(""),
    affected_teams: z.array(z.string()).default([]),
    tags: z.array(z.string()).default([]),
    author: z.string().max(200).default(""),
    published_at: nullableString,
    in_force: z.boolean(),
    supersedes: nullableString,
    superseded_by: nullableString,
    decision: z
      .object({
        result: z.string(),
        text: z.string().default(""),
        reversibility: nullableString,
        how_decided: nullableString,
        decider: z.string().default(""),
        decided_on: nullableString,
        decided_at: nullableString,
        objection_handling: nullableString,
        open_objections: z.array(z.string()).default([]),
        consent_givers: z.array(z.string()).default([]),
        involved: z.array(z.string()).default([]),
        proposal_version: z.number().nullable().optional(),
      })
      .nullable(),
    addenda: z.array(z.object({ text: z.string(), author: z.string(), created_at: z.string() })).default([]),
  }),
});
export type LogbookPayload = z.infer<typeof logbookPayloadSchema>;

const words = (value: string | null | undefined) => (value ? value.replace(/_/g, " ") : null);

function statusOf(entry: LogbookPayload["entry"]): string | null {
  if (entry.type !== "decision") return null;
  if (entry.decision?.result === "rejected") return "rejected";
  if (entry.superseded_by) return `superseded by ${entry.superseded_by}`;
  return entry.in_force ? "in force" : "not in force";
}

const date = (value: string | null | undefined) => (value ? new Date(value) : null);

/** The entry as Connector indexes it. */
export function logbookItem(payload: LogbookPayload): IndexedItem {
  const { entry } = payload;
  const decision = entry.decision;
  const status = statusOf(entry);
  const lines: string[] = [`# ${entry.ref}: ${entry.title}`, ""];
  const facts = [
    entry.type[0]!.toUpperCase() + entry.type.slice(1),
    status,
    entry.team ? `Team: ${entry.team}` : null,
    entry.impact ? `Impact: ${entry.impact}` : null,
  ].filter(Boolean);
  lines.push(facts.join(" · "), "");
  if (entry.summary) lines.push(entry.summary, "");
  if (decision) {
    if (decision.text) lines.push("## Decision", "", decision.text, "");
    const how = [
      decision.decided_on ? `Decided on ${decision.decided_on}` : null,
      decision.decider ? `by ${decision.decider}` : null,
      decision.how_decided ? `(${words(decision.how_decided)})` : null,
      decision.reversibility ? `· ${words(decision.reversibility)}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    if (how) lines.push(how, "");
  }
  if (entry.details)
    lines.push(entry.type === "decision" ? "## Context" : "## Details", "", entry.details, "");
  if (entry.rationale) lines.push("## Rationale", "", entry.rationale, "");
  if (decision?.objection_handling) lines.push("## Objections", "", decision.objection_handling, "");
  if (decision && decision.open_objections.length > 0) {
    lines.push("## Open objections", "", ...decision.open_objections.map((text) => `- ${text}`), "");
  }
  if (entry.supersedes) lines.push(`Replaces ${entry.supersedes}.`, "");
  if (entry.superseded_by) lines.push(`Replaced by ${entry.superseded_by}: read that decision instead.`, "");
  if (entry.addenda.length > 0) {
    lines.push("## Addenda", "");
    for (const addendum of entry.addenda)
      lines.push(`- ${addendum.created_at.slice(0, 10)}, ${addendum.author}: ${addendum.text}`);
    lines.push("");
  }
  const occurredAt = date(decision?.decided_at) ?? date(entry.published_at);
  const lastAddendum = entry.addenda
    .map((addendum) => date(addendum.created_at))
    .filter((value): value is Date => value !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return {
    externalId: entry.id,
    type: entry.type,
    ref: entry.ref.toUpperCase(),
    title: entry.title,
    url: entry.url,
    summary: entry.summary || decision?.text.slice(0, 300) || "",
    body: lines.join("\n").trim(),
    status,
    inForce: entry.type === "decision" ? entry.in_force : null,
    metadata: {
      team: entry.team || null,
      affectedTeams: entry.affected_teams,
      tags: entry.tags,
      author: entry.author || null,
      impact: entry.impact ?? null,
      decider: decision?.decider || null,
      decidedOn: decision?.decided_on ?? null,
      howDecided: words(decision?.how_decided),
      reversibility: words(decision?.reversibility),
    },
    related: [
      ...(entry.supersedes ? [{ ref: entry.supersedes.toUpperCase(), relation: "replaces" }] : []),
      ...(entry.superseded_by ? [{ ref: entry.superseded_by.toUpperCase(), relation: "replaced by" }] : []),
    ],
    visibility: "all",
    visibilityGroups: [],
    occurredAt,
    changedAt: lastAddendum && occurredAt && lastAddendum > occurredAt ? lastAddendum : occurredAt,
  };
}

export const logbookAdapter = indexAdapter("logbook", (row) =>
  row.type === "decision" && row.inForce ? "decision" : "history",
);
