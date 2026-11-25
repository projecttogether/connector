import { describe, expect, it } from "vitest";
import type { SearchResult } from "@connector/shared/api/search";
import type { Authority } from "@connector/shared/sources";
import { mergeResults } from "./federate";

const result = (id: string, authority: Authority): SearchResult => ({
  id,
  title: id,
  url: `https://example.org/${id}`,
  snippet: "",
  type: "page",
  source: { slug: "s", name: "S", kind: "handbook" },
  authority,
  date: null,
  status: null,
});

describe("mergeResults", () => {
  it("takes each source's best first and lets the stronger source win a round", () => {
    const handbook = [result("page-1", "knowledge"), result("policy", "rules")];
    const logbook = [result("decision", "decision"), result("old", "history")];
    const library = [result("note", "library")];
    expect(mergeResults([library, handbook, logbook], 10).map((item) => item.id)).toEqual([
      "decision",
      "page-1",
      "note",
      "policy",
      "old",
    ]);
    expect(mergeResults([handbook, logbook], 3)).toHaveLength(3);
  });
});
