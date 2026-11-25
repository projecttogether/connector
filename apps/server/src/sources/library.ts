import { z } from "zod";
import { libraryConfigSchema } from "@connector/shared/api/sources";
import { indexAdapter, type IndexedItem } from "./index-store";

/*
 * Library (webhook): `note.changed` carries the whole published
 * note, `note.removed` its ID (Library docs/webhooks.md). Notes for
 * everyone are visible to everyone who may use the source; team notes only
 * to the team: members of the Keycloak group the note names, or of
 * `<teamGroupPrefix>/<team name>` (the prefix as set now, read at every
 * search). Without either, nobody sees them.
 */

export const libraryPayloadSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("note.changed"),
    note: z.object({
      id: z.string().min(1).max(200),
      ref: z.string().max(40),
      url: z.url(),
      title: z.string().max(1000),
      core: z.string().max(10_000).default(""),
      key_points: z.array(z.string()).default([]),
      text: z.string().max(200_000).default(""),
      visibility: z.enum(["all", "team"]),
      team: z.object({ name: z.string(), directory_id: z.string().nullable() }).nullable(),
      owner: z.string().default(""),
      document_type: z.string().nullable().optional(),
      project: z.string().nullable().optional(),
      tags: z.array(z.string()).default([]),
      source_url: z.string().nullable().optional(),
      doi: z.string().nullable().optional(),
      language: z.string().nullable().optional(),
      checked: z.boolean().default(false),
      published_at: z.string(),
      changed_at: z.string(),
    }),
  }),
  z.object({ event: z.literal("note.removed"), note: z.object({ id: z.string().min(1).max(200) }) }),
]);
export type LibraryPayload = z.infer<typeof libraryPayloadSchema>;
type ChangedNote = Extract<LibraryPayload, { event: "note.changed" }>["note"];

export function libraryItem(note: ChangedNote): IndexedItem {
  const groups: string[] = [];
  if (note.visibility === "team" && note.team) {
    if (note.team.directory_id) groups.push(`kc:${note.team.directory_id}`);
    groups.push(`team:${note.team.name}`);
  }
  const header = [
    note.document_type ? `Type: ${note.document_type}` : null,
    note.project ? `Project: ${note.project}` : null,
    note.tags.length > 0 ? `Tags: ${note.tags.join(", ")}` : null,
    note.visibility === "team" && note.team ? `Shared with the team ${note.team.name}` : null,
  ].filter(Boolean);
  const body = [`# ${note.ref}: ${note.title}`, "", header.join(" · "), "", note.text].join("\n").trim();
  return {
    externalId: note.id,
    type: "note",
    ref: note.ref.toUpperCase(),
    title: note.title,
    url: note.url,
    summary: note.core,
    body,
    status: note.checked ? "checked by a steward" : "confirmed by its owner",
    inForce: null,
    metadata: {
      owner: note.owner || null,
      team: note.team?.name ?? null,
      documentType: note.document_type ?? null,
      project: note.project ?? null,
      tags: note.tags,
      sourceUrl: note.source_url ?? null,
      doi: note.doi ?? null,
      language: note.language ?? null,
      checked: note.checked,
      aiDrafted: true,
    },
    related: [],
    visibility: note.visibility === "team" ? "groups" : "all",
    visibilityGroups: groups,
    occurredAt: new Date(note.published_at),
    changedAt: new Date(note.changed_at),
  };
}

export const libraryAdapter = indexAdapter("library", () => "library", {
  teamPrefix: (config) => libraryConfigSchema.safeParse(config).data?.teamGroupPrefix ?? null,
});
