import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for a connected app (Handbook, CRM) on a free local port.
 * `handle` gets method, path with query, headers and body and answers with
 * a status and JSON; every request is recorded.
 */
export type FakeRequest = {
  method: string;
  path: string;
  url: URL;
  headers: IncomingMessage["headers"];
  body: string;
};
export type FakeAnswer = {
  status?: number;
  json?: unknown;
  delayMs?: number;
  headers?: Record<string, string>;
};

export type FakeApp = {
  url: string;
  requests: FakeRequest[];
  close(): Promise<void>;
};

export async function startFakeApp(
  handle: (request: FakeRequest) => FakeAnswer | Promise<FakeAnswer>,
): Promise<FakeApp> {
  const requests: FakeRequest[] = [];
  let base = "";
  const server: Server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const url = new URL(incoming.url ?? "/", base);
      const request: FakeRequest = {
        method: incoming.method ?? "GET",
        path: url.pathname,
        url,
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(request);
      void Promise.resolve(handle(request)).then(async (answer) => {
        if (answer.delayMs) await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
        if (outgoing.destroyed) return;
        outgoing.writeHead(answer.status ?? 200, { "content-type": "application/json", ...answer.headers });
        outgoing.end(answer.json === undefined ? "" : JSON.stringify(answer.json));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The bearer token of a recorded request. */
export const bearerOf = (request: FakeRequest) =>
  /^Bearer (.+)$/.exec(String(request.headers.authorization ?? ""))?.[1] ?? null;
