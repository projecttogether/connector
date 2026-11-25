# AGENTS.md

Connector is ProjectTogether's open-source memory layer for AI agents: one
MCP connection for agents (and an API for bots) to Handbook, Logbook,
Library and CRM, with permissions checked before anything is returned and
every result linked to its source. User documentation is in `docs/`;
contributor setup is in `CONTRIBUTING.md`; how it works inside is in
`docs/architecture.md`.

## Stack

npm workspaces, Node.js 26, strict TypeScript.

- `apps/server`: Hono (API under `/api/v1`, MCP under `/mcp`, OAuth under
  `/.well-known` and `/oauth`, SCIM under `/scim/v2`, webhooks under
  `/hooks`), Better Auth (OIDC sign-in under `/api/auth`), Drizzle ORM on
  PostgreSQL, the MCP TypeScript SDK, pino logs, Sentry, Vitest.
- `apps/web`: Vite + React 19, TanStack Router and Query, Tailwind CSS 4,
  react-markdown. `src/components/ui/` holds the components (shadcn/ui and
  Radix), the app frame, the page layout, the sign-in page and the theme
  with ProjectTogether's colors (`styles.css`); `src/components/brand.tsx`
  the app icon and ProjectTogether's logo. US English.
- `packages/shared` (`@connector/shared/*`): zod schemas of the API
  (`api/*.ts`), source kinds, the source order and item IDs
  (`sources.ts`), channels (`roles.ts`), limits.

One Docker image runs every process: `APP_ROLE` = `all | web | worker | migrate`;
its command `cli …` runs the operator command (`cli settings`, `cli tokens`).

## Layout

```
apps/server/src/
  main.ts          entry; APP_ROLE selects the processes
  cli.ts, cli/     operator command: cli settings, cli tokens
  config.ts        every environment variable (zod); read only via config()
  db/schema/       Drizzle schema (auth.ts, app.ts)
  auth/            Better Auth, sign-in check and groups, credentials and admin tokens, principals
  sources/         sources (service.ts), source use (use.ts), source health (health.ts), one adapter per kind, the index, webhooks, linked accounts
  search/          federation: search, fetch, context, recent, activity log
  directory/       groups, Keycloak directory sync, people directory
  scim/            SCIM 2.0 server
  oauth/           OAuth 2.1 server for connected apps (MCP clients)
  mcp/             MCP server and tools (call the REST API in-process)
  admin/           people as admins see and change them: list, update
  people/          a person's lifecycle on every path: block, address, removal
  http/            app factory, middleware, errors
  modules/         one file per API area: routes
  worker/          scheduled jobs
apps/web/src/      web app; modules/<area> holds each area's pages; components/ui/ the
                   components, the app frame and the theme
packages/shared/src/  contracts, source kinds and order, limits
scripts/           build helpers, the public repository check
```

## Rules

- **Contracts first.** Change a request or response in
  `packages/shared/src/api/` and use it on both sides; routes validate input
  with it (`jsonBody`, `queryOf`).
- **Access before content.** Every route starts with `requirePrincipal`,
  `requireUser`, `requireWebUser` or `requireAdmin`. Adapters run only
  through `sources/use.ts`: `useSource` and `useSources` check `mayUse`
  before an adapter runs, and admin pages and the worker use
  `administerSource` (Connector's own credentials, never a person's);
  adapters apply the app's own rules (Library team notes, Handbook drafts). Agents act as their person and never administer;
  service tokens read only sources opened to them and only items meant for
  everyone.
- **Every kind of information keeps its home.** Live sources are asked at
  every request; the index holds only what webhook sources sent, replaced
  on every delivery and deleted on removal. Never copy live sources into
  the database.
- **Adapters** implement `Adapter` (`sources/types.ts`), throw
  `SourceError` with short plain messages and a kind (callers branch on the
  kind, never on a status or a message; what the app said stays out of the
  diagnostic), and never let a source's failure fail a federated request.
  Calls to apps go through `sourceRequest` or `sourceFetch`
  (`sources/http.ts`): the caller's signal, no redirects, size limits.
- **Every result links to its source** (absolute URL) and carries its
  authority (source order).
- **Credentials** of Connector are stored as SHA-256 hashes; secrets are
  shown once and never logged. Source credentials and linked accounts are
  encrypted with `ENCRYPTION_KEY` (`core/crypto.ts`) and never sent to the
  browser. Never log authorization codes, PKCE verifiers or tokens.
- **Design:** ProjectTogether's colors and app identity (PT Sky for buttons,
  focus and selected states, with PT Ocean text on it; links in the darker
  `--link`); the tokens are in `apps/web/src/components/ui/styles.css`.
  Keep components close to shadcn/ui (`@/components/ui/<name>`, `cn` from
  `@/components/ui/utils`).
- **Operator command** (`src/cli`): what an admin page sets, the command
  sets too, with the same functions: no checks of its own, no route logic
  that only the page has. Only `src/cli` creates the operator
  (`auth/principal.ts`); secrets come on stdin and are never printed, except
  a new token once. Changes to the settings also change
  `docs/deployment.md`, "Settings from the command line".
- **Restarts:** a deploy may restart `web` and `worker` at any time. Web
  finishes the requests in progress; `compose.yaml` gives it 30 seconds,
  more than the longest request (`longestRequestMs`, `sources/use.ts`).
  Worker jobs must survive being cut short: store a job's result or marker
  only at its end, or in one transaction.
- **Environment variables:** document each in `docs/configuration.md`. An
  app setting (not one of the server settings in `docs/deployment.md`,
  Settings) also needs a line in the Deploy workflow's `SETTINGS`.
- **Errors:** throw `AppError` helpers (`http/errors.ts`) with short, plain
  messages.
- **Logging:** `logger` with ids and codes; never item texts, titles,
  search words, email addresses, tokens or other personal data. No
  `console.*`, no `any`.
- **Sentry** gets no personal data: `redactErrorReport` and `redactLog`
  decide what reports and logs keep; no session replays.

## Database

Change the schema in `apps/server/src/db/schema/`, then run
`npm run db:generate` and commit the migration. CI fails when they differ.
A running installation's database must keep working: add only migrations
that the previous version survives (new columns with a default), and only
when needed. Keep stored values (setting keys, source kinds, enum values)
as they are.

## Tests

- Unit tests next to the code (`*.test.ts`); integration tests
  (`*.int.test.ts`) use the PostgreSQL of `compose.dev.yaml` and
  `src/test/helpers.ts` (`resetDatabase`, `createUser`, `createSource`,
  `createGroup`, `createToken`, `createAdminToken`, `request`). Apps are
  stand-ins from `src/test/fake-app.ts` (a local HTTP server); tests never
  call real services.
- API tests act as web users with
  `vi.mock("../auth/resolve", () => import("../test/resolve-mock"))` and the
  `userId` option; bearer tokens (`token` option) work as in production.
- End-to-end tests (`e2e/`) run a real browser against the built app and the
  development Keycloak, and send signed webhooks.

## Commands

```sh
docker compose -f compose.dev.yaml up -d   # PostgreSQL (55452), Keycloak (8106)
cp .env.example .env.local
npm ci
npm run dev                                # web app http://localhost:5173, server :3000

node scripts/check-public-repository.mjs
npm run lint && npm run format:check && npm run typecheck && npm test
npm run test:integration
npm run build && npm run test:e2e
```

Deploys: every commit on `main` that passes CI is built and deployed
(`docs/deployment.md`, Builds and deploys). No file holds the version.

## Content

UI text and messages are in US English; short and plain. Never commit
secrets, real personal data or data from a real organization: use
`example.org` addresses and invented content. Keep ProjectTogether's
internals (server names, addresses, internal domains, people, vault names)
out of this repository; they belong in its infrastructure repository. The
code is licensed under the Apache License 2.0 (`LICENSE`).
