import { describe, expect, it } from "vitest";
import { snippetOf, termsOf, textFilter, valueText } from "./notion";

const text = (value: string) => [{ plain_text: value }];

describe("Notion search words", () => {
  it("keeps phrases whole, drops common and one-letter words, and keeps at most five", () => {
    expect(termsOf('the "travel policy" for interns, 2026!')).toEqual(["travel policy", "interns", "2026"]);
    expect(termsOf("Budget budget BUDGET")).toEqual(["Budget"]);
    expect(termsOf("a b c d e f g h")).toEqual(["a b c d e f g h"]);
    expect(termsOf("one two three four five six")).toEqual(["one", "two", "three", "four", "five"]);
    expect(termsOf("für die Reise")).toEqual(["Reise"]);
  });

  it("asks for pages whose title or a text property holds each word", () => {
    const table = { title: "title", texts: ["a%3Ab"] };
    expect(textFilter(table, ["travel"])).toEqual({
      or: [
        { property: "title", title: { contains: "travel" } },
        { property: "a%3Ab", rich_text: { contains: "travel" } },
      ],
    });
    expect(textFilter({ title: "title", texts: [] }, ["travel", "policy"])).toEqual({
      and: [
        { or: [{ property: "title", title: { contains: "travel" } }] },
        { or: [{ property: "title", title: { contains: "policy" } }] },
      ],
    });
  });
});

describe("Notion properties as text", () => {
  it("shows each type's value, and nothing for empty values and relations", () => {
    expect(valueText({ type: "title", title: text("Travel policy") })).toBe("Travel policy");
    expect(valueText({ type: "rich_text", rich_text: [] })).toBeNull();
    expect(valueText({ type: "select", select: { name: "Ops" } })).toBe("Ops");
    expect(valueText({ type: "status", status: null })).toBeNull();
    expect(valueText({ type: "multi_select", multi_select: [{ name: "a" }, { name: "b" }] })).toBe("a, b");
    expect(
      valueText({ type: "people", people: [{ object: "user", id: "u" }, { name: "Rita Reader" }] }),
    ).toBe("Rita Reader");
    expect(valueText({ type: "date", date: { start: "2026-11-01", end: "2026-11-03" } })).toBe(
      "2026-11-01 – 2026-11-03",
    );
    expect(valueText({ type: "number", number: 0 })).toBe("0");
    expect(valueText({ type: "checkbox", checkbox: false })).toBe("No");
    expect(valueText({ type: "url", url: "https://example.org" })).toBe("https://example.org");
    expect(valueText({ type: "last_edited_time", last_edited_time: "2026-11-02T10:00:00.000Z" })).toBe(
      "2026-11-02",
    );
    expect(valueText({ type: "unique_id", unique_id: { prefix: "OPS", number: 12 } })).toBe("OPS-12");
    expect(valueText({ type: "formula", formula: { type: "boolean", boolean: true } })).toBe("Yes");
    expect(
      valueText({
        type: "rollup",
        rollup: {
          type: "array",
          array: [
            { type: "title", title: text("A") },
            { type: "title", title: text("B") },
          ],
        },
      }),
    ).toBe("A, B");
    expect(valueText({ type: "relation", relation: [{ id: "x" }] })).toBeNull();
    expect(valueText({ type: "button", button: {} })).toBeNull();
  });

  it("cuts snippets around the first match", () => {
    const long = `${"Background. ".repeat(30)}The travel budget is fixed.`;
    const page = {
      object: "page" as const,
      id: "p",
      properties: {
        Name: { type: "title", title: text("Budget") },
        Intro: { type: "rich_text", rich_text: text("Nothing here.") },
        Notes: { type: "rich_text", rich_text: text(long) },
      },
    };
    const snippet = snippetOf(page, ["travel"]);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet).toContain("The travel budget is fixed.");
    expect(snippetOf(page, ["missing"])).toBe("Nothing here.");
    expect(
      snippetOf(
        {
          object: "page",
          id: "p",
          properties: {
            Name: { type: "title", title: text("A") },
            Team: { type: "select", select: { name: "Ops" } },
          },
        },
        [],
      ),
    ).toBe("Team: Ops");
  });
});
