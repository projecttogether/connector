import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { DrizzleQueryError } from "drizzle-orm";
import pg from "pg";
import type { AppEnv } from "./env";
import { concurrentChangeResponse } from "./app";
import { getPool } from "../db/client";
import { createToken, createUser, request, resetDatabase } from "../test/helpers";
import { resetConfigForTests } from "../config";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

/** A failed query as Drizzle reports it, with a PostgreSQL error of `code`. */
function failedQuery(code: string) {
  const error = new pg.DatabaseError('constraint "uq_secret_name" on (value)=(private)', 0, "error");
  error.code = code;
  error.constraint = "uq_secret_name";
  return new DrizzleQueryError("update sources set name = $1", ["private"], error);
}

describe("error responses", () => {
  beforeEach(resetDatabase);

  it("answer a create of a name another request took at the same time with 409", async () => {
    const admin = await createUser({ isAdmin: true });
    // Another request creates the group and has not committed yet.
    const other = await getPool().connect();
    try {
      await other.query("begin");
      await other.query("insert into groups (name, source) values ('Programs', 'app')");
      const pending = request("POST", "/api/v1/admin/groups", {
        userId: admin.id,
        body: { name: "Programs" },
      });
      // Its insert waits for the other transaction, which then commits.
      for (let waiting = 0; waiting === 0;) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const result = await getPool().query<{ count: number }>(
          "select count(*)::int as count from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()",
        );
        waiting = result.rows[0]!.count;
      }
      await other.query("commit");
      const response = await pending;
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("concurrent_change");
    } finally {
      other.release();
    }
  });

  it("answer deadlocks and serialization failures with 409, without database details", async () => {
    for (const code of ["23505", "40P01", "40001"]) {
      const app = new Hono<AppEnv>();
      app.onError((error, c) => concurrentChangeResponse(error, c) ?? c.text("Other error", 500));
      app.get("/", () => {
        throw failedQuery(code);
      });
      const response = await app.request("/");
      expect(response.status).toBe(409);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({
        error: {
          code: "concurrent_change",
          message: "Someone else changed this at the same time. Try again.",
        },
      });
      expect(text).not.toMatch(/uq_secret_name|private|sources/);
    }
    const app = new Hono<AppEnv>();
    app.onError((error, c) => concurrentChangeResponse(error, c) ?? c.text("Other error", 500));
    app.get("/", () => {
      throw failedQuery("23503");
    });
    expect((await app.request("/")).status).toBe(500);
  });
});

describe("GET /api/v1/about", () => {
  beforeEach(resetDatabase);

  it("names the version that runs to people in the web app, not to agents", async () => {
    const person = await createUser();
    process.env.APP_VERSION = "0123456789ab";
    resetConfigForTests();
    try {
      const response = await request("GET", "/api/v1/about", { userId: person.id });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ version: "0123456789ab" });
      const agent = await createToken(person.id);
      expect((await request("GET", "/api/v1/about", { token: agent })).status).toBe(403);
      expect((await request("GET", "/api/v1/about")).status).toBe(401);
    } finally {
      delete process.env.APP_VERSION;
      resetConfigForTests();
    }
    expect((await request("GET", "/api/v1/about", { userId: person.id })).body).toEqual({ version: null });
  });
});
