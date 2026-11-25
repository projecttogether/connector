import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HIGHLIGHT_END, HIGHLIGHT_START, type Item, type SearchResponse } from "@connector/shared/api/search";
import { renderWithProviders } from "@/test-utils";
import { highlightParts, SearchPage } from "./search-page";

describe("search snippets", () => {
  it("marks the matched words", () => {
    const snippet = `Connect the ${HIGHLIGHT_START}laptop${HIGHLIGHT_END} to the ${HIGHLIGHT_START}VPN${HIGHLIGHT_END}.`;
    const { container } = render(<p>{highlightParts(snippet)}</p>);
    expect([...container.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual([
      "laptop",
      "VPN",
    ]);
    expect(container.textContent).toBe("Connect the laptop to the VPN.");
  });

  it("keeps text without marks and survives a missing end mark", () => {
    expect(highlightParts("plain")).toEqual(["plain"]);
    const { container } = render(<p>{highlightParts(`a ${HIGHLIGHT_START}b`)}</p>);
    expect(container.querySelector("mark")?.textContent).toBe("b");
  });
});

const response: SearchResponse = {
  query: "travel",
  results: [
    {
      id: "logbook:decision:1",
      title: "LB-12: Travel by train",
      url: "https://logbook.example.org/e/LB-12",
      snippet: `We ${HIGHLIGHT_START}travel${HIGHLIGHT_END} by train.`,
      type: "decision",
      source: { slug: "logbook", name: "Logbook", kind: "logbook" },
      authority: "decision",
      date: "2026-11-10T09:00:00.000Z",
      status: "in force",
    },
  ],
  sources: [
    { slug: "logbook", name: "Logbook", ok: true, count: 1, ms: 12, error: null },
    { slug: "crm", name: "CRM", ok: false, count: 0, ms: 8000, error: "CRM did not answer in time" },
  ],
};

const item: Item = {
  id: "logbook:decision:1",
  title: "LB-12: Travel by train",
  url: "https://logbook.example.org/e/LB-12",
  type: "decision",
  source: { slug: "logbook", name: "Logbook", kind: "logbook" },
  authority: "decision",
  date: "2026-11-10T09:00:00.000Z",
  status: "in force",
  text: "# LB-12: Travel by train\n\nTrips under 600 km go by **train**.",
  metadata: { team: "Operations", tags: ["Travel"], decider: null },
  related: [{ id: "logbook:decision:0", title: "LB-3: Travel policy", relation: "replaces" }],
};

afterEach(() => vi.unstubAllGlobals());

describe("search page", () => {
  it("shows results with their source, level and the sources that did not answer, and previews an item", async () => {
    const fetch = vi.fn(async (url: string) => {
      const path = url.split("?")[0];
      const body =
        path === "/api/v1/search"
          ? response
          : path === "/api/v1/sources"
            ? { items: [] }
            : path === `/api/v1/items/${encodeURIComponent(item.id)}`
              ? item
              : { error: { code: "x", message: "No reply" } };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    renderWithProviders(<SearchPage params={{ q: "travel" }} onChange={() => undefined} />);

    const link = await screen.findByRole("link", { name: /LB-12: Travel by train/ });
    expect(link).toHaveAttribute("href", "https://logbook.example.org/e/LB-12");
    expect(link).toHaveAttribute("target", "_blank");
    const row = link.closest("li")!;
    expect(within(row).getByText("Decisions in force")).toBeInTheDocument();
    expect(within(row).getByText("travel").tagName).toBe("MARK");
    const outcomes = screen.getByTestId("source-outcomes");
    expect(outcomes).toHaveTextContent("Logbook: 1");
    expect(outcomes).toHaveTextContent("CRM did not answer: CRM did not answer in time");

    await userEvent.setup().click(within(row).getByRole("button", { name: "Preview" }));
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByText("train")).toBeInTheDocument();
    expect(within(sheet).getByText("Operations")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "LB-3: Travel policy" })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/items/logbook%3Adecision%3A1"),
      expect.anything(),
    );
  });
});
