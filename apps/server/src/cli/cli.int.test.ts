import { spawn } from "node:child_process";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptJson } from "../core/crypto";
import { getDb } from "../db/client";
import { auditLog, credentials, sourceLinks, sources } from "../db/schema";
import { logger } from "../logger";
import { SERVER_ROOT } from "../paths";
import { signatureOf } from "../sources/webhooks";
import { bearerOf, startFakeApp, type FakeApp } from "../test/fake-app";
import { createToken, createUser, request, resetDatabase, testApp } from "../test/helpers";
import { runCli } from "./main";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

const HANDBOOK_TOKEN = "kn_svc_right-9f2c";
const WRONG_TOKEN = "kn_svc_wrong-4b7e";
const CRM_KEY = "crm_key_secret-5d1a";
const WEBHOOK_SECRET = "webhook-secret-of-library-8c3f";

/** Values that no output, message or log line may hold. */
let secrets: string[];
/** Everything the command printed in this test, and every log call. */
let printed: string[];

/**
 * Runs `cli <args>` with `stdin` (a JSON value, or text as is). `issues`: stdout
 * hands out a new secret; it must hold nothing else, and no other output may.
 */
async function cli(args: string[], stdin?: unknown, options: { issues?: boolean } = {}) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    readStdin: async () =>
      typeof stdin === "string" ? stdin : stdin === undefined ? "" : JSON.stringify(stdin),
    out: (text) => void (stdout += text),
    err: (text) => void (stderr += text),
  });
  printed.push(stderr);
  if (options.issues) {
    expect(stdout).toMatch(/^\S{20,}\n$/);
    secrets.push(stdout.trim());
  } else printed.push(stdout);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) as Record<string, unknown> };
}

async function auditEntries(action: string) {
  return getDb().select().from(auditLog).where(eq(auditLog.action, action)).orderBy(asc(auditLog.createdAt));
}

const NO_ID = "00000000-0000-4000-8000-000000000000";

let handbook: FakeApp;

beforeAll(async () => {
  handbook = await startFakeApp((req) => {
    // An app that repeats the token it got.
    if (bearerOf(req) !== HANDBOOK_TOKEN)
      return { status: 401, json: { error: { message: `Unknown token ${bearerOf(req)}` } } };
    if (req.path === "/api/v1/spaces") {
      return { json: { items: [{ slug: "it", name: "IT" }, { slug: "policies" }] } };
    }
    return { status: 404, json: {} };
  });
});
afterAll(() => handbook.close());

beforeEach(async () => {
  await resetDatabase();
  printed = [];
  secrets = [HANDBOOK_TOKEN, WRONG_TOKEN, CRM_KEY, WEBHOOK_SECRET];
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      printed.push(JSON.stringify(args));
    });
  }
});

afterEach(() => {
  for (const text of printed) for (const secret of secrets) expect(text).not.toContain(secret);
  vi.restoreAllMocks();
});

const handbookBody = () => ({
  kind: "handbook",
  slug: "handbook",
  name: "Handbook",
  config: { baseUrl: `${handbook.url}/`, ruleSpaces: ["policies"] },
  secret: { serviceToken: WRONG_TOKEN },
});

const logbookBody = {
  kind: "logbook",
  slug: "logbook",
  name: "Logbook",
  config: { baseUrl: "https://logbook.example.org" },
};

describe("cli settings … sources", () => {
  it("connects, shows, tests, changes and removes a Handbook, with the page's checks", async () => {
    expect((await cli(["settings", "list"])).stdout).toBe("sources  not set     no sources\n");
    expect(await cli(["settings", "apply", "sources"], { ...handbookBody(), slug: "H" })).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "Check the highlighted fields\n  slug: Use at least 2 characters\n",
    });
    // A token with a line break is refused without repeating it.
    expect(
      await cli(["settings", "apply", "sources"], {
        ...handbookBody(),
        secret: { serviceToken: `${WRONG_TOKEN}\nnext` },
      }),
    ).toMatchObject({
      code: 1,
      stderr:
        "Check the highlighted fields\n  secret.serviceToken: Paste the token without spaces or line breaks\n",
    });
    expect(await cli(["settings", "apply", "sources"], [])).toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/^Check the highlighted fields\n {2}body: /),
    });
    expect(await getDb().select().from(sources)).toHaveLength(0);

    const added = await cli(["settings", "apply", "sources"], handbookBody());
    expect(added.code).toBe(0);
    const id = added.json().id as string;
    expect(added.stderr).toBe(`Connected the source Handbook. ID: ${id}\n`);
    expect(added.json()).toMatchObject({
      kind: "handbook",
      enabled: true,
      accessGroups: [],
      serviceAccess: false,
      config: { baseUrl: handbook.url, ruleSpaces: ["policies"], allowLinking: true },
      secrets: { serviceToken: "…4b7e" },
    });
    const [row] = await getDb().select().from(sources).where(eq(sources.id, id));
    expect(row!.secretEncrypted).toMatch(/^v1:/);
    expect(row!.secretEncrypted).not.toContain(WRONG_TOKEN);
    expect(decryptJson(row!.secretEncrypted)).toEqual({ serviceToken: WRONG_TOKEN });
    expect((await cli(["settings", "show", "sources", "--id", id])).stdout).toBe(added.stdout);
    expect((await cli(["settings", "show", "sources"])).json()).toEqual({ items: [added.json()] });
    expect((await cli(["settings", "list"])).stdout).toBe(
      `sources --id ${id}  set         Handbook "Handbook" (handbook); ${handbook.url}; everyone signed in; service token …4b7e\n`,
    );
    expect((await auditEntries("source.create"))[0]).toMatchObject({
      actorUserId: null,
      actorEmail: "operator",
      entityId: id,
      summary: "Connected the source “Handbook” (Handbook) (cli settings apply sources)",
    });
    // The page's refusal of a second source with the slug.
    expect(await cli(["settings", "apply", "sources"], handbookBody())).toMatchObject({
      code: 1,
      stderr: "Another source has this slug\n  slug: Another source has this slug\n",
    });

    const failed = await cli(["settings", "test", "sources", "--id", id]);
    expect(failed.code).toBe(1);
    expect(failed.json()).toEqual({
      ok: false,
      message: "Handbook refused the credentials: Unknown token …",
    });
    expect(failed.stderr).toBe("Handbook refused the credentials: Unknown token …\n");
    expect(await cli(["settings", "show", "sources", "--id", id, "--spaces"])).toMatchObject({
      code: 1,
      stderr: "Handbook refused the credentials: Unknown token …\n",
    });

    const changed = await cli(["settings", "apply", "sources", "--id", id], {
      secret: { serviceToken: HANDBOOK_TOKEN },
      accessGroups: ["/staff"],
      serviceAccess: true,
    });
    expect(changed).toMatchObject({ code: 0, stderr: "" });
    expect(changed.json()).toMatchObject({ secrets: { serviceToken: "…9f2c" }, accessGroups: ["/staff"] });
    expect((await auditEntries("source.update"))[0]!.summary).toBe(
      `Source “Handbook”: open to /staff; opened to service tokens; replaced serviceToken (cli settings apply sources --id ${id})`,
    );
    const tested = await cli(["settings", "test", "sources", "--id", id]);
    expect(tested).toMatchObject({ code: 0, stderr: "" });
    expect(tested.json()).toEqual({ ok: true, message: "Reached Handbook: 2 spaces" });
    expect((await cli(["settings", "show", "sources", "--id", id, "--spaces"])).json()).toEqual({
      items: [
        { slug: "it", name: "IT" },
        { slug: "policies", name: "policies" },
      ],
    });
    expect((await cli(["settings", "list"])).stdout).toContain(
      `${handbook.url}; groups /staff; open to service tokens; service token …9f2c; status ok 20`,
    );

    // A blank or missing secret keeps the saved one; turning it off shows.
    await cli(["settings", "apply", "sources", "--id", id], { secret: { serviceToken: "" } });
    const off = await cli(["settings", "apply", "sources", "--id", id], { enabled: false });
    expect(off.json()).toMatchObject({ enabled: false, secrets: { serviceToken: "…9f2c" } });
    expect((await cli(["settings", "list"])).stdout).toContain("; off; service token …9f2c");
    expect(await cli(["settings", "apply", "sources", "--id", id], { config: { baseUrl: "x" } })).toEqual(
      expect.objectContaining({
        code: 1,
        stdout: "",
        stderr:
          "Check the highlighted fields\n  config.baseUrl: Enter the app's address, e.g. https://handbook.example.org\n",
      }),
    );

    // Another address: the credentials and linked accounts of the old one go.
    const ada = await createUser();
    await getDb().insert(sourceLinks).values({ sourceId: id, userId: ada.id, tokensEncrypted: "v1:x" });
    const moved = await cli(["settings", "apply", "sources", "--id", id], {
      config: { baseUrl: "https://handbook.example.net", ruleSpaces: [] },
    });
    expect(moved.json()).toMatchObject({ secrets: {}, status: null });
    expect(await getDb().select().from(sourceLinks)).toHaveLength(0);
    expect((await cli(["settings", "list", "--json"])).json()).toEqual([
      {
        name: "sources",
        id,
        state: "incomplete",
        hints: [
          'Handbook "Handbook" (handbook)',
          "https://handbook.example.net",
          "groups /staff",
          "open to service tokens",
          "off",
          "no service token",
        ],
      },
    ]);

    const removed = await cli(["settings", "remove", "sources", "--id", id]);
    expect(removed).toMatchObject({
      code: 0,
      stdout: "",
      stderr: "Removed the source Handbook and everything Connector kept of it.\n",
    });
    expect(await getDb().select().from(sources)).toHaveLength(0);
    expect((await auditEntries("source.delete"))[0]).toMatchObject({
      actorEmail: "operator",
      summary: `Removed the source “Handbook” and everything Connector kept of it (cli settings remove sources --id ${id})`,
    });
    for (const command of ["show", "test", "remove"]) {
      expect(await cli(["settings", command, "sources", "--id", id])).toMatchObject({
        code: 1,
        stdout: "",
        stderr: "No such source\n",
      });
    }
    expect(await cli(["settings", "apply", "sources", "--id", NO_ID], {})).toMatchObject({
      code: 1,
      stderr: "No such source\n",
    });
  });

  it("connects a CRM with its API key", async () => {
    const added = await cli(["settings", "apply", "sources"], {
      kind: "crm",
      slug: "crm",
      name: "CRM",
      config: { baseUrl: "https://crm.example.org", types: ["contact"] },
      secret: { apiKey: CRM_KEY },
    });
    expect(added.json()).toMatchObject({ kind: "crm", secrets: { apiKey: "…5d1a" } });
    const [row] = await getDb().select().from(sources);
    expect(row!.secretEncrypted).not.toContain(CRM_KEY);
    expect((await cli(["settings", "list"])).stdout).toContain(
      'set         CRM "CRM" (crm); https://crm.example.org; everyone signed in; API key …5d1a\n',
    );
    expect(await cli(["settings", "show", "sources", "--id", row!.id, "--spaces"])).toMatchObject({
      code: 1,
      stderr: "Only Handbook sources have spaces\n",
    });
  });

  it("records every change, also one field alone, and nothing when nothing changes", async () => {
    const added = await cli(["settings", "apply", "sources"], logbookBody);
    const id = added.json().id as string;
    await cli(["settings", "apply", "sources", "--id", id], { description: "What happened" });
    await cli(["settings", "apply", "sources", "--id", id], { position: 3 });
    await cli(["settings", "apply", "sources", "--id", id], { description: "What happened", position: 3 });
    expect((await auditEntries("source.update")).map((entry) => entry.summary)).toEqual([
      `Source “Logbook”: changed its description (cli settings apply sources --id ${id})`,
      `Source “Logbook”: changed its place in the list (cli settings apply sources --id ${id})`,
    ]);
  });

  it("takes a webhook secret of the app's own", async () => {
    const added = await cli(["settings", "apply", "sources"], {
      kind: "library",
      slug: "library",
      name: "Library",
      config: { baseUrl: "https://library.example.org" },
      secret: { webhookSecret: WEBHOOK_SECRET },
    });
    expect(added.stderr).not.toContain("webhook-secret");
    expect(added.json()).toMatchObject({ secrets: { webhookSecret: "…8c3f" } });
  });
});

describe("cli tokens create webhook-secret", () => {
  it("hands out a new webhook secret once, and deliveries signed with it arrive", async () => {
    const added = await cli(["settings", "apply", "sources"], logbookBody);
    const id = added.json().id as string;
    expect(added.stderr).toBe(
      `Connected the source Logbook. ID: ${id}\n` +
        `Next: (umask 077; set -C; docker compose exec -T web cli tokens create webhook-secret --source ${id} > secret.txt), then the secret and the URL http://localhost:3000/hooks/logbook in Logbook.\n`,
    );
    expect((await cli(["settings", "list"])).stdout).toBe(
      `sources --id ${id}  incomplete  Logbook "Logbook" (logbook); https://logbook.example.org; everyone signed in; no webhook secret; webhook http://localhost:3000/hooks/logbook; no delivery yet\n`,
    );
    expect(await cli(["settings", "test", "sources", "--id", id])).toMatchObject({ code: 1 });

    const issued = await cli(["tokens", "create", "webhook-secret", "--source", id], undefined, {
      issues: true,
    });
    expect(issued.code).toBe(0);
    const secret = issued.stdout.trim();
    expect(issued.stderr).toBe(
      "New webhook secret for Logbook; it replaces the one before. " +
        "In Logbook, set the URL http://localhost:3000/hooks/logbook and this secret.\n",
    );
    const [row] = await getDb().select().from(sources).where(eq(sources.id, id));
    expect(row!.secretEncrypted).not.toContain(secret);
    expect(decryptJson(row!.secretEncrypted)).toEqual({ webhookSecret: secret });
    expect((await cli(["settings", "show", "sources", "--id", id])).json()).toMatchObject({
      secrets: { webhookSecret: `…${secret.slice(-4)}` },
    });
    expect((await cli(["settings", "list"])).stdout).toContain(
      `  set         Logbook "Logbook" (logbook); https://logbook.example.org; everyone signed in; webhook secret …${secret.slice(-4)};`,
    );
    expect((await auditEntries("source.webhook_secret"))[0]).toMatchObject({
      actorEmail: "operator",
      entityId: id,
      summary: `New webhook secret for the source “Logbook” (cli tokens create webhook-secret --source ${id})`,
    });

    const body = JSON.stringify({ event: "entry.changed", entry: {} });
    const deliver = async (key: string) => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const response = await testApp().request("/hooks/logbook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Logbook-Timestamp": timestamp,
          "Logbook-Signature": signatureOf(key, timestamp, body),
        },
        body,
      });
      return response.status;
    };
    // 400: the signature counts, the payload is no entry.
    expect(await deliver("not-the-secret")).toBe(401);
    expect(await deliver(secret)).toBe(400);
    const next = await cli(["tokens", "create", "webhook-secret", "--source", id], undefined, {
      issues: true,
    });
    expect(await deliver(secret)).toBe(401);
    expect(await deliver(next.stdout.trim())).toBe(400);
  });

  it("refuses sources without a webhook, with the page's message", async () => {
    const added = await cli(["settings", "apply", "sources"], handbookBody());
    expect(
      await cli(["tokens", "create", "webhook-secret", "--source", added.json().id as string]),
    ).toMatchObject({ code: 1, stdout: "", stderr: "Only webhook sources have a webhook secret\n" });
    expect(await cli(["tokens", "create", "webhook-secret", "--source", NO_ID])).toMatchObject({
      code: 1,
      stderr: "No such source\n",
    });
    expect((await cli(["tokens", "create", "webhook-secret"])).code).toBe(2);
  });
});

describe("cli tokens", () => {
  it("creates service tokens, alone on stdout, lists and revokes them", async () => {
    expect((await cli(["tokens", "list"])).stdout).toBe("No service or SCIM tokens.\n");
    const issued = await cli(
      ["tokens", "create", "service", "--name", "Support bot", "--expires-in-days", "365"],
      undefined,
      { issues: true },
    );
    expect(issued.code).toBe(0);
    const token = issued.stdout.trim();
    expect(token).toMatch(/^cn_svc_/);
    const [row] = await getDb().select().from(credentials);
    const expires = row!.expiresAt!.toISOString().slice(0, 10);
    expect(issued.stderr).toBe(
      `Created Support bot. ID: ${row!.id}, expires: ${expires}. ` +
        "Search URL for bots: http://localhost:3000/api/v1/knowledge/search\n",
    );
    expect(row).toMatchObject({ kind: "service", name: "Support bot", createdById: null });
    expect(row!.tokenHash).not.toContain(token);
    expect(Math.round((row!.expiresAt!.getTime() - Date.now()) / 86_400_000)).toBe(365);
    expect((await request("GET", "/api/v1/sources", { token })).status).toBe(200);
    // Nobody's token reaches the admin pages, also one the operator made.
    expect((await request("GET", "/api/v1/admin/sources", { token })).status).toBe(403);
    expect((await auditEntries("service_token.create"))[0]).toMatchObject({
      actorUserId: null,
      actorEmail: "operator",
      entityId: row!.id,
      summary: "Created the service token “Support bot” (cli tokens create service)",
    });

    const listed = await cli(["tokens", "list"]);
    expect(listed.stdout).toMatch(
      new RegExp(
        `^service ${row!.id} {2}active {6}Support bot; cn_svc_.{4}…; created \\d{4}-\\d\\d-\\d\\d by Operator; last used \\d{4}-\\d\\d-\\d\\d; expires ${expires}\n$`,
      ),
    );
    expect((await cli(["tokens", "list", "--json"])).json()).toEqual([
      expect.objectContaining({ kind: "service", id: row!.id, createdBy: "Operator" }),
    ]);

    expect(await cli(["tokens", "revoke", row!.id])).toMatchObject({
      code: 0,
      stdout: "",
      stderr: "Revoked Support bot.\n",
    });
    expect((await request("GET", "/api/v1/sources", { token })).status).toBe(401);
    expect((await auditEntries("service_token.revoke"))[0]).toMatchObject({
      actorEmail: "operator",
      summary: `Revoked the service token “Support bot” (cli tokens revoke ${row!.id})`,
    });
    expect(await cli(["tokens", "revoke", row!.id])).toMatchObject({
      code: 1,
      stderr: "No such service or SCIM token\n",
    });
  });

  it("creates SCIM tokens that work at /scim/v2", async () => {
    const issued = await cli(
      ["tokens", "create", "scim", "--name", "IAM", "--expires-in-days", "never"],
      undefined,
      { issues: true },
    );
    const token = issued.stdout.trim();
    expect(token).toMatch(/^cn_scim_/);
    expect(issued.stderr).toContain("expires: never. SCIM base URL: http://localhost:3000/scim/v2\n");
    expect((await request("GET", "/scim/v2/Users", { token })).status).toBe(200);
    expect((await auditEntries("scim_token.create"))[0]).toMatchObject({ actorEmail: "operator" });
    const [row] = await getDb().select().from(credentials);
    expect((await cli(["tokens", "list"])).stdout).toContain(`scim ${row!.id}  active      IAM; `);
    expect((await cli(["tokens", "revoke", row!.id])).code).toBe(0);
    expect((await request("GET", "/scim/v2/Users", { token })).status).toBe(401);
  });

  it("refuses with the page's checks, and ends no personal token", async () => {
    expect(await cli(["tokens", "create", "service", "--name", " "])).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "Check the highlighted fields\n  name: Add a name, e.g. the agent that uses it\n",
    });
    expect(
      await cli(["tokens", "create", "service", "--name", "Bot", "--expires-in-days", "0"]),
    ).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("  expiresInDays: "),
    });
    expect(await getDb().select().from(credentials)).toHaveLength(0);
    const ada = await createUser();
    secrets.push(await createToken(ada.id));
    const [personal] = await getDb().select().from(credentials);
    expect(await cli(["tokens", "revoke", personal!.id])).toMatchObject({ code: 1 });
    expect((await getDb().select().from(credentials))[0]!.revokedAt).toBeNull();
  });
});

describe("cli usage", () => {
  it("prints help with the commands, setting names and token kinds", async () => {
    const help = await cli(["help"]);
    expect(help.code).toBe(0);
    for (const text of [
      "cli settings list",
      "cli settings apply sources",
      "cli settings test sources --id <id>",
      "cli settings remove sources --id <id>",
      "(umask 077; set -C; docker compose exec -T web cli tokens create <kind> … > token.txt)",
      "cli tokens create service",
      "cli tokens create scim",
      "cli tokens create webhook-secret --source <id>",
      "deployment.md",
    ]) {
      expect(help.stdout).toContain(text);
    }
    expect(await cli([])).toMatchObject({ code: 2, stdout: "", stderr: help.stdout });
  });

  it("answers 2 for wrong commands and never repeats what was typed", async () => {
    const wrong = [
      ["status"],
      ["settings"],
      ["settings", "rename", "sources"],
      ["settings", "show"],
      ["settings", "show", "email"],
      ["settings", "show", "sources", "--spaces"],
      ["settings", "show", "sources", "--id", HANDBOOK_TOKEN],
      ["settings", "remove", "sources"],
      ["settings", "test", "sources"],
      ["settings", "apply", "sources", HANDBOOK_TOKEN],
      ["settings", "apply", "sources", `--serviceToken=${HANDBOOK_TOKEN}`],
      ["settings", "apply", "sources", `-${HANDBOOK_TOKEN}`],
      ["settings", "list", "--json=yes"],
      ["tokens"],
      ["tokens", "create"],
      ["tokens", "create", HANDBOOK_TOKEN],
      ["tokens", "create", "service"],
      ["tokens", "create", "service", "--name", "Bot", "--expires-in-days", HANDBOOK_TOKEN],
      ["tokens", "create", "webhook-secret", "--source", WEBHOOK_SECRET],
      ["tokens", "revoke"],
      ["tokens", "revoke", HANDBOOK_TOKEN],
      ["help", "settings"],
      ["--help", `--token=${HANDBOOK_TOKEN}`],
    ];
    for (const args of wrong) {
      const result = await cli(args);
      expect({ args, code: result.code, stdout: result.stdout }).toEqual({ args, code: 2, stdout: "" });
      expect(result.stderr).toContain('Run "cli help" for the commands.');
    }
    for (const body of ["", `serviceToken=${HANDBOOK_TOKEN}`, `{"secret":"${HANDBOOK_TOKEN}"`]) {
      expect(await cli(["settings", "apply", "sources"], body)).toMatchObject({
        code: 2,
        stderr: expect.stringContaining("The body on stdin is not JSON."),
      });
    }
    expect(await getDb().select().from(sources)).toHaveLength(0);
    expect(await getDb().select().from(auditLog)).toHaveLength(0);
  });
});

describe("the admin pages and the command", () => {
  it("run the same code: the page acts as the signed-in admin", async () => {
    const admin = await createUser({ email: "ada@example.org", isAdmin: true });
    const saved = await request("POST", "/api/v1/admin/sources", {
      userId: admin.id,
      body: handbookBody(),
    });
    expect(saved.status).toBe(201);
    expect((await cli(["settings", "show", "sources", "--id", saved.body.id])).json()).toEqual(saved.body);
    expect((await auditEntries("source.create"))[0]).toMatchObject({
      actorUserId: admin.id,
      actorEmail: "ada@example.org",
      summary: "Connected the source “Handbook” (Handbook)",
    });
    const read = await request("GET", `/api/v1/admin/sources/${saved.body.id}/spaces`, { userId: admin.id });
    expect(read.status).toBe(409);
    expect(read.body.error.message).toBe("Handbook refused the credentials: Unknown token …");
  });

  it("show the operator and the whole command in the audit log, after a long summary too", async () => {
    const added = await cli(["settings", "apply", "sources"], logbookBody);
    const id = added.json().id as string;
    const groups = Array.from({ length: 10 }, (_, index) => `/${"a".repeat(100)}${index}`);
    expect((await cli(["settings", "apply", "sources", "--id", id], { accessGroups: groups })).code).toBe(0);
    const admin = await createUser({ isAdmin: true });
    const log = await request("GET", "/api/v1/admin/audit", { userId: admin.id });
    const entry = log.body.items[0] as { actorEmail: string; summary: string };
    expect(entry.actorEmail).toBe("operator");
    expect(entry.summary).toHaveLength(500);
    expect(entry.summary.endsWith(` (cli settings apply sources --id ${id})`)).toBe(true);
  });
});

/** Runs the command in a process of its own, as the image does. `readAfterMs`: a reader that starts late. */
function runProcess(
  args: string[],
  options: { stdin?: string; env?: Record<string, string>; readAfterMs?: number } = {},
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(SERVER_ROOT, "src/cli.ts"), ...args],
      {
        cwd: SERVER_ROOT,
        env: { ...process.env, LOG_LEVEL: "debug", ...options.env },
        timeout: 20_000,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    if (options.readAfterMs) {
      child.stdout.pause();
      setTimeout(() => child.stdout.resume(), options.readAfterMs);
    }
    child.on("error", reject);
    // The command stops reading a body over the limit.
    child.stdin.on("error", () => undefined);
    child.on("close", (code) => {
      printed.push(stdout, stderr);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.stdin ?? "");
  });
}

describe("the cli process", () => {
  it("reads the body from stdin, keeps stdout for its output, logs to stderr and exits", async () => {
    const applied = await runProcess(["settings", "apply", "sources"], {
      // With the byte order mark an editor may write.
      stdin: `\uFEFF${JSON.stringify(handbookBody())}`,
    });
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({ slug: "handbook" });
    const listed = await runProcess(["settings", "list", "--json"]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toHaveLength(1);
    const refused = await runProcess(["settings", "apply", "sources"], { stdin: "{}" });
    expect(refused).toMatchObject({ code: 1, stdout: "" });
    expect(refused.stderr).toContain("kind:");
    const tooLarge = await runProcess(["settings", "apply", "sources"], {
      stdin: `"${"x".repeat(600 * 1024)}"`,
    });
    expect(tooLarge).toMatchObject({ code: 1, stdout: "", stderr: "The body is larger than 512 KiB\n" });
    const unreachable = await runProcess(["settings", "list"], {
      env: { DATABASE_URL: "postgres://connector:connector@127.0.0.1:9/connector" },
    });
    expect(unreachable).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "Something went wrong. Try again. (ECONNREFUSED)\n",
    });
    // Also an error while the modules load (the logger refuses the level) shows no value.
    expect(await runProcess(["settings", "list"], { env: { LOG_LEVEL: CRM_KEY } })).toEqual({
      code: 1,
      stdout: "",
      stderr: "Something went wrong. Try again.\n",
    });
  });

  it("writes all of a long output to a slow reader before it exits", async () => {
    await getDb()
      .insert(sources)
      .values(
        Array.from({ length: 1000 }, (_, index) => ({
          kind: "crm",
          slug: `crm-${index}`,
          name: `CRM ${index}`,
          config: { baseUrl: "https://crm.example.org", types: ["contact"] },
        })),
      );
    const shown = await runProcess(["settings", "show", "sources"], { readAfterMs: 1000 });
    expect(shown.code).toBe(0);
    expect(shown.stdout.length).toBeGreaterThan(200_000);
    expect((JSON.parse(shown.stdout) as { items: unknown[] }).items).toHaveLength(1000);
  });
});
