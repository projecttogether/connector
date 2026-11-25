/*
 * The operator command, `cli` in the image (docs/deployment.md, "Settings
 * from the command line"): `cli settings …` and `cli tokens …` set what
 * admins set on the Sources, Service tokens and Directory pages, with the
 * same functions. Stdout carries only the command's output; logs go to
 * stderr. It starts no web server and no worker, closes the database pool
 * and exits. It loads without instrument.ts, so it reports nothing to Sentry.
 */
import { logToStderr } from "./log-target";

// An error outside the command's own reporting, such as while the modules
// load: only the generic message, since its text could quote a value.
process.on("uncaughtException", () => {
  process.stderr.write("Something went wrong. Try again.\n");
  process.exit(1);
});
logToStderr();
// Loaded only now: the logger reads the target when it loads.
const { runCli } = await import("./cli/main");
const { processIo } = await import("./cli/io");
const { closeDb } = await import("./db/client");

const code = await runCli(process.argv.slice(2), processIo());
await closeDb().catch(() => undefined);
// Exit only once the output is written: a pipe can take it slower than it comes.
const flushed = (stream: NodeJS.WriteStream) => new Promise((resolve) => stream.write("", resolve));
await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
process.exit(code);
