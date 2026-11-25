import { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Source } from "@connector/shared/api/sources";
import type { AdminStatus } from "@connector/shared/api/status";
import type { Me, Person } from "@connector/shared/api/users";
import { AdminPeoplePage } from "./people-page";
import { SetupPage } from "./setup/setup-page";
import { AdminSourcesPage } from "./sources-page";
import { AdminStatusPage } from "./status-page";
import { createBody, emptyForm, formOf, slugFrom, updateBody } from "./source-dialog";

const me: Me = {
  id: "0b5a3e5e-3c1f-4d8e-9f3a-555555555555",
  email: "ada@example.org",
  name: "Ada Lovelace",
  image: null,
  isAdmin: true,
  groups: ["/staff/it"],
};

function person(overrides: Partial<Person>): Person {
  return {
    id: "0b5a3e5e-3c1f-4d8e-9f3a-666666666666",
    email: "rita@example.org",
    name: "Rita Reader",
    title: null,
    isAdmin: false,
    adminSource: null,
    blocked: false,
    directory: null,
    groups: [],
    lastSignInAt: null,
    createdAt: "2026-11-01T10:00:00.000Z",
    ...overrides,
  };
}

const handbook: Source = {
  id: "0b5a3e5e-3c1f-4d8e-9f3a-888888888888",
  slug: "handbook",
  kind: "handbook",
  name: "Handbook",
  description: null,
  enabled: true,
  accessGroups: ["/staff"],
  serviceAccess: true,
  position: 0,
  config: { baseUrl: "https://handbook.example.org", ruleSpaces: ["policies"], allowLinking: true },
  secrets: { serviceToken: "…abcd" },
  webhookUrl: null,
  status: { at: "2026-11-19T10:00:00.000Z", ok: true, message: "Reached Handbook: 4 spaces" },
  stats: null,
  createdAt: "2026-11-19T09:00:00.000Z",
  updatedAt: "2026-11-19T09:00:00.000Z",
};

type Reply = unknown | ((init?: RequestInit) => unknown);

function routeFetch(routes: Record<string, Reply>) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const entry = routes[`${init?.method ?? "GET"} ${url.split("?")[0]}`];
    const body = typeof entry === "function" ? (entry as (init?: RequestInit) => unknown)(init) : entry;
    return new Response(JSON.stringify(body ?? { error: { code: "x", message: "No reply" } }), {
      status: body ? 200 : 500,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function renderAt(path: string, Component: () => React.ReactNode) {
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => (
      <Suspense fallback={null}>
        <Component />
      </Suspense>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("source forms", () => {
  it("makes slugs from names", () => {
    expect(slugFrom("Our Handbook")).toBe("our-handbook");
    expect(slugFrom("2026 Logbook")).toBe("logbook");
    expect(slugFrom("Bücherei")).toBe("bucherei");
    expect(slugFrom("A".repeat(60))).toHaveLength(40);
  });

  it("sends the kind's settings and only the secrets that were typed", () => {
    const form = {
      ...emptyForm("crm"),
      name: "CRM",
      slug: "crm",
      baseUrl: "https://crm.example.org",
      apiKey: "crm_secret",
      accessGroups: "/staff, /board",
    };
    expect(createBody(form)).toEqual({
      kind: "crm",
      slug: "crm",
      name: "CRM",
      description: null,
      enabled: true,
      accessGroups: ["/staff", "/board"],
      serviceAccess: false,
      config: {
        baseUrl: "https://crm.example.org",
        types: ["contact", "organization", "deal", "event", "meeting"],
      },
      secret: { apiKey: "crm_secret" },
    });
    const edited = formOf(handbook);
    expect(edited.ruleSpaces).toBe("policies");
    expect(edited.serviceToken).toBe("");
    expect(updateBody(edited)).not.toHaveProperty("secret");
    expect(updateBody({ ...edited, ruleSpaces: "purpose, policies" }).config).toEqual({
      baseUrl: "https://handbook.example.org",
      ruleSpaces: ["purpose", "policies"],
      allowLinking: true,
    });
  });
});

const logbook: Source = {
  ...handbook,
  id: "0b5a3e5e-3c1f-4d8e-9f3a-999999999999",
  slug: "logbook",
  kind: "logbook",
  name: "Logbook",
  accessGroups: [],
  serviceAccess: false,
  config: { baseUrl: "https://logbook.example.org" },
  secrets: {},
  webhookUrl: "https://connector.example.org/hooks/logbook",
  status: null,
  stats: { items: 0, lastDeliveryAt: null },
};

describe("admin sources", () => {
  it("lists sources with access and status, and offers a setup guide per app", async () => {
    routeFetch({ "GET /api/v1/admin/sources": { items: [handbook] } });
    renderAt("/admin/sources", AdminSourcesPage);
    const row = (await screen.findByText("Reached Handbook: 4 spaces")).closest("tr")!;
    expect(within(row).getByText("Members of /staff")).toBeInTheDocument();
    expect(within(row).getByText("Bots too")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Connect a source" }));
    expect(await screen.findByRole("menuitem", { name: "Logbook" })).toHaveAttribute(
      "href",
      "/admin/setup/logbook",
    );
    expect(screen.getAllByRole("menuitem")).toHaveLength(4);
  });

  it("shows a new webhook secret hidden, even after the one before was shown", async () => {
    let n = 0;
    routeFetch({
      "GET /api/v1/admin/sources": { items: [logbook] },
      [`POST /api/v1/admin/sources/${logbook.id}/webhook-secret`]: () => ({
        webhookSecret: `secret-${++n}-1234567890`,
        createdAt: "2026-11-19T11:30:00.000Z",
      }),
    });
    renderAt("/admin/sources", AdminSourcesPage);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Webhook" }));
    await user.click(screen.getByRole("button", { name: "Generate webhook secret" }));
    const first = await screen.findByLabelText("Signing secret");
    expect(first).toHaveValue("secret-1-1234567890");
    expect(first).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Show" }));
    expect(first).toHaveAttribute("type", "text");

    await user.click(screen.getByRole("button", { name: "Generate a new secret" }));
    await waitFor(() => expect(screen.getByLabelText("Signing secret")).toHaveValue("secret-2-1234567890"));
    expect(screen.getByLabelText("Signing secret")).toHaveAttribute("type", "password");
  });
});

describe("setup guides", () => {
  it("connects Logbook: the source, its webhook values once, and the first delivery", async () => {
    let stored: Source | null = null;
    let posted: unknown;
    const created = vi.fn();
    routeFetch({
      "GET /api/v1/admin/sources": () => ({ items: stored ? [stored] : [handbook] }),
      "POST /api/v1/admin/sources": (init?: RequestInit) => {
        posted = JSON.parse(String(init?.body));
        stored = logbook;
        return logbook;
      },
      [`POST /api/v1/admin/sources/${logbook.id}/webhook-secret`]: () => {
        stored = { ...logbook, secrets: { webhookSecret: "…7890" } };
        return { webhookSecret: "generated-secret-1234567890", createdAt: "2026-11-19T09:59:00.000Z" };
      },
    });
    renderAt("/admin/setup/logbook", () => <SetupPage app="logbook" onCreated={created} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Address"), "https://logbook.example.org");
    await user.type(screen.getByLabelText("Groups"), "/staff");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(posted).toEqual({
        kind: "logbook",
        slug: "logbook",
        name: "Logbook",
        description: null,
        enabled: true,
        accessGroups: ["/staff"],
        serviceAccess: false,
        config: { baseUrl: "https://logbook.example.org" },
        secret: {},
      }),
    );
    expect(created).toHaveBeenCalledWith(logbook.id);
    // Where to enter the two values, and where older versions read them.
    expect(await screen.findByTestId("webhook-url")).toHaveTextContent(
      "https://connector.example.org/hooks/logbook",
    );
    expect(screen.getByRole("link", { name: "Admin → Integrations" })).toHaveAttribute(
      "href",
      "https://logbook.example.org/admin/integrations",
    );
    expect(screen.getByText(/add them as WEBHOOK_URL and WEBHOOK_SECRET/)).toBeInTheDocument();
    // The secret is hidden; the eye button shows it on request.
    const secretField = screen.getByLabelText("Signing secret");
    expect(secretField).toHaveAttribute("type", "password");
    expect(secretField).toHaveValue("generated-secret-1234567890");
    await user.click(screen.getByRole("button", { name: "Show" }));
    expect(secretField).toHaveAttribute("type", "text");
    const step = screen.getByTestId("step-3");
    const [copyUrl, copySecret] = within(step).getAllByRole("button", { name: "Copy" });
    await user.click(copyUrl!);
    await expect(navigator.clipboard.readText()).resolves.toBe("https://connector.example.org/hooks/logbook");
    await user.click(copySecret!);
    await expect(navigator.clipboard.readText()).resolves.toBe("generated-secret-1234567890");
    expect(screen.getByText("Waiting for Logbook…")).toBeInTheDocument();

    // The first delivery arrives; the guide notices on its next look.
    stored = {
      ...logbook,
      secrets: { webhookSecret: "…7890" },
      status: { at: "2026-11-19T10:00:00.000Z", ok: true, message: "Received LB-12" },
      stats: { items: 1, lastDeliveryAt: "2026-11-19T10:00:00.000Z" },
    };
    expect(await screen.findByText("Logbook delivered", undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText("Received LB-12 · 1 item")).toBeInTheDocument();
    // The secret stays to copy until the admin leaves.
    expect(screen.getByLabelText("Signing secret")).toHaveValue("generated-secret-1234567890");
  });

  it("continues a webhook source: a refused delivery wins over an older one, and a new secret waits for a new delivery", async () => {
    let stored: Source = {
      ...logbook,
      secrets: { webhookSecret: "…7890" },
      status: {
        at: "2026-11-19T11:00:00.000Z",
        ok: false,
        message: "A delivery had a wrong signature: check that both sides use the same secret",
      },
      stats: { items: 3, lastDeliveryAt: "2026-11-19T10:00:00.000Z" },
    };
    routeFetch({
      "GET /api/v1/admin/sources": () => ({ items: [stored] }),
      [`POST /api/v1/admin/sources/${logbook.id}/webhook-secret`]: {
        webhookSecret: "new-secret-1234567890",
        createdAt: "2026-11-19T11:30:00.000Z",
      },
    });
    renderAt("/admin/setup/logbook", () => (
      <SetupPage app="logbook" sourceId={logbook.id} onCreated={() => undefined} />
    ));
    expect(await screen.findByText("Logbook's delivery was refused")).toBeInTheDocument();
    expect(screen.queryByText("Logbook delivered")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Generate a new secret" }));
    expect(await screen.findByLabelText("Signing secret")).toHaveValue("new-secret-1234567890");
    // The old failure and the old delivery no longer count.
    expect(screen.getByText("Waiting for Logbook…")).toBeInTheDocument();
    stored = {
      ...stored,
      status: { at: "2026-11-19T12:00:00.000Z", ok: true, message: "Received LB-13" },
      stats: { items: 4, lastDeliveryAt: "2026-11-19T12:00:00.000Z" },
    };
    expect(await screen.findByText("Logbook delivered", undefined, { timeout: 5000 })).toBeInTheDocument();
  });

  it("waits only for the token made in the guide, not for older ones", async () => {
    routeFetch({
      "GET /api/v1/admin/status": statusFixture(),
      "GET /api/v1/admin/groups": { items: [] },
      "GET /api/v1/admin/scim-tokens": {
        items: [
          {
            id: "0b5a3e5e-3c1f-4d8e-9f3a-131313131313",
            name: "Old system",
            prefix: "cn_scim_old0",
            lastUsedAt: "2026-11-18T10:00:00.000Z",
            expiresAt: null,
            createdAt: "2026-11-01T10:00:00.000Z",
            createdBy: "ada@example.org",
          },
        ],
      },
    });
    renderAt("/admin/setup/iam", () => <SetupPage app="iam" onCreated={() => undefined} />);
    expect(await screen.findByText(/1 SCIM token exists/)).toBeInTheDocument();
    expect(screen.queryByText("IAM is connected")).not.toBeInTheDocument();
    expect(screen.queryByText("Waiting for IAM's first request…")).not.toBeInTheDocument();
  });

  it("connects Handbook: tests the token, shows why it failed, and picks the rule spaces", async () => {
    const source: Source = { ...handbook, config: { ...handbook.config, ruleSpaces: [] }, status: null };
    let stored: Source | null = null;
    let checks = 0;
    let patched: unknown[] = [];
    routeFetch({
      "GET /api/v1/admin/sources": () => ({ items: stored ? [stored] : [] }),
      "POST /api/v1/admin/sources": () => {
        stored = source;
        return source;
      },
      [`PATCH /api/v1/admin/sources/${source.id}`]: (init?: RequestInit) => {
        patched = [...patched, JSON.parse(String(init?.body))];
        return stored;
      },
      [`POST /api/v1/admin/sources/${source.id}/check`]: () => {
        checks += 1;
        return checks === 1
          ? { ok: false, message: "Handbook refused the credentials: Unknown token" }
          : { ok: true, message: "Reached Handbook: 2 spaces" };
      },
      [`GET /api/v1/admin/sources/${source.id}/spaces`]: {
        items: [
          { slug: "purpose", name: "Purpose and rules" },
          { slug: "it", name: "IT" },
        ],
      },
    });
    renderAt("/admin/setup/handbook", () => <SetupPage app="handbook" onCreated={() => undefined} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Address"), "https://handbook.example.org");
    expect(screen.getByRole("link", { name: "Administration → Service tokens" })).toHaveAttribute(
      "href",
      "https://handbook.example.org/admin/service-tokens",
    );
    // The token is hidden until the eye button shows it.
    const token = screen.getByLabelText("Service token");
    expect(token).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Show" }));
    expect(token).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(token).toHaveAttribute("type", "password");
    await user.type(token, "hb_wrong");
    await user.click(screen.getByRole("button", { name: "Connect and test" }));
    expect(await screen.findByText("Handbook did not accept the connection")).toBeInTheDocument();
    expect(screen.getByText("Handbook refused the credentials: Unknown token")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Service token"), "hb_right");
    await user.click(screen.getByRole("button", { name: "Save and test" }));
    expect(await screen.findByText("Reached Handbook: 2 spaces")).toBeInTheDocument();
    expect(patched[0]).toMatchObject({ secret: { serviceToken: "hb_right" } });
    await user.click(await screen.findByRole("checkbox", { name: /Purpose and rules/ }));
    // An unsaved new address does not travel with the rule spaces.
    await user.clear(screen.getByLabelText("Address"));
    await user.type(screen.getByLabelText("Address"), "https://moved.example.org");
    await user.click(screen.getByRole("button", { name: "Save rule spaces" }));
    await waitFor(() =>
      expect(patched[1]).toEqual({
        config: { baseUrl: "https://handbook.example.org", ruleSpaces: ["purpose"], allowLinking: true },
      }),
    );
  });

  it("connects IAM: a SCIM token shown once, the values for IAM, and its first request", async () => {
    const token = {
      id: "0b5a3e5e-3c1f-4d8e-9f3a-121212121212",
      name: "IAM",
      prefix: "cn_scim_abcd",
      lastUsedAt: null as string | null,
      expiresAt: "2027-11-19T10:00:00.000Z",
      createdAt: "2026-11-19T10:00:00.000Z",
      createdBy: "ada@example.org",
    };
    let tokens: (typeof token)[] = [];
    let posted: unknown;
    routeFetch({
      "GET /api/v1/admin/status": statusFixture({ problems: [] }),
      "GET /api/v1/admin/groups": { items: [] },
      "GET /api/v1/admin/scim-tokens": () => ({ items: tokens }),
      "POST /api/v1/admin/scim-tokens": (init?: RequestInit) => {
        posted = JSON.parse(String(init?.body));
        tokens = [token];
        return { ...token, secret: "cn_scim_secret_value" };
      },
    });
    renderAt("/admin/setup/iam", () => <SetupPage app="iam" onCreated={() => undefined} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Create SCIM token" }));
    const shown = await screen.findByTestId("guide-token");
    expect(shown).toHaveValue("cn_scim_secret_value");
    expect(shown).toHaveAttribute("type", "password");
    expect(posted).toEqual({ name: "IAM", expiresInDays: 365 });
    expect(screen.getByTestId("scim-url")).toHaveTextContent("https://connector.example.org/scim/v2");
    expect(screen.getByText("Waiting for IAM's first request…")).toBeInTheDocument();
    tokens = [{ ...token, lastUsedAt: new Date().toISOString() }];
    expect(await screen.findByText("IAM is connected", undefined, { timeout: 5000 })).toBeInTheDocument();
  });
});

function statusFixture(overrides: Partial<AdminStatus> = {}): AdminStatus {
  return {
    problems: [],
    sources: [],
    sourceChecks: { minutes: 15, lastRunAt: "2026-11-19T10:00:00.000Z" },
    directory: { mode: "oidc", syncMinutes: null, lastSync: null, people: 12, groups: 3 },
    scim: {
      url: "https://connector.example.org/scim/v2",
      tokens: 0,
      people: 0,
      lastUsedAt: null,
      lastRequest: null,
      lastError: null,
    },
    agents: {
      apps: [],
      personalTokens: 0,
      serviceTokens: 0,
      serviceLastUsedAt: null,
      week: { requests: 0, failed: 0, people: 0, bots: 0 },
    },
    ...overrides,
  };
}

describe("admin status", () => {
  it("shows problems with a way to fix each, every source, and apps not connected yet", async () => {
    const crmId = "0b5a3e5e-3c1f-4d8e-9f3a-343434343434";
    routeFetch({
      "GET /api/v1/admin/status": statusFixture({
        problems: [
          {
            key: `source:${crmId}`,
            severity: "error",
            title: "CRM is failing",
            detail: "CRM refused the credentials",
            area: "source",
            sourceId: crmId,
          },
          {
            key: "people:conflicts",
            severity: "warning",
            title: "1 person has an email address that someone else has",
            detail: "Correct the address in Keycloak.",
            area: "people",
            sourceId: null,
          },
        ],
        sources: [
          {
            id: crmId,
            slug: "crm",
            name: "CRM",
            kind: "crm",
            enabled: true,
            delivery: "live",
            state: "failing",
            status: { at: "2026-11-19T10:00:00.000Z", ok: false, message: "CRM refused the credentials" },
            items: null,
            lastDeliveryAt: null,
            requests: { total: 4, failed: 2, lastError: null },
          },
        ],
        agents: {
          apps: [{ name: "Claude", people: 3, lastUsedAt: null }],
          personalTokens: 1,
          serviceTokens: 1,
          serviceLastUsedAt: null,
          week: { requests: 40, failed: 2, people: 3, bots: 1 },
        },
      }),
    });
    renderAt("/admin", AdminStatusPage);
    const problems = await screen.findByRole("list", { name: "Needs attention" });
    expect(within(problems).getByText("CRM is failing")).toBeInTheDocument();
    expect(within(problems).getByRole("link", { name: "Open the setup" })).toHaveAttribute(
      "href",
      `/admin/setup/crm?source=${crmId}`,
    );
    expect(within(problems).getByRole("link", { name: "People" })).toHaveAttribute(
      "href",
      "/admin/people?q=conflict.invalid",
    );
    const crm = screen.getByTestId("source-crm");
    expect(within(crm).getByText("Failing")).toBeInTheDocument();
    expect(within(crm).getByText("Last 24 hours: 4 requests, 2 failed")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("connect-logbook")).getByRole("link", { name: "Connect Logbook" }),
    ).toHaveAttribute("href", "/admin/setup/logbook");
    expect(screen.queryByTestId("connect-crm")).not.toBeInTheDocument();
    expect(screen.getByText(/requests 40 · people 3 · bots 1/)).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
  });

  it("says when everything works", async () => {
    routeFetch({ "GET /api/v1/admin/status": statusFixture() });
    renderAt("/admin", AdminStatusPage);
    expect(await screen.findByText("Everything works")).toBeInTheDocument();
  });
});

describe("admin people", () => {
  it("protects yourself and admins from ADMIN_EMAILS, and shows groups and the directory", async () => {
    routeFetch({
      "GET /api/v1/me": me,
      "GET /api/v1/admin/people": {
        items: [
          person({ id: me.id, email: me.email, name: me.name, isAdmin: true, adminSource: "app" }),
          person({
            id: "0b5a3e5e-3c1f-4d8e-9f3a-777777777777",
            email: "root@example.org",
            name: "",
            isAdmin: true,
            adminSource: "environment",
          }),
          person({ groups: ["/staff", "/teams/Programs"], directory: "scim", title: "Program lead" }),
        ],
      },
    });
    renderAt("/admin/people", AdminPeoplePage);
    const self = (await screen.findByText("(you)")).closest("tr")!;
    expect(within(self).getByRole("switch")).toBeDisabled();
    expect(within(self).queryByRole("button", { name: "Block" })).not.toBeInTheDocument();
    const environment = screen.getByText("root@example.org").closest("tr")!;
    expect(within(environment).getByRole("switch")).toBeDisabled();
    expect(within(environment).getByText("From ADMIN_EMAILS")).toBeInTheDocument();
    const rita = screen.getByText("Rita Reader").closest("tr")!;
    expect(within(rita).getByRole("switch")).toBeEnabled();
    expect(within(rita).getByText("/teams/Programs")).toBeInTheDocument();
    expect(within(rita).getByText("SCIM")).toBeInTheDocument();
    expect(within(rita).getByText("Program lead")).toBeInTheDocument();
  });

  it("removes a person after asking", async () => {
    const rita = person({});
    const fetch = routeFetch({
      "GET /api/v1/me": me,
      "GET /api/v1/admin/people": { items: [rita] },
      [`DELETE /api/v1/admin/people/${rita.id}`]: {},
    });
    renderAt("/admin/people", AdminPeoplePage);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Remove Rita Reader?" });
    expect(dialog).toHaveTextContent("show them as “Removed person”");
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/api/v1/admin/people/${rita.id}`),
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });
});
