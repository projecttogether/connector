import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { operator, type Actor } from "../auth/principal";
import { UsageError, type CliIo } from "./io";

/** One line of `cli settings list`: an entry of a setting with its ID, or a setting without entries. */
export type SettingRow = {
  name: string;
  id?: string;
  state: "set" | "not set" | "incomplete";
  /** What the admin page shows at a glance: addresses, `API key …a1b2`. Never a secret. */
  hints: string[];
};

export type OptionValues = Record<string, string | boolean | undefined>;

/**
 * One setting of the admin pages for `cli settings`, a list of entries with
 * IDs. It calls the same functions as the page's routes and adds no checks
 * of its own.
 */
export type Setting = {
  /** Kebab-case, as on the admin page. */
  name: string;
  /** One line for `cli help`. */
  label: string;
  rows(): Promise<SettingRow[]>;
  /** What the admin API's read answers: hints, never a secret. Without `id`: every entry. */
  show(id: string | undefined, options: OptionValues): Promise<unknown>;
  /** Options of `show` beyond `--id`, with the command's syntax. */
  showOptions: { options: ParseArgsOptionsConfig; usage: string };
  /** Saves the body the admin page sends; answers what `show` answers. Without `id`: a new entry. */
  apply(actor: Actor, body: unknown, id: string | undefined): Promise<{ json: unknown; note?: string }>;
  /** Removes an entry; answers the message for stderr. */
  remove(actor: Actor, id: string): Promise<string>;
  /** What the page's test button does. */
  test(id: string): Promise<{ ok: boolean; message: string }>;
};

const USAGE = "cli settings list|show|apply|remove|test <name> [--id <id>]";

export const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** The options of a command. Messages never repeat what was typed: it could be a secret. */
export function parse(args: string[], options: ParseArgsOptionsConfig, usage: string): OptionValues {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args, options, strict: true, allowPositionals: true });
  } catch (error) {
    const known = (error as { code?: unknown }).code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE";
    throw new UsageError(known ? `${(error as Error).message}.` : "Unknown option.", usage);
  }
  if (parsed.positionals.length > 0) {
    throw new UsageError("Too many arguments. A body goes on stdin, never in an argument.", usage);
  }
  return parsed.values as OptionValues;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An ID as the lists show it (a UUID). The message does not repeat it. */
export function entryId(value: string | boolean | undefined, usage: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new UsageError("The ID is a UUID, as the list shows it.", usage);
  }
  return value.toLowerCase();
}

/** The JSON body on stdin. The parser's message quotes the body, so it is not printed. */
async function readJsonBody(io: CliIo, usage: string): Promise<unknown> {
  const text = await io.readStdin();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UsageError("The body on stdin is not JSON.", usage);
  }
}

/** Aligned lines: a label, a state and hints. */
export function printRows(rows: { label: string; state: string; hints: string[] }[], io: CliIo) {
  const width = Math.max(...rows.map((row) => row.label.length));
  for (const row of rows) {
    io.out(`${row.label.padEnd(width)}  ${row.state.padEnd(10)}  ${row.hints.join("; ")}`.trimEnd() + "\n");
  }
}

/**
 * `cli settings …`: list, show, apply, remove and test the settings of the
 * admin pages, as an operator with an admin's rights. Returns the exit code.
 */
export async function settingsCommand(args: string[], io: CliIo, settings: Setting[]): Promise<number> {
  const [command, ...rest] = args;

  if (command === "list") {
    const values = parse(rest, { json: { type: "boolean" } }, "cli settings list [--json]");
    const rows: SettingRow[] = [];
    for (const setting of settings) rows.push(...(await setting.rows()));
    if (values.json) io.out(json(rows));
    else {
      const labelled = rows.map((row) => ({
        ...row,
        label: row.id === undefined ? row.name : `${row.name} --id ${row.id}`,
      }));
      printRows(labelled, io);
    }
    return 0;
  }

  if (command !== "show" && command !== "apply" && command !== "remove" && command !== "test") {
    throw new UsageError(command ? "Unknown command." : "Name a command.", USAGE);
  }
  const [name, ...optionArgs] = rest;
  const names = settings.map((setting) => setting.name).join(", ");
  const usage = `cli settings ${command} <name>`;
  if (!name || name.startsWith("-")) throw new UsageError(`Name the setting: ${names}.`, usage);
  const setting = settings.find((candidate) => candidate.name === name);
  if (!setting) throw new UsageError(`Unknown setting. Settings: ${names}.`, usage);
  const idOption = { id: { type: "string" } } as const;
  const optionalId = (values: OptionValues, syntax: string) =>
    values.id === undefined ? undefined : entryId(values.id, syntax);
  const requiredId = (values: OptionValues, syntax: string) => {
    if (values.id === undefined) {
      throw new UsageError("Give the entry's --id (cli settings list shows them).", syntax);
    }
    return entryId(values.id, syntax);
  };
  /** The command for the audit log: no body, no option but the ID. */
  const as = (id: string | undefined) =>
    operator(`cli settings ${command} ${setting.name}${id === undefined ? "" : ` --id ${id}`}`);

  switch (command) {
    case "show": {
      const syntax = setting.showOptions.usage;
      const values = parse(optionArgs, { ...idOption, ...setting.showOptions.options }, syntax);
      io.out(json(await setting.show(optionalId(values, syntax), values)));
      return 0;
    }
    case "apply": {
      const syntax = `cli settings apply ${setting.name} [--id <id>]`;
      const id = optionalId(parse(optionArgs, idOption, syntax), syntax);
      const body = await readJsonBody(io, `${syntax} < body.json`);
      const applied = await setting.apply(as(id), body, id);
      io.out(json(applied.json));
      if (applied.note) io.err(`${applied.note}\n`);
      return 0;
    }
    case "remove": {
      const syntax = `cli settings remove ${setting.name} --id <id>`;
      const id = requiredId(parse(optionArgs, idOption, syntax), syntax);
      io.err(`${await setting.remove(as(id), id)}\n`);
      return 0;
    }
    case "test": {
      const syntax = `cli settings test ${setting.name} --id <id>`;
      const id = requiredId(parse(optionArgs, idOption, syntax), syntax);
      const result = await setting.test(id);
      io.out(json(result));
      if (result.ok) return 0;
      io.err(`${result.message}\n`);
      return 1;
    }
  }
}
