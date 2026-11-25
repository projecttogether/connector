import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResponse, SearchResult } from "@connector/shared/api/search";
import { stubFetch } from "@/test-utils";
import { findItems, isAppAddress } from "./api";

afterEach(() => vi.unstubAllGlobals());

const result = (title: string, url: string, source = "Logbook"): SearchResult => ({
  id: `logbook:decision:${title}`,
  title,
  url,
  snippet: "",
  type: "decision",
  source: { slug: source.toLowerCase(), name: source, kind: "logbook" },
  authority: "decision",
  date: null,
  status: null,
});

describe("isAppAddress", () => {
  it("tells addresses in other apps from the app's own paths", () => {
    expect(isAppAddress("https://logbook.example.org/e/LB-12")).toBe(true);
    expect(isAppAddress("HTTP://crm.example.org/c/1")).toBe(true);
    expect(isAppAddress("/search?q=train")).toBe(false);
    expect(isAppAddress("javascript:alert(1)")).toBe(false);
    expect(isAppAddress("//evil.example.org")).toBe(false);
  });
});

describe("findItems", () => {
  it("asks the search API and names each result's source", async () => {
    const body: SearchResponse = {
      query: "train",
      results: [
        result("LB-12: Trains for work trips", "https://logbook.example.org/e/LB-12"),
        result("Travel policy", "https://handbook.example.org/s/hr/travel", "Handbook"),
      ],
      sources: [],
    };
    const fetch = stubFetch({ body });
    const found = await findItems("train", new AbortController().signal);

    expect(fetch.mock.calls[0]![0]).toBe("/api/v1/search?q=train&limit=8");
    expect(found).toEqual([
      { href: "https://logbook.example.org/e/LB-12", title: "LB-12: Trains for work trips", kind: "Logbook" },
      { href: "https://handbook.example.org/s/hr/travel", title: "Travel policy", kind: "Handbook" },
    ]);
  });

  it("leaves out addresses that are no web pages and repeats of one address", async () => {
    stubFetch({
      body: {
        query: "x",
        results: [
          result("One", "https://logbook.example.org/e/LB-1"),
          result("One again", "https://logbook.example.org/e/LB-1"),
          result("Script", "javascript:alert(1)"),
        ],
        sources: [],
      } satisfies SearchResponse,
    });
    const found = await findItems("x", new AbortController().signal);
    expect(found.map((item) => item.title)).toEqual(["One"]);
  });
});
