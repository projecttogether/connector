import { afterEach, describe, expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";
import pg from "pg";
import { ConfigError } from "../config";
import { runCli } from "./main";
import { sources } from "./sources";

const SECRET = "kn_svc_secret-query-parameter-3e8a";

async function list() {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["settings", "list"], {
    readStdin: async () => "",
    out: (text) => void (stdout += text),
    err: (text) => void (stderr += text),
  });
  return { code, stdout, stderr };
}

afterEach(() => vi.restoreAllMocks());

describe("a database error", () => {
  it("prints the page's generic message, never the query's values", async () => {
    const cause = Object.assign(new pg.DatabaseError(`value "${SECRET}" is too long`, 0, "error"), {
      code: "22001",
    });
    vi.spyOn(sources, "rows").mockRejectedValue(
      new DrizzleQueryError("update sources set secret_encrypted = $1", [SECRET], cause),
    );
    expect(await list()).toEqual({
      code: 1,
      stdout: "",
      stderr: "Something went wrong. Try again. (database error 22001)\n",
    });

    vi.spyOn(sources, "rows").mockRejectedValue(cause);
    expect((await list()).stderr).toBe("Something went wrong. Try again. (database error 22001)\n");
  });

  it("says that someone else changed the setting at the same time", async () => {
    const cause = Object.assign(new pg.DatabaseError("deadlock detected", 0, "error"), { code: "40P01" });
    vi.spyOn(sources, "rows").mockRejectedValue(cause);
    expect(await list()).toEqual({
      code: 1,
      stdout: "",
      stderr: "Someone else changed this at the same time. Try again.\n",
    });
  });
});

describe("an unexpected error", () => {
  it("prints the page's generic message with its code, never its text", async () => {
    vi.spyOn(sources, "rows").mockRejectedValue(
      new DrizzleQueryError(
        "select 1",
        [SECRET],
        Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), { code: "ECONNREFUSED" }),
      ),
    );
    expect(await list()).toEqual({
      code: 1,
      stdout: "",
      stderr: "Something went wrong. Try again. (ECONNREFUSED)\n",
    });
    vi.spyOn(sources, "rows").mockRejectedValue(new TypeError(`Invalid header value "Bearer ${SECRET}"`));
    expect((await list()).stderr).toBe("Something went wrong. Try again.\n");
  });

  it("names the variables of an invalid configuration", async () => {
    const message = "Invalid configuration:\n  AUTH_SECRET: Too small";
    vi.spyOn(sources, "rows").mockRejectedValue(new ConfigError(message));
    expect((await list()).stderr).toBe(`${message}\n`);
  });
});
