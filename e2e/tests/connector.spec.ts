import { createHash, createHmac, randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { APP, signIn } from "./helpers";

/*
 * The main flows in a real browser, signing in through Keycloak: an admin
 * connects a Logbook source with its setup guide and its webhook delivers a
 * decision; IAM and the Support Agent connect with their guides; people
 * find it in search and preview it; a reader is no admin; people outside
 * the access groups cannot sign in; an agent connects through OAuth and
 * finds the decision over MCP.
 */
test.describe.configure({ mode: "serial" });

const ENTRY_ID = "0196f1e2-0000-7000-8000-000000000012";
let webhookSecret = "";

async function home(page: Page) {
  await page.waitForURL(`${APP}/`);
  await expect(page.getByRole("heading", { name: /^Hello, / })).toBeVisible();
}

/** A signed Logbook delivery (Logbook docs/webhooks.md). */
async function deliver(secret: string, body: unknown) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex")}`;
  return fetch(`${APP}/hooks/logbook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "logbook-timestamp": timestamp,
      "logbook-signature": signature,
      "logbook-delivery": randomBytes(8).toString("hex"),
    },
    body: raw,
  });
}

const entry = {
  event: "entry.changed",
  entry: {
    id: ENTRY_ID,
    ref: "LB-12",
    url: "https://logbook.example.org/e/LB-12",
    type: "decision",
    status: "decided",
    title: "Trains for work trips",
    summary: "Work trips under 600 km go by train.",
    details: "Flights cost more and emit more.",
    rationale: "Cheaper and greener.",
    impact: "medium",
    team: "Operations",
    affected_teams: ["Programs"],
    tags: ["Travel"],
    author: "Ada Lovelace",
    published_at: "2026-11-04T09:00:00.000Z",
    in_force: true,
    supersedes: null,
    superseded_by: null,
    decision: {
      result: "adopted",
      text: "Book trains for every work trip under 600 km.",
      reversibility: "two_way",
      how_decided: "integrative_process",
      decider: "Ada Lovelace",
      decided_on: "2026-11-06",
      decided_at: "2026-11-06T09:00:00.000Z",
      objection_handling: null,
      open_objections: [],
      consent_givers: [],
      involved: [],
      proposal_version: 1,
    },
    addenda: [],
  },
};

async function mcp(token: string, method: string, params: unknown) {
  const response = await fetch(`${APP}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    result: { structuredContent?: Record<string, unknown>; tools?: { name: string }[] };
  };
}

test("an admin connects Logbook with its guide, and the guide sees the first delivery", async ({
  browser,
}) => {
  const ada = await signIn(browser, "ada");
  await home(ada);
  await ada.getByRole("link", { name: "Status" }).click();
  await ada.getByRole("link", { name: "Connect Logbook" }).click();
  await expect(ada.getByRole("heading", { name: "Connect Logbook" })).toBeVisible();
  await ada.getByLabel("Address").fill("https://logbook.example.org");
  await ada.getByRole("button", { name: "Connect", exact: true }).click();

  // The two values for Logbook's webhook, the secret hidden and copied once.
  await expect(ada.getByTestId("webhook-url")).toHaveText(`${APP}/hooks/logbook`);
  await expect(ada.getByRole("link", { name: "Admin → Integrations" })).toHaveAttribute(
    "href",
    "https://logbook.example.org/admin/integrations",
  );
  await expect(ada.getByLabel("Signing secret")).toHaveAttribute("type", "password");
  await ada.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: APP });
  await ada.getByTestId("step-3").getByRole("button", { name: "Copy" }).last().click();
  await expect(ada.getByRole("button", { name: "Copied" })).toBeVisible();
  webhookSecret = await ada.evaluate(() => navigator.clipboard.readText());
  expect(webhookSecret.length).toBeGreaterThan(20);
  await expect(ada.getByText("Waiting for Logbook…")).toBeVisible();

  // A delivery with another secret is refused, and the guide says so.
  expect((await deliver("wrong-secret-wrong-secret", entry)).status).toBe(401);
  await expect(ada.getByText("Logbook's delivery was refused")).toBeVisible();
  expect((await deliver(webhookSecret, entry)).status).toBe(200);
  await expect(ada.getByText("Logbook delivered")).toBeVisible();
  await expect(ada.getByText("Received LB-12 · 1 item")).toBeVisible();

  await ada.getByRole("link", { name: "Back to the status" }).click();
  await expect(ada.getByTestId("source-logbook").getByText("Working")).toBeVisible();
  await expect(ada.getByText("Waiting for the first delivery from Logbook")).toHaveCount(0);
});

test("an admin connects IAM and the Support Agent with their guides", async ({ browser }) => {
  const ada = await signIn(browser, "ada");
  await home(ada);
  await ada.goto(`${APP}/admin/setup/iam`);
  await ada.getByRole("button", { name: "Create SCIM token" }).click();
  const scimToken = await ada.getByTestId("guide-token").inputValue();
  await expect(ada.getByTestId("scim-url")).toHaveText(`${APP}/scim/v2`);
  await expect(ada.getByText("Waiting for IAM's first request…")).toBeVisible();
  // What IAM's "Test connection" asks first.
  const config = await fetch(`${APP}/scim/v2/ServiceProviderConfig`, {
    headers: { authorization: `Bearer ${scimToken}` },
  });
  expect(config.status).toBe(200);
  await expect(ada.getByText("IAM is connected")).toBeVisible();

  await ada.goto(`${APP}/admin/setup/support-agent`);
  await ada.getByRole("switch", { name: "Logbook: bots may read it" }).click();
  await expect(ada.getByRole("switch", { name: "Logbook: bots may read it" })).toBeChecked();
  await ada.getByRole("button", { name: "Create service token" }).click();
  const serviceToken = await ada.getByTestId("guide-token").inputValue();
  await expect(ada.getByTestId("knowledge-url")).toHaveText(`${APP}/api/v1/knowledge/search`);
  // The Support Agent's standard request.
  const search = await fetch(`${APP}/api/v1/knowledge/search`, {
    method: "POST",
    headers: { authorization: `Bearer ${serviceToken}`, "content-type": "application/json" },
    body: JSON.stringify({ query: "trains", limit: 6 }),
  });
  expect(search.status).toBe(200);
  expect(((await search.json()) as { results: { title: string }[] }).results[0]?.title).toContain(
    "Trains for work trips",
  );
  await expect(ada.getByText("The Support Agent is connected")).toBeVisible();

  await ada.getByRole("link", { name: "Back to the status" }).click();
  await expect(ada.getByText("SCIM tokens: 1 · people managed: 0")).toBeVisible();
  await expect(ada.getByText(/^Last request .*: GET \/ServiceProviderConfig$/)).toBeVisible();
});

test("people find the decision and read it in a preview", async ({ browser }) => {
  const rita = await signIn(browser, "rita");
  await home(rita);
  await expect(rita.getByText("Logbook").first()).toBeVisible();
  await rita.getByRole("searchbox", { name: "Search all your apps" }).fill("train");
  await rita.keyboard.press("Enter");
  await rita.waitForURL(/\/search\?q=train/);
  const result = rita.getByRole("link", { name: /LB-12: Trains for work trips/ });
  await expect(result).toBeVisible();
  await expect(result).toHaveAttribute("href", "https://logbook.example.org/e/LB-12");
  await expect(rita.getByText("Decisions in force").first()).toBeVisible();

  // The search of the sidebar asks the same API as Rita types.
  await rita.keyboard.press("ControlOrMeta+K");
  const search = rita.getByRole("dialog");
  await search.getByRole("combobox").fill("train");
  await expect(search.getByRole("option", { name: /LB-12: Trains for work trips/ })).toBeVisible();
  await rita.keyboard.press("Escape");
  await expect(search).toHaveCount(0);
  await rita.getByRole("button", { name: "Preview" }).first().click();
  const sheet = rita.getByRole("dialog");
  await expect(sheet.getByText("Book trains for every work trip under 600 km.")).toBeVisible();
  await expect(sheet.getByText("Operations").first()).toBeVisible();
});

test("readers are no admins", async ({ browser }) => {
  const rita = await signIn(browser, "rita");
  await home(rita);
  await expect(rita.getByRole("link", { name: "Sources" })).toHaveCount(0);
  await rita.goto("/admin/sources");
  await expect(rita.getByText("Not found")).toBeVisible();
  const response = await rita.request.get("/api/v1/admin/sources", {
    headers: { accept: "application/json" },
  });
  expect(response.status()).toBe(403);
});

test("people outside the access groups cannot sign in", async ({ browser }) => {
  const gina = await signIn(browser, "gina");
  await gina.waitForURL(/\/sign-in\?error=/);
  await expect(gina.getByText("This account has no access")).toBeVisible();
});

test("an agent connects with OAuth and finds the decision over MCP", async ({ browser }) => {
  const metadata = (await fetch(`${APP}/.well-known/oauth-authorization-server`).then((r) => r.json())) as {
    registration_endpoint: string;
    authorization_endpoint: string;
    token_endpoint: string;
  };
  const redirect = "http://localhost:9999/callback";
  const client = (await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test Assistant",
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
    }),
  }).then((r) => r.json())) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(metadata.authorization_endpoint);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirect,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "e2e",
    resource: `${APP}/mcp`,
  })) {
    authorize.searchParams.set(key, value);
  }

  const rita = await signIn(browser, "rita");
  await home(rita);
  let callback = "";
  await rita.route("http://localhost:9999/**", (route) => {
    callback = route.request().url();
    return route.fulfill({ status: 200, body: "ok" });
  });
  await rita.goto(authorize.toString());
  await expect(rita.getByRole("heading", { name: "Connect Test Assistant?" })).toBeVisible();
  await rita.getByRole("button", { name: "Connect" }).click();
  await rita.waitForURL(/localhost:9999/);
  const code = new URL(callback).searchParams.get("code")!;
  expect(new URL(callback).searchParams.get("state")).toBe("e2e");

  const tokens = (await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: client.client_id,
      code_verifier: verifier,
    }),
  }).then((r) => r.json())) as { access_token: string };

  const tools = (await mcp(tokens.access_token, "tools/list", {})).result.tools!.map((tool) => tool.name);
  expect(tools).toEqual(expect.arrayContaining(["search", "fetch", "get_context", "list_sources"]));
  const found = (
    await mcp(tokens.access_token, "tools/call", { name: "search", arguments: { query: "train" } })
  ).result.structuredContent as { results: { id: string; url: string }[] };
  expect(found.results[0]).toMatchObject({
    id: `logbook:decision:${ENTRY_ID}`,
    url: "https://logbook.example.org/e/LB-12",
  });
  const item = (
    await mcp(tokens.access_token, "tools/call", { name: "fetch", arguments: { id: found.results[0]!.id } })
  ).result.structuredContent as { text: string };
  expect(item.text).toContain("Book trains for every work trip under 600 km.");

  // The connected app shows in Settings, and the activity log records what it asked.
  await rita.goto("/settings");
  await expect(rita.getByText("Test Assistant")).toBeVisible();
  const ada = await signIn(browser, "ada");
  await home(ada);
  await ada.goto("/admin/activity");
  await expect(ada.getByText(/Test Assistant/).first()).toBeVisible();
});
