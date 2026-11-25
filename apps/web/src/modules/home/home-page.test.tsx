import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceSummary } from "@connector/shared/api/sources";
import type { Me } from "@connector/shared/api/users";
import { renderInRouter } from "@/test-utils";
import { HomePage } from "./home-page";

type Reply = { status?: number; body?: unknown };

function routeFetch(routes: Record<string, Reply>) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const reply = routes[`${init?.method ?? "GET"} ${url.split("?")[0]}`] ?? {
      status: 500,
      body: { error: { code: "internal_error", message: "No reply" } },
    };
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => vi.unstubAllGlobals());

const me: Me = {
  id: "0b5a3e5e-3c1f-4d8e-9f3a-555555555555",
  email: "rita@example.org",
  name: "Rita Reader",
  image: null,
  isAdmin: false,
  groups: ["/staff"],
};

const source = (slug: string, state: SourceSummary["state"]): SourceSummary => ({
  slug,
  kind: "handbook",
  name: `Source ${slug}`,
  description: null,
  holds: "Policies",
  delivery: "live",
  url: "https://handbook.example.org",
  state,
  linkable: false,
  linked: false,
});

describe("home page", () => {
  it("shows each source's state in the status page's words", async () => {
    routeFetch({
      "GET /api/v1/me": { body: me },
      "GET /api/v1/sources": {
        body: {
          items: [
            source("a", "ok"),
            source("b", "failing"),
            source("c", "waiting"),
            source("d", "setup"),
            source("e", "unchecked"),
          ],
        },
      },
      "GET /api/v1/recent": { body: { items: [], sources: [] } },
    });
    renderInRouter(<HomePage />);

    expect(await screen.findByText("Source a")).toBeInTheDocument();
    for (const label of [
      "Working",
      "Failing",
      "Waiting for first delivery",
      "Needs setup",
      "Not checked yet",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});
