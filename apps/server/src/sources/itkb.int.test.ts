import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminToken, createUser, request, resetDatabase, testApp } from "../test/helpers";
import { signatureOf } from "./webhooks";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

/*
 * The IT Knowledge Base sends each page of its memory export, then the IDs
 * of all pages. Groups are invented Keycloak paths: staff read the
 * knowledge base, IT operators also read the operator pages.
 */

const SECRET = "it-knowledge-base-webhook-secret";
const STAFF = "/example/tools/knowledge-base";
const OPERATORS = "/example/roles/it-operators";
const SITE = "https://it.example.org";

async function deliver(payload: unknown, options: { secret?: string } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await testApp().request("/hooks/itkb", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "itkb-timestamp": timestamp,
      "itkb-signature": signatureOf(options.secret ?? SECRET, timestamp, body),
    },
    body,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

type PageInput = {
  id: string;
  title: string;
  route: string;
  /** The page's file; addresses are flat, folders are sections. */
  file: string;
  text: string;
  visibility?: string;
  allowed_groups?: string[];
  status?: string;
  agent?: Record<string, unknown>;
  search_terms?: string[];
};

function changed(page: PageInput) {
  const visibility = page.visibility ?? "staff";
  return {
    event: "page.changed",
    page: {
      id: page.id,
      title: page.title,
      description: `About ${page.title.toLowerCase()}.`,
      search_terms: page.search_terms ?? [],
      page_type: "guideline",
      status: page.status ?? "active",
      visibility,
      allowed_groups: page.allowed_groups ?? (visibility === "public" ? [] : [STAFF]),
      last_updated: "2026-11-02",
      route: page.route,
      source_path: page.file,
      rendered_url: `${SITE}${visibility === "public" ? "/public" : ""}${page.route}`,
      agent: {
        confidence: "official",
        can_answer: true,
        can_recommend: false,
        escalation: null,
        ...page.agent,
      },
    },
    // The export splits a page into chunks that start at their headings.
    chunks: [{ text: `# ${page.title}\n\nIntro.` }, { text: `## Details\n\n${page.text}` }],
  };
}

const PAGES: PageInput[] = [
  {
    id: "tool.vpn",
    title: "VPN",
    route: "/vpn",
    file: "docs/software/vpn.md",
    text: "Connect to the office network with the VPN client.",
    search_terms: ["Fernzugang"],
  },
  {
    id: "guideline.passwords",
    title: "Password policy",
    route: "/passwords",
    file: "docs/policies/passwords.md",
    text: "Use a password manager and a second factor for every network account.",
  },
  {
    id: "guideline.old_wifi",
    title: "Old wifi policy",
    route: "/old-wifi",
    file: "docs/policies/old-wifi.md",
    text: "The guest network password changes monthly.",
    status: "deprecated",
  },
  {
    id: "workflow.firewall",
    title: "Firewall changes",
    route: "/firewall",
    file: "docs/workflows/firewall.md",
    text: "Operators change network firewall rules through the change log.",
    visibility: "it-operator",
    allowed_groups: [OPERATORS],
  },
  {
    id: "tool.guest_wifi",
    title: "Guest wifi",
    route: "/guest-wifi",
    file: "docs/guest-wifi.md",
    text: "Guests join the network named Visitors.",
    visibility: "public",
  },
];

async function connect(admin: { id: string }) {
  const created = await request("POST", "/api/v1/admin/sources", {
    userId: admin.id,
    body: {
      kind: "itkb",
      slug: "itkb",
      name: "IT Knowledge Base",
      config: { baseUrl: SITE },
      secret: { webhookSecret: SECRET },
      accessGroups: [STAFF],
      serviceAccess: true,
    },
  });
  expect(created.status).toBe(201);
  return created.body as { id: string; config: Record<string, unknown>; webhookUrl: string };
}

const found = (body: { results: { id: string; authority: string; status: string | null }[] }) =>
  Object.fromEntries(body.results.map((result) => [result.id, [result.authority, result.status]]));

describe("IT Knowledge Base", () => {
  beforeEach(resetDatabase);

  it("indexes each page for the groups the site allows, with policies as rules", async () => {
    const admin = await createUser({ isAdmin: true, signInGroups: [STAFF] });
    const source = await connect(admin);
    expect(source.config).toEqual({ baseUrl: SITE, ruleSections: ["policies"] });
    expect(source.webhookUrl).toBe("http://localhost:3000/hooks/itkb");
    for (const page of PAGES) expect((await deliver(changed(page))).status).toBe(200);

    const staff = await createUser({ signInGroups: [STAFF] });
    const search = await request("GET", "/api/v1/search?q=network&limit=50", { userId: staff.id });
    expect(found(search.body)).toEqual({
      "itkb:page:tool.vpn": ["knowledge", null],
      "itkb:page:guideline.passwords": ["rules", null],
      "itkb:page:guideline.old_wifi": ["knowledge", "deprecated"],
      "itkb:page:tool.guest_wifi": ["knowledge", null],
    });
    // German search terms of the export find the English page.
    const german = await request("GET", "/api/v1/search?q=Fernzugang", { userId: staff.id });
    expect(german.body.results.map((result: { id: string }) => result.id)).toEqual(["itkb:page:tool.vpn"]);

    // Operator pages: members of the operator group only (who also pass the source's access groups).
    const operator = await createUser({ signInGroups: [STAFF, OPERATORS] });
    const operatorSearch = await request("GET", "/api/v1/search?q=firewall", { userId: operator.id });
    expect(operatorSearch.body.results.map((result: { id: string }) => result.id)).toEqual([
      "itkb:page:workflow.firewall",
    ]);
    expect(
      (await request("GET", "/api/v1/items/itkb:page:workflow.firewall", { userId: staff.id })).status,
    ).toBe(404);
    // A subgroup of the staff group passes the source's access groups, but like the site, only
    // members of the staff group itself see more than public pages, operators included.
    const subgroup = await createUser({ signInGroups: [`${STAFF}/interns`, OPERATORS] });
    expect(
      (await request("GET", "/api/v1/search?q=network&limit=50", { userId: subgroup.id })).body.results.map(
        (result: { id: string }) => result.id,
      ),
    ).toEqual(["itkb:page:tool.guest_wifi"]);
    expect(
      (await request("GET", "/api/v1/items/itkb:page:workflow.firewall", { userId: subgroup.id })).status,
    ).toBe(404);

    // Bots read what is meant for everyone the source is open to: staff and public pages, never operator pages.
    const bot = await createAdminToken("service", "Support Agent");
    const botTitles = async () =>
      (
        await request("POST", "/api/v1/knowledge/search", {
          token: bot,
          body: { query: "network", limit: 20 },
        })
      ).body.results
        .map((result: { title: string }) => result.title)
        .sort();
    expect(await botTitles()).toEqual(["Guest wifi", "Old wifi policy", "Password policy", "VPN"]);

    // Reading a page: its chunks in order, linked to the site.
    const vpn = await request("GET", "/api/v1/items/itkb:page:tool.vpn", { userId: staff.id });
    expect(vpn.body).toMatchObject({
      title: "VPN",
      url: `${SITE}/vpn`,
      authority: "knowledge",
      date: "2026-11-02T00:00:00.000Z",
      text: "# VPN\n\nIntro.\n\n## Details\n\nConnect to the office network with the VPN client.",
      metadata: { section: "software", searchTerms: ["Fernzugang"] },
    });

    // The rule sections are read at every search: other sections, other ranks.
    await request("PATCH", `/api/v1/admin/sources/${source.id}`, {
      userId: admin.id,
      body: { config: { baseUrl: SITE, ruleSections: ["software"] } },
    });
    const after = await request("GET", "/api/v1/search?q=network&limit=50", { userId: staff.id });
    expect(found(after.body)["itkb:page:tool.vpn"]).toEqual(["rules", null]);
    expect(found(after.body)["itkb:page:guideline.passwords"]).toEqual(["knowledge", null]);

    // Bots read only pages meant for everyone the source is open to: all of its access groups.
    const openTo = (accessGroups: string[]) =>
      request("PATCH", `/api/v1/admin/sources/${source.id}`, { userId: admin.id, body: { accessGroups } });
    await openTo([OPERATORS]);
    expect(await botTitles()).toEqual(["Firewall changes", "Guest wifi"]);
    // Staff and operators: staff pages are not for operators outside staff, operator pages not for staff.
    await openTo([STAFF, OPERATORS]);
    expect(await botTitles()).toEqual(["Guest wifi"]);
    // Everyone signed in: no group of its own, only public pages.
    await openTo([]);
    expect(await botTitles()).toEqual(["Guest wifi"]);
  });

  it("drops pages not meant for answers and pages the export no longer lists", async () => {
    const admin = await createUser({ isAdmin: true, signInGroups: [STAFF] });
    await connect(admin);
    for (const page of PAGES) await deliver(changed(page));
    const ids = async () =>
      (await request("GET", "/api/v1/search?q=network&limit=50", { userId: admin.id })).body.results.map(
        (result: { id: string }) => result.id,
      );
    expect(await ids()).toHaveLength(4);

    const hidden = await deliver(changed({ ...PAGES[0]!, agent: { can_answer: false } }));
    expect(hidden).toEqual({ status: 200, body: { ok: true, message: "Left out: not meant for answers" } });
    expect(await ids()).not.toContain("itkb:page:tool.vpn");

    const completed = await deliver({
      event: "export.completed",
      source_version: "abc123",
      page_ids: ["guideline.passwords", "workflow.firewall", "tool.guest_wifi"],
    });
    expect(completed).toEqual({ status: 200, body: { ok: true, message: "Removed 1 page" } });
    expect((await ids()).sort()).toEqual(["itkb:page:guideline.passwords", "itkb:page:tool.guest_wifi"]);
    const status = await request("GET", "/api/v1/admin/sources", { userId: admin.id });
    expect(status.body.items[0]).toMatchObject({
      status: { ok: true, message: "Received the export of 3 pages" },
      stats: { items: 3 },
    });
  });

  it("refuses deliveries with another secret or another shape", async () => {
    const admin = await createUser({ isAdmin: true });
    await connect(admin);
    expect((await deliver(changed(PAGES[0]!), { secret: "another-secret-entirely" })).status).toBe(401);
    expect((await deliver({ event: "page.changed", page: { id: "x" } })).status).toBe(400);
    expect((await deliver({ event: "export.completed", page_ids: [] })).status).toBe(400);
    const status = await request("GET", "/api/v1/admin/sources", { userId: admin.id });
    expect(status.body.items[0].stats.items).toBe(0);
  });
});
