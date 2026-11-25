import { describe, expect, it } from "vitest";
import { normalizeAttribute, parseFilter } from "./filter";

describe("SCIM filters", () => {
  it("reads eq conditions joined by and", () => {
    expect(parseFilter('userName eq "Ada@Example.org"')).toEqual([
      { attribute: "username", value: "Ada@Example.org" },
    ]);
    expect(parseFilter('emails[type eq "work"].value eq "a@example.org" and active eq true')).toEqual([
      { attribute: "emails.value", value: "a@example.org" },
      { attribute: "active", value: "true" },
    ]);
    expect(parseFilter('displayName eq "Quote \\"x\\""')).toEqual([
      { attribute: "displayname", value: 'Quote "x"' },
    ]);
    expect(parseFilter(undefined)).toEqual([]);
    expect(parseFilter('displayName eq "Research and Development" and externalId eq "7"')).toEqual([
      { attribute: "displayname", value: "Research and Development" },
      { attribute: "externalid", value: "7" },
    ]);
  });

  it("refuses other operators", () => {
    expect(() => parseFilter('userName co "a"')).toThrow("Unsupported filter");
    expect(() => parseFilter('userName eq "a" or userName eq "b"')).toThrow("Unsupported filter");
  });

  it("normalizes schema URNs and value paths", () => {
    expect(normalizeAttribute("urn:ietf:params:scim:schemas:core:2.0:User:userName")).toBe("username");
    expect(normalizeAttribute('members[value eq "x"]')).toBe("members");
  });
});
