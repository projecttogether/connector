import { describe, expect, it } from "vitest";
import { notionConfigSchema, notionIdOf } from "./sources";

const ID = "1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6";

describe("Notion IDs", () => {
  it("reads a database's ID from its link or the ID itself", () => {
    for (const value of [
      ID,
      ID.toUpperCase(),
      "1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6",
      " https://www.notion.so/1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6?v=0123456789abcdef0123456789abcdef ",
      "https://www.notion.so/example-org/Team-wiki-1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6?v=1#top",
    ]) {
      expect(notionIdOf(value)).toBe(ID);
    }
  });

  it("finds none in other text", () => {
    for (const value of [
      "",
      "wiki",
      "https://www.notion.so/example-org",
      "1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c",
      "x1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6",
    ]) {
      expect(notionIdOf(value)).toBeNull();
    }
  });

  it("checks a source's databases: at least one, each once, with its level", () => {
    expect(notionConfigSchema.parse({ databases: [{ id: ID }] })).toEqual({
      baseUrl: "https://www.notion.so",
      databases: [{ id: ID, authority: "knowledge" }],
      apiUrl: "https://api.notion.com",
    });
    expect(notionConfigSchema.safeParse({ databases: [] }).success).toBe(false);
    expect(
      notionConfigSchema.safeParse({ databases: [{ id: ID }, { id: ID.replaceAll("-", "") }] }).success,
    ).toBe(false);
    expect(notionConfigSchema.safeParse({ databases: [{ id: ID, authority: "rules" }] }).success).toBe(false);
  });
});
