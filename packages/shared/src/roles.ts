/**
 * Who may do what (docs/identity-and-access.md):
 *
 * - Everyone signed in searches the sources they may use: a source is open
 *   to everyone signed in or to members of some groups, and each app's own
 *   rules (e.g. Library team notes) apply on top.
 * - Admins connect sources, decide who may use them, and manage people,
 *   groups, tokens and the directory.
 * - AI agents (personal tokens, connected apps) act as their person: they
 *   see what the person sees; they never administer.
 * - Service tokens (bots such as the Support Agent) read only the sources
 *   an admin opened to them, and only content meant for everyone there.
 */

/** How a request authenticated. */
export const CHANNELS = ["web", "token", "oauth", "service"] as const;
export type Channel = (typeof CHANNELS)[number];
