import { describe, expect, it } from "vitest";
import { recordText } from "./crm";

describe("CRM records as text", () => {
  it("lists filled fields with labels, refs by name, and custom fields; hides internals", () => {
    const text = recordText("Example Foundation", {
      id: "x",
      version: 3,
      access: "manage",
      name: "Example Foundation",
      website: "https://example.org",
      linkedinUrl: null,
      tags: ["funder", "berlin"],
      owner: { id: "u", label: "Ada" },
      notes: "Long-time partner.\nMeets twice a year.",
      customFields: { focusArea: "Education" },
    });
    expect(text).toBe(
      [
        "# Example Foundation",
        "",
        "- **Name:** Example Foundation",
        "- **Website:** https://example.org",
        "- **Tags:** funder, berlin",
        "- **Owner:** Ada",
        "**Notes:**",
        "",
        "Long-time partner.\nMeets twice a year.",
        "",
        "- **Focus Area:** Education",
      ].join("\n"),
    );
  });
});
