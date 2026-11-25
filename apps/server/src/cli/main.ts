import { ZodError } from "zod";
import { ConfigError } from "../config";
import { AppError, CONCURRENT_CHANGE_CODES, databaseErrorCode, zodFieldErrors } from "../http/errors";
import { UsageError, type CliIo } from "./io";
import { settingsCommand, type Setting } from "./settings";
import { sources } from "./sources";
import { tokensCommand } from "./tokens";

/** The settings of the admin pages. */
export const SETTINGS: Setting[] = [sources];

const DOCS =
  "https://github.com/projecttogether/connector/blob/main/docs/deployment.md#settings-from-the-command-line";

function help(): string {
  const width = Math.max(...SETTINGS.map((setting) => setting.name.length));
  return `Connector: the operator command. On a server with compose.yaml:
  docker compose run --rm -T migrate cli <command>
A command that prints a secret, so that Docker's logs do not keep it:
  (umask 077; set -C; docker compose exec -T web cli tokens create <kind> … > token.txt)
In a terminal of the app's container: cli <command>

Settings:
  cli settings list [--json]                      every source: set or incomplete, with hints
  cli settings show sources [--id <id>]           all sources, or one, as JSON, as the admin page reads it
  cli settings show sources --id <id> --spaces    the spaces of a Handbook, for its rule spaces
  cli settings apply sources [--id <id>] < body.json
                                                  save the admin page's JSON body from stdin;
                                                  without --id: connect a new source
  cli settings test sources --id <id>             what the page's Check button does
  cli settings remove sources --id <id>           remove a source and everything Connector kept of it

Tokens (a new one goes to stdout alone, once; notes go to stderr):
  cli tokens create service --name <name> [--expires-in-days <days>|never]
                                                  for a bot such as the Support Agent
  cli tokens create scim --name <name> [--expires-in-days <days>|never]
                                                  for an identity system such as IAM
  cli tokens create webhook-secret --source <id>  for a Logbook or Library; replaces the one before
  cli tokens list [--json]                        the service and SCIM tokens
  cli tokens revoke <id>                          end a service or SCIM token for good

  cli help                                        this text

Setting names:
${SETTINGS.map((setting) => `  ${setting.name.padEnd(width)}  ${setting.label}`).join("\n")}

Secrets go only on stdin, never in an argument; output shows hints only.
Exit codes: 0 done, 1 refused (the page's message on stderr), 2 wrong command
or a body that is not JSON. Example bodies: ${DOCS}
`;
}

/** The code to show: a SQLSTATE (it has a digit), or a system error's, such as ECONNREFUSED. */
function codeNote(code: string | undefined): string {
  if (code && /^(?=.*\d)[0-9A-Z]{5}$/.test(code)) return ` (database error ${code})`;
  return code && /^[A-Z][A-Z0-9_]*$/.test(code) ? ` (${code})` : "";
}

/**
 * What went wrong, for stderr, with the page's messages. A database error or
 * an unexpected error gets the page's generic message with its code at most:
 * its text could quote a value, such as a query's parameter or a header.
 */
function report(error: unknown, io: CliIo): number {
  if (error instanceof UsageError) {
    io.err(
      `${error.message}\n${error.usage ? `Usage: ${error.usage}\n` : ""}Run "cli help" for the commands.\n`,
    );
    return 2;
  }
  if (error instanceof AppError || error instanceof ZodError) {
    const [message, fields] =
      error instanceof AppError
        ? [error.message, error.fields]
        : ["Check the highlighted fields", zodFieldErrors(error)];
    io.err(`${message}\n`);
    for (const [field, text] of Object.entries(fields ?? {})) {
      io.err(`  ${field === "_" ? "body" : field}: ${text}\n`);
    }
    return 1;
  }
  if (error instanceof ConfigError) {
    io.err(`${error.message}\n`);
    return 1;
  }
  const code = databaseErrorCode(error);
  if (code && CONCURRENT_CHANGE_CODES.has(code)) {
    io.err("Someone else changed this at the same time. Try again.\n");
    return 1;
  }
  io.err(`Something went wrong. Try again.${codeNote(code)}\n`);
  return 1;
}

/** Runs `cli <args>` and returns the exit code. */
export async function runCli(args: string[], io: CliIo): Promise<number> {
  try {
    const [command, ...rest] = args;
    switch (command) {
      case "help":
      case "--help":
      case "-h":
        if (rest.length > 0) throw new UsageError("help takes no arguments.");
        io.out(help());
        return 0;
      case "settings":
        return await settingsCommand(rest, io, SETTINGS);
      case "tokens":
        return await tokensCommand(rest, io);
      case undefined:
        io.err(help());
        return 2;
      default:
        throw new UsageError("Unknown command.");
    }
  } catch (error) {
    return report(error, io);
  }
}
