import { tokenCreateSchema } from "@connector/shared/api/tokens";
import { SOURCE_KIND_INFO } from "@connector/shared/sources";
import {
  ADMIN_TOKEN_KINDS,
  createAdminToken,
  listAdminTokens,
  revokeAdminToken,
  type AdminTokenKind,
} from "../auth/admin-tokens";
import { operator } from "../auth/principal";
import { config } from "../config";
import { getDb } from "../db/client";
import { notFound, parseWith } from "../http/errors";
import { getSource, kindOf, rotateWebhookSecret, webhookUrl } from "../sources/service";
import { UsageError, type CliIo } from "./io";
import { entryId, json, parse, printRows } from "./settings";

/*
 * `cli tokens …`: service tokens (bots), SCIM tokens (identity systems) and
 * the webhook secrets of sources, as the admin pages create them. A new one
 * goes to stdout alone, once, so that `> file` keeps only the token; notes
 * go to stderr.
 */

const KINDS = [...ADMIN_TOKEN_KINDS, "webhook-secret"] as const;

const CREATE_USAGE =
  "cli tokens create service|scim --name <name> [--expires-in-days <days>|never]\n" +
  "       cli tokens create webhook-secret --source <id>";

const isAdminTokenKind = (kind: string): kind is AdminTokenKind =>
  (ADMIN_TOKEN_KINDS as readonly string[]).includes(kind);

const day = (value: string | null) => value?.slice(0, 10) ?? "never";

async function createToken(kind: AdminTokenKind, args: string[], io: CliIo) {
  const usage = `cli tokens create ${kind} --name <name> [--expires-in-days <days>|never]`;
  const values = parse(args, { name: { type: "string" }, "expires-in-days": { type: "string" } }, usage);
  if (values.name === undefined) throw new UsageError("Name the token with --name, e.g. its bot.", usage);
  const days = values["expires-in-days"];
  if (days !== undefined && days !== "never" && !/^\d{1,9}$/.test(String(days))) {
    throw new UsageError("--expires-in-days takes a number of days or never.", usage);
  }
  const input = parseWith(tokenCreateSchema, {
    name: values.name,
    // Left out: the API's default.
    ...(days === undefined ? {} : { expiresInDays: days === "never" ? null : Number(days) }),
  });
  const created = await createAdminToken(getDb(), operator(`cli tokens create ${kind}`), kind, input);
  io.out(`${created.secret}\n`);
  const where =
    kind === "scim"
      ? `SCIM base URL: ${config().scimUrl}`
      : `Search URL for bots: ${config().APP_URL}/api/v1/knowledge/search`;
  io.err(`Created ${created.name}. ID: ${created.id}, expires: ${day(created.expiresAt)}. ${where}\n`);
}

/** A new webhook secret, as the guide's and the Sources page's button make it. */
async function createWebhookSecret(args: string[], io: CliIo) {
  const usage = "cli tokens create webhook-secret --source <id>";
  const values = parse(args, { source: { type: "string" } }, usage);
  if (values.source === undefined) {
    throw new UsageError("Name the source with --source (cli settings list shows the IDs).", usage);
  }
  const id = entryId(values.source, usage);
  const db = getDb();
  const source = await getSource(db, id);
  const actor = operator(`cli tokens create webhook-secret --source ${id}`);
  const { webhookSecret } = await rotateWebhookSecret(db, actor, id);
  io.out(`${webhookSecret}\n`);
  io.err(
    `New webhook secret for ${source.name}; it replaces the one before. ` +
      `In ${SOURCE_KIND_INFO[kindOf(source)].label}, set the URL ${webhookUrl(source.slug)} and this secret.\n`,
  );
}

async function list(args: string[], io: CliIo) {
  const values = parse(args, { json: { type: "boolean" } }, "cli tokens list [--json]");
  const tokens = [];
  for (const kind of ADMIN_TOKEN_KINDS) {
    for (const token of await listAdminTokens(getDb(), kind)) tokens.push({ kind, ...token });
  }
  if (values.json) {
    io.out(json(tokens));
    return;
  }
  if (tokens.length === 0) {
    io.out("No service or SCIM tokens.\n");
    return;
  }
  const now = Date.now();
  const rows = tokens.map((token) => ({
    label: `${token.kind} ${token.id}`,
    state: token.expiresAt && Date.parse(token.expiresAt) <= now ? "expired" : "active",
    hints: [
      token.name,
      token.prefix,
      `created ${day(token.createdAt)}${token.createdBy ? ` by ${token.createdBy}` : ""}`,
      `last used ${day(token.lastUsedAt)}`,
      `expires ${day(token.expiresAt)}`,
    ],
  }));
  printRows(rows, io);
}

async function revoke(args: string[], io: CliIo) {
  const usage = "cli tokens revoke <id>";
  const [value, ...rest] = args;
  parse(rest, {}, usage);
  const id = entryId(value, usage);
  const db = getDb();
  for (const kind of ADMIN_TOKEN_KINDS) {
    if (!(await listAdminTokens(db, kind)).some((token) => token.id === id)) continue;
    const { name } = await revokeAdminToken(db, operator(`cli tokens revoke ${id}`), kind, id);
    io.err(`Revoked ${name}.\n`);
    return;
  }
  throw notFound("No such service or SCIM token");
}

/** `cli tokens …`. Returns the exit code. */
export async function tokensCommand(args: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case "create": {
      const [kind, ...optionArgs] = rest;
      if (kind === undefined || kind.startsWith("-")) {
        throw new UsageError(`Name a kind: ${KINDS.join(", ")}.`, CREATE_USAGE);
      }
      if (kind === "webhook-secret") await createWebhookSecret(optionArgs, io);
      else if (isAdminTokenKind(kind)) await createToken(kind, optionArgs, io);
      else throw new UsageError(`Unknown kind. Kinds: ${KINDS.join(", ")}.`, CREATE_USAGE);
      return 0;
    }
    case "list":
      await list(rest, io);
      return 0;
    case "revoke":
      await revoke(rest, io);
      return 0;
    default:
      throw new UsageError(command ? "Unknown command." : "Name a command.", "cli tokens create|list|revoke");
  }
}
