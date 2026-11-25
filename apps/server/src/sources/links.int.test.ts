import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { resetConfigForTests } from "../config";
import { getDb } from "../db/client";
import { sourceLinks } from "../db/schema";
import { decryptJson, encryptJson } from "../core/crypto";
import { bearerOf, startFakeApp, type FakeApp } from "../test/fake-app";
import { createSource, createToken, createUser, request, resetDatabase } from "../test/helpers";
import { clearDiscoveryCache } from "./links";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

const PAGE_ID = "44444444-4444-4444-8444-444444444444";

let handbook: FakeApp;
let challenge = "";
let refreshes = 0;
let usedRefreshTokens = new Set<string>();

beforeAll(async () => {
  handbook = await startFakeApp((req) => {
    const form = Object.fromEntries(new URLSearchParams(req.body));
    const token = bearerOf(req);
    switch (`${req.method} ${req.path}`) {
      case "GET /.well-known/oauth-protected-resource":
        return { json: { resource: `${handbook.url}/mcp`, authorization_servers: [handbook.url] } };
      case "GET /.well-known/oauth-authorization-server":
        return {
          json: {
            issuer: handbook.url,
            authorization_endpoint: `${handbook.url}/oauth/authorize`,
            token_endpoint: `${handbook.url}/oauth/token`,
            registration_endpoint: `${handbook.url}/oauth/register`,
            revocation_endpoint: `${handbook.url}/oauth/revoke`,
            scopes_supported: ["handbook"],
            code_challenge_methods_supported: ["S256"],
          },
        };
      case "POST /oauth/register":
        return {
          delayMs: 50,
          status: 201,
          json: { client_id: "connector-client", client_secret: "client-secret" },
        };
      case "POST /oauth/token":
        if (form.client_id !== "connector-client" || form.client_secret !== "client-secret")
          return { status: 401, json: { error: "invalid_client" } };
        if (form.resource !== `${handbook.url}/mcp`)
          return { status: 400, json: { error: "invalid_target" } };
        if (form.grant_type === "authorization_code") {
          const ok =
            form.code === "the-code" &&
            createHash("sha256")
              .update(form.code_verifier ?? "")
              .digest("base64url") === challenge &&
            form.redirect_uri === "http://localhost:3000/api/v1/links/callback";
          return ok
            ? { json: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 } }
            : { status: 400, json: { error: "invalid_grant" } };
        }
        if (form.grant_type === "refresh_token") {
          refreshes += 1;
          const used = form.refresh_token ?? "";
          if (usedRefreshTokens.has(used)) return { status: 400, json: { error: "invalid_grant" } };
          usedRefreshTokens.add(used);
          return {
            delayMs: 50,
            json: {
              access_token: `at-${refreshes + 1}`,
              refresh_token: `rt-${refreshes + 1}`,
              expires_in: 3600,
            },
          };
        }
        return { status: 400, json: { error: "unsupported_grant_type" } };
      case "POST /oauth/revoke":
        return { status: 200 };
      case "GET /api/v1/me":
        return token?.startsWith("at-") ? { json: { email: "rita@example.org" } } : { status: 401, json: {} };
      case "GET /api/v1/search":
        return {
          json: {
            results: [
              {
                pageId: PAGE_ID,
                space: { slug: "it", name: "IT" },
                path: "vpn",
                title: token?.startsWith("at-") ? "VPN (draft)" : "VPN",
                headingPath: [],
                url: `${handbook.url}/s/it/vpn`,
                snippet: "",
                tags: [],
              },
            ],
          },
        };
      case `GET /api/v1/pages/${PAGE_ID}`:
        return {
          json: {
            id: PAGE_ID,
            space: "it",
            spaceName: "IT",
            path: "vpn",
            title: "VPN",
            description: null,
            status: "active",
            type: null,
            tags: [],
            revision: 1,
            updatedAt: "2026-11-01T00:00:00.000Z",
            body: "Use the VPN.",
            properties: {},
          },
        };
      case "POST /api/v1/change-sets":
        return token?.startsWith("at-")
          ? { status: 201, json: { number: 7, status: "open", space: { slug: "it" } } }
          : { status: 403, json: {} };
      case `POST /api/v1/change-sets/7/pages/${PAGE_ID}/edit`:
        return { json: {} };
      case "GET /api/v1/spaces/it/pages/by-path":
        return req.url.searchParams.get("path") === "vpn"
          ? { json: { id: PAGE_ID } }
          : { status: 404, json: { error: { code: "not_found", message: "Not found" } } };
      case "PUT /api/v1/change-sets/7/pages":
        return { json: {} };
      case "POST /api/v1/change-sets/7/submit":
        return { json: { number: 7, status: "in_review", space: { slug: "it" } } };
      default:
        return { status: 404, json: { error: { code: "not_found", message: "Not found" } } };
    }
  });
});
afterAll(() => handbook.close());

async function link(userId: string) {
  const started = await request("POST", "/api/v1/links/handbook", { userId });
  expect(started.status).toBe(200);
  const url = new URL(started.body.authorizeUrl as string);
  challenge = url.searchParams.get("code_challenge")!;
  return url;
}

describe("linked accounts", () => {
  beforeEach(async () => {
    await resetDatabase();
    clearDiscoveryCache();
    refreshes = 0;
    usedRefreshTokens = new Set();
    handbook.requests.length = 0;
  });

  it("link a Handbook account with OAuth (registration, PKCE, resource) and use it for the person", async () => {
    await createSource({
      kind: "handbook",
      config: { baseUrl: handbook.url, ruleSpaces: [], allowLinking: true },
      secret: { serviceToken: "svc" },
    });
    const rita = await createUser({ email: "rita@example.org" });
    const url = await link(rita.id);
    expect(url.origin + url.pathname).toBe(`${handbook.url}/oauth/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "connector-client",
      redirect_uri: "http://localhost:3000/api/v1/links/callback",
      code_challenge_method: "S256",
      resource: `${handbook.url}/mcp`,
      scope: "handbook",
    });
    const registration = JSON.parse(
      handbook.requests.find((req) => req.path === "/oauth/register")!.body,
    ) as Record<string, unknown>;
    expect(registration).toMatchObject({
      redirect_uris: ["http://localhost:3000/api/v1/links/callback"],
      token_endpoint_auth_method: "client_secret_post",
    });

    // Someone else cannot finish Rita's link.
    const eddie = await createUser();
    const stolen = await request(
      "GET",
      `/api/v1/links/callback?code=the-code&state=${url.searchParams.get("state")}`,
      { userId: eddie.id },
    );
    expect(stolen.headers.get("location")).toBe(
      `/settings?link_error=${encodeURIComponent("This link was started by someone else")}`,
    );

    const again = await link(rita.id);
    const back = await request(
      "GET",
      `/api/v1/links/callback?code=the-code&state=${again.searchParams.get("state")}&iss=${encodeURIComponent(handbook.url)}`,
      { userId: rita.id },
    );
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/settings?linked=handbook");
    expect((await request("GET", "/api/v1/links", { userId: rita.id })).body.items).toEqual([
      expect.objectContaining({ source: "handbook", label: "rita@example.org" }),
    ]);
    const [stored] = await getDb().select().from(sourceLinks);
    expect(stored!.tokensEncrypted).not.toContain("at-1");

    // Rita's agent reads Handbook as Rita; others use the service token.
    const agent = await createToken(rita.id, "Claude");
    const mine = await request("GET", "/api/v1/search?q=vpn", { token: agent });
    expect(mine.body.results[0].title).toBe("VPN (draft)");
    expect(bearerOf(handbook.requests.at(-1)!)).toBe("at-1");
    const theirs = await request("GET", "/api/v1/search?q=vpn", { userId: eddie.id });
    expect(theirs.body.results[0].title).toBe("VPN");
    expect((await request("GET", "/api/v1/sources", { userId: rita.id })).body.items[0]).toMatchObject({
      linkable: true,
      linked: true,
    });

    // An ended access token is refreshed once, also when two requests need it at the same time.
    await getDb()
      .update(sourceLinks)
      .set({
        tokensEncrypted: encryptJson({
          accessToken: "at-1",
          refreshToken: "rt-1",
          expiresAt: Date.now() - 1000,
        }),
      });
    const [first, second] = await Promise.all([
      request("GET", "/api/v1/search?q=vpn", { token: agent }),
      request("GET", "/api/v1/search?q=vpn", { token: agent }),
    ]);
    expect(first.body.results[0].title).toBe("VPN (draft)");
    expect(second.body.results[0].title).toBe("VPN (draft)");
    expect(refreshes).toBe(1);
    const [refreshed] = await getDb().select().from(sourceLinks);
    expect(decryptJson(refreshed!.tokensEncrypted)).toMatchObject({
      accessToken: "at-2",
      refreshToken: "rt-2",
    });

    // A refresh token the source no longer takes ends the link.
    await getDb()
      .update(sourceLinks)
      .set({
        tokensEncrypted: encryptJson({
          accessToken: "at-1",
          refreshToken: "rt-1",
          expiresAt: Date.now() - 1000,
        }),
      });
    expect((await request("GET", "/api/v1/search?q=vpn", { token: agent })).body.results[0].title).toBe(
      "VPN",
    );
    expect(await getDb().select().from(sourceLinks)).toHaveLength(0);
  });

  it("propose Handbook changes as the person, for review", async () => {
    await createSource({
      kind: "handbook",
      config: { baseUrl: handbook.url, ruleSpaces: [], allowLinking: true },
      secret: { serviceToken: "svc" },
    });
    const rita = await createUser({ email: "rita@example.org" });
    const agent = await createToken(rita.id, "Claude");
    const proposal = {
      page: `handbook:page:${PAGE_ID}`,
      edits: [{ oldText: "Use the VPN.", newText: "Use the VPN at home and when travelling." }],
      title: "VPN when travelling",
      description: "LB-12 says so.",
    };
    const unlinked = await request("POST", "/api/v1/proposals", { token: agent, body: proposal });
    expect(unlinked.status).toBe(409);
    expect(unlinked.body.error.message).toContain("Link your Handbook account first");

    const url = await link(rita.id);
    await request("GET", `/api/v1/links/callback?code=the-code&state=${url.searchParams.get("state")}`, {
      userId: rita.id,
    });
    const created = await request("POST", "/api/v1/proposals", { token: agent, body: proposal });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ number: 7, url: `${handbook.url}/changes/7`, status: "in_review" });
    const edit = handbook.requests.find((req) => req.path.endsWith("/edit"))!;
    expect(bearerOf(edit)).toBe("at-1");
    expect(JSON.parse(edit.body)).toEqual({ edits: proposal.edits });
    const newPage = await request("POST", "/api/v1/proposals", {
      token: agent,
      body: {
        newPage: { space: "it", path: "wifi", title: "Wi-Fi: guests", body: "Ask at the desk." },
        title: "Guest Wi-Fi",
        description: "Asked often.",
      },
    });
    expect(newPage.status).toBe(201);
    const put = handbook.requests.find((req) => req.method === "PUT")!;
    expect(JSON.parse(put.body)).toEqual({
      path: "wifi",
      markdown: '---\ntitle: "Wi-Fi: guests"\n---\n\nAsk at the desk.\n',
    });

    // The page ID and the space become part of Handbook's address: nothing but an ID and a slug.
    const before = handbook.requests.length;
    for (const body of [
      { ...proposal, page: "handbook:page:../../../admin/people?x=1" },
      { ...proposal, page: `handbook:page:${PAGE_ID}/../../spaces` },
      { ...proposal, page: `handbook:page:${"4".repeat(36)}` },
      {
        newPage: { space: "..", path: "wifi", title: "Wi-Fi", body: "x" },
        title: "Guest Wi-Fi",
        description: "Asked often.",
      },
    ]) {
      expect((await request("POST", "/api/v1/proposals", { token: agent, body })).status).toBe(422);
    }
    expect(handbook.requests).toHaveLength(before);

    // A new page only at a free path; a taken one would be replaced.
    const taken = await request("POST", "/api/v1/proposals", {
      token: agent,
      body: {
        newPage: { space: "it", path: "vpn", title: "VPN", body: "x" },
        title: "VPN",
        description: "x",
      },
    });
    expect(taken.status).toBe(409);
    expect(taken.body.error.message).toContain("A page exists at it/vpn");

    expect((await request("DELETE", "/api/v1/links/handbook", { userId: rita.id })).status).toBe(204);
    expect(
      handbook.requests.some((req) => req.path === "/oauth/revoke" && req.body.includes("token=rt-1")),
    ).toBe(true);
    expect((await request("DELETE", "/api/v1/links/handbook", { userId: rita.id })).status).toBe(404);
  });

  it("register Connector once, also when two people start linking at the same time", async () => {
    await createSource({
      kind: "handbook",
      config: { baseUrl: handbook.url, ruleSpaces: [], allowLinking: true },
      secret: { serviceToken: "svc" },
    });
    const [rita, eddie] = [await createUser(), await createUser()];
    const started = await Promise.all([
      request("POST", "/api/v1/links/handbook", { userId: rita.id }),
      request("POST", "/api/v1/links/handbook", { userId: eddie.id }),
    ]);
    expect(started.map((response) => response.status)).toEqual([200, 200]);
    expect(handbook.requests.filter((req) => req.path === "/oauth/register")).toHaveLength(1);
  });

  it("refuse links to sources the person may not use, and sign-in servers elsewhere", async () => {
    await createSource({
      kind: "handbook",
      config: { baseUrl: handbook.url, ruleSpaces: [], allowLinking: true },
      accessGroups: ["/staff"],
    });
    const guest = await createUser({ signInGroups: ["/guests"] });
    expect((await request("POST", "/api/v1/links/handbook", { userId: guest.id })).status).toBe(404);
    const elsewhere = await startFakeApp(() => ({
      json: { resource: "x", authorization_servers: [handbook.url] },
    }));
    try {
      await createSource({
        kind: "handbook",
        slug: "other",
        config: { baseUrl: elsewhere.url, ruleSpaces: [], allowLinking: true },
      });
      const refused = await request("POST", "/api/v1/links/other", { userId: guest.id });
      expect(refused.status).toBe(404);
      expect(refused.body.error.message).toBe(
        "The source's sign-in server is on another address than the source",
      );
    } finally {
      await elsewhere.close();
    }
  });

  it("name failed sign-in metadata in fixed words, never by the address the source gave", async () => {
    const missing = await startFakeApp(() => ({ status: 404, json: {} }));
    try {
      await createSource({
        kind: "handbook",
        slug: "missing",
        config: { baseUrl: missing.url, ruleSpaces: [], allowLinking: true },
      });
      const rita = await createUser();
      const refused = await request("POST", "/api/v1/links/missing", { userId: rita.id });
      expect(refused.body.error.message).toBe("The source's sign-in metadata answered HTTP 404");
    } finally {
      await missing.close();
    }
  });

  it("refuse links where the source does not allow them", async () => {
    await createSource({
      kind: "handbook",
      config: { baseUrl: handbook.url, ruleSpaces: [], allowLinking: false },
    });
    await createSource({
      kind: "logbook",
      slug: "logbook",
      config: { baseUrl: "https://logbook.example.org" },
    });
    const rita = await createUser();
    expect((await request("POST", "/api/v1/links/handbook", { userId: rita.id })).status).toBe(404);
    expect((await request("POST", "/api/v1/links/logbook", { userId: rita.id })).status).toBe(404);
    expect(
      (await request("POST", "/api/v1/links/handbook", { token: await createToken(rita.id) })).status,
    ).toBe(403);
    expect(await getDb().select().from(sourceLinks).where(eq(sourceLinks.userId, rita.id))).toHaveLength(0);
  });

  it("ends a refresh within the request's time budget, so the link is not held", async () => {
    process.env.SOURCE_TIMEOUT_SECONDS = "1";
    resetConfigForTests();
    const stuck = await startFakeApp((req) => {
      switch (`${req.method} ${req.path}`) {
        case "GET /.well-known/oauth-protected-resource":
          return { json: { resource: `${stuck.url}/mcp`, authorization_servers: [stuck.url] } };
        case "GET /.well-known/oauth-authorization-server":
          return {
            json: {
              issuer: stuck.url,
              authorization_endpoint: `${stuck.url}/oauth/authorize`,
              token_endpoint: `${stuck.url}/oauth/token`,
              registration_endpoint: `${stuck.url}/oauth/register`,
              code_challenge_methods_supported: ["S256"],
            },
          };
        case "POST /oauth/register":
          return { status: 201, json: { client_id: "connector-client", client_secret: "client-secret" } };
        case "POST /oauth/token":
          return { delayMs: 8000, json: { access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 } };
        default:
          return { json: { results: [] } };
      }
    });
    try {
      const source = await createSource({
        kind: "handbook",
        config: { baseUrl: stuck.url, ruleSpaces: [], allowLinking: true },
        secret: { serviceToken: "svc" },
      });
      const rita = await createUser({ email: "rita@example.org" });
      const [stored] = await getDb()
        .insert(sourceLinks)
        .values({
          sourceId: source.id,
          userId: rita.id,
          tokensEncrypted: encryptJson({
            accessToken: "at-1",
            refreshToken: "rt-1",
            expiresAt: Date.now() - 1000,
          }),
          label: "rita@example.org",
        })
        .returning();
      const searched = await request("GET", "/api/v1/search?q=vpn", { token: await createToken(rita.id) });
      expect(searched.body.sources).toMatchObject([{ ok: false, error: "handbook did not answer in time" }]);
      // It got as far as the refresh, which holds the link's row lock.
      expect(stuck.requests.map((req) => req.path)).toContain("/oauth/token");
      // The refresh ended with the request: its row lock is free again.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const lockFree = await getDb()
        .transaction(async (tx) => {
          await tx.execute(sql`select id from source_links where id = ${stored!.id} for update nowait`);
        })
        .then(
          () => true,
          () => false,
        );
      expect(lockFree).toBe(true);
    } finally {
      delete process.env.SOURCE_TIMEOUT_SECONDS;
      resetConfigForTests();
      await stuck.close();
    }
  });
});
