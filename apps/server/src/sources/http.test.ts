import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { startFakeApp, type FakeAnswer, type FakeApp } from "../test/fake-app";
import { sourceFetch, sourceRequest } from "./http";
import { SourceError } from "./types";

let app: FakeApp;
const answers: Record<string, FakeAnswer> = {
  "/ok": { json: { items: [] } },
  "/unauthorized": {
    status: 401,
    json: { error: { code: "unauthorized", message: "Unknown token tok_123" } },
  },
  "/forbidden": { status: 403, json: { error: { message: "No access for rita@example.org" } } },
  "/missing": { status: 404, json: { error: { message: "Page 7 is in the space finance" } } },
  "/invalid": { status: 422, json: { error: { message: "The edit does not apply to the page text" } } },
  "/broken": { status: 500, json: { error: { message: "boom at /var/app" } } },
  "/moved": { status: 302, headers: { location: "https://elsewhere.example.org/" } },
  "/slow": { json: {}, delayMs: 2000 },
  "/other": { json: { something: "else" } },
};

beforeAll(async () => {
  app = await startFakeApp((request) => answers[request.path] ?? { status: 404 });
});
afterAll(() => app.close());

async function failure(path: string, signal = AbortSignal.timeout(5000)): Promise<SourceError> {
  const error = await sourceRequest(`${app.url}${path}`, {
    token: "tok_123",
    signal,
    schema: z.object({ items: z.array(z.unknown()) }),
    app: "Handbook",
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SourceError);
  return error as SourceError;
}

describe("source requests", () => {
  it("answers with the parsed JSON", async () => {
    const ok = await sourceRequest(`${app.url}/ok`, {
      token: "tok_123",
      signal: AbortSignal.timeout(5000),
      schema: z.object({ items: z.array(z.unknown()) }),
      app: "Handbook",
    });
    expect(ok).toEqual({ items: [] });
    expect(app.requests.at(-1)?.headers).toMatchObject({
      authorization: "Bearer tok_123",
      "user-agent": "Connector",
    });
  });

  it("classifies failures and keeps the app's words out of the diagnostic", async () => {
    const cases = await Promise.all(
      ["/unauthorized", "/forbidden", "/missing", "/invalid", "/broken", "/moved", "/other"].map(
        async (path) => {
          const { kind, message, diagnostic } = await failure(path);
          return { path, kind, message, diagnostic };
        },
      ),
    );
    expect(cases).toEqual([
      {
        path: "/unauthorized",
        kind: "refused",
        // Never the token it got, even when the app repeats it.
        message: "Handbook refused the credentials: Unknown token …",
        diagnostic: "Handbook refused the credentials",
      },
      {
        path: "/forbidden",
        kind: "refused",
        message: "Handbook does not allow this: No access for rita@example.org",
        diagnostic: "Handbook does not allow this",
      },
      {
        path: "/missing",
        kind: "not_found",
        message: "Handbook has no such item",
        diagnostic: "Handbook has no such item",
      },
      {
        path: "/invalid",
        kind: "rejected",
        message: "Handbook answered HTTP 422: The edit does not apply to the page text",
        diagnostic: "Handbook answered HTTP 422",
      },
      {
        path: "/broken",
        kind: "failed",
        message: "Handbook answered HTTP 500: boom at /var/app",
        diagnostic: "Handbook answered HTTP 500",
      },
      {
        path: "/moved",
        kind: "failed",
        message: "Handbook redirected the request; check the address",
        diagnostic: "Handbook redirected the request; check the address",
      },
      {
        path: "/other",
        kind: "failed",
        message: "Handbook sent an answer Connector does not understand",
        diagnostic: "Handbook sent an answer Connector does not understand",
      },
    ]);
  });

  it("ends at the caller's signal, and names an app it cannot reach by its address only", async () => {
    expect(await failure("/slow", AbortSignal.timeout(100))).toMatchObject({
      kind: "failed",
      message: "Handbook did not answer in time",
    });
    const closed = await startFakeApp(() => ({}));
    const address = closed.url;
    await closed.close();
    const unreachable = await sourceFetch(`${address}/ok`, {
      signal: AbortSignal.timeout(5000),
      app: "Handbook",
    }).catch((caught: unknown) => caught);
    expect(unreachable).toMatchObject({
      kind: "failed",
      message: `Could not reach Handbook at ${address}: ECONNREFUSED`,
    });
  });

  it("ends at the signal or the size limit while the body still arrives", async () => {
    const server = createServer((_, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      if (_.url === "/huge") {
        // No Content-Length: the limit applies as the body arrives.
        const chunk = "x".repeat(1024 * 1024);
        const send = () => {
          while (!response.destroyed && response.write(chunk));
          if (!response.destroyed) response.once("drain", send);
        };
        send();
      } else if (_.url === "/bom") response.end('\uFEFF{"items":[]}');
      else response.write("{"); // Headers, then nothing more.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const stalled = await sourceFetch(`${base}/stalled`, {
        signal: AbortSignal.timeout(200),
        app: "Handbook",
      }).catch((caught: unknown) => caught);
      expect(stalled).toMatchObject({ kind: "failed", message: "Handbook did not answer in time" });
      const huge = await sourceFetch(`${base}/huge`, {
        signal: AbortSignal.timeout(5000),
        app: "Handbook",
      }).catch((caught: unknown) => caught);
      expect(huge).toMatchObject({ kind: "failed", message: "Handbook sent too much data" });
      // A byte order mark before the JSON is fine.
      const marked = await sourceFetch(`${base}/bom`, { signal: AbortSignal.timeout(5000), app: "Handbook" });
      expect(marked).toMatchObject({ ok: true, json: true, data: { items: [] } });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("sends forms and hands back any status", async () => {
    const answer = await sourceFetch(`${app.url}/unauthorized`, {
      signal: AbortSignal.timeout(5000),
      app: "Handbook",
      form: { grant_type: "refresh_token", refresh_token: "rt_1" },
    });
    expect(answer).toMatchObject({ status: 401, ok: false, json: true });
    expect(app.requests.at(-1)).toMatchObject({
      method: "POST",
      body: "grant_type=refresh_token&refresh_token=rt_1",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
  });
});
