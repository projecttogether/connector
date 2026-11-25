import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceSummary } from "@connector/shared/api/sources";
import type { TokenCreated } from "@connector/shared/api/tokens";
import type { Me } from "@connector/shared/api/users";
import { renderInRouter } from "@/test-utils";
import { SettingsPage } from "./settings-page";

type Reply = { status?: number; body?: unknown };

function routeFetch(routes: Record<string, Reply | (() => Reply)>) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const entry = routes[`${init?.method ?? "GET"} ${url.split("?")[0]}`];
    const reply = (typeof entry === "function" ? entry() : entry) ?? {
      status: 500,
      body: { error: { code: "internal_error", message: "No reply" } },
    };
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
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
  groups: ["/staff", "/teams/Programs"],
};

const handbook: SourceSummary = {
  slug: "handbook",
  kind: "handbook",
  name: "Handbook",
  description: null,
  holds: "Policies",
  delivery: "live",
  url: "https://handbook.example.org",
  state: "ok",
  linkable: true,
  linked: false,
};

const created: TokenCreated = {
  id: "0b5a3e5e-3c1f-4d8e-9f3a-333333333333",
  name: "Claude Code",
  prefix: "cn_pat_AbCd…",
  createdAt: "2026-11-17T10:00:00.000Z",
  lastUsedAt: null,
  expiresAt: "2027-02-15T10:00:00.000Z",
  secret: "cn_pat_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef",
};

describe("settings page", () => {
  it("shows a new token's secret once", async () => {
    let tokens: unknown[] = [];
    const fetch = routeFetch({
      "GET /api/v1/me": { body: me },
      "GET /api/v1/sources": { body: { items: [] } },
      "GET /api/v1/links": { body: { items: [] } },
      "GET /api/v1/connected-apps": { body: { items: [] } },
      "GET /api/v1/tokens": () => ({ body: { items: tokens } }),
      "POST /api/v1/tokens": () => {
        const { secret: _secret, ...token } = created;
        tokens = [token];
        return { body: created };
      },
    });
    const user = userEvent.setup();
    renderInRouter(<SettingsPage />);

    expect(await screen.findByText("No personal tokens.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New token" }));
    await user.type(screen.getByLabelText("Name"), "Claude Code");
    await user.click(screen.getByRole("button", { name: "Create token" }));

    // Hidden, and copied without showing it.
    const secret = await screen.findByLabelText("Token");
    expect(secret).toHaveValue(created.secret);
    expect(secret).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Copy" }));
    await expect(navigator.clipboard.readText()).resolves.toBe(created.secret);
    expect(screen.getByText(/You won't see it again/)).toBeInTheDocument();
    const post = fetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ name: "Claude Code", expiresInDays: 90 });

    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByDisplayValue(created.secret)).not.toBeInTheDocument());
    expect(await screen.findByText("cn_pat_AbCd…")).toBeInTheDocument();
    expect(screen.queryByText(created.secret)).not.toBeInTheDocument();
  });

  it("shows linked accounts and groups, links a source and confirms the way back", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const fetch = routeFetch({
      "GET /api/v1/me": { body: me },
      "GET /api/v1/sources": {
        body: { items: [handbook, { ...handbook, slug: "wiki", name: "Wiki", linked: true }] },
      },
      "GET /api/v1/links": {
        body: {
          items: [
            {
              source: "wiki",
              sourceName: "Wiki",
              label: "rita@example.org",
              createdAt: "2026-11-18T10:00:00.000Z",
            },
          ],
        },
      },
      "GET /api/v1/connected-apps": { body: { items: [] } },
      "GET /api/v1/tokens": { body: { items: [] } },
      "POST /api/v1/links/handbook": {
        body: { authorizeUrl: "https://handbook.example.org/oauth/authorize?x=1" },
      },
    });
    renderInRouter(<SettingsPage linked="wiki" />);
    expect(await screen.findByText("Your Wiki account is linked")).toBeInTheDocument();
    expect(await screen.findByText(/Linked as rita@example.org/)).toBeInTheDocument();
    expect(await screen.findByText("/teams/Programs")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Link" }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://handbook.example.org/oauth/authorize?x=1"),
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/links/handbook"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("shows why linking failed", async () => {
    routeFetch({
      "GET /api/v1/me": { body: me },
      "GET /api/v1/sources": { body: { items: [] } },
      "GET /api/v1/links": { body: { items: [] } },
      "GET /api/v1/connected-apps": { body: { items: [] } },
      "GET /api/v1/tokens": { body: { items: [] } },
    });
    renderInRouter(<SettingsPage linkError="You declined the link" />);
    expect(await screen.findByText("Linking failed: You declined the link")).toBeInTheDocument();
  });

  it("shows the version that runs, linked to its commit", async () => {
    routeFetch({
      "GET /api/v1/me": { body: me },
      "GET /api/v1/sources": { body: { items: [] } },
      "GET /api/v1/links": { body: { items: [] } },
      "GET /api/v1/connected-apps": { body: { items: [] } },
      "GET /api/v1/tokens": { body: { items: [] } },
      "GET /api/v1/about": { body: { version: "0123456789ab" } },
    });
    renderInRouter(<SettingsPage />);
    expect(await screen.findByRole("link", { name: "Version 0123456789ab" })).toHaveAttribute(
      "href",
      "https://github.com/projecttogether/connector/commit/0123456789ab",
    );
    expect(screen.getByRole("link", { name: /Source code on GitHub/ })).toHaveAttribute(
      "href",
      "https://github.com/projecttogether/connector",
    );
  });
});
