# Contributing

Connector is a Hono server and a React web app in one repository (npm
workspaces). `AGENTS.md` has the layout and the code rules;
`docs/architecture.md` explains how the parts fit together; this file has
the setup and the checks.

## Development setup

You need Node.js 26 and Docker with Compose.

```sh
docker compose -f compose.dev.yaml up -d   # PostgreSQL 18 and Keycloak
cp .env.example .env.local
npm ci
npm run dev
```

Open http://localhost:5173 and sign in with one of the test users of
`compose.dev.yaml` (password `connector-dev`): `ada@example.org` is an admin
(`ADMIN_EMAILS`), `eddie@example.org` and `rita@example.org` are staff
(Rita is in the team group `/teams/Programs`), and `gina@example.org` is
refused because `.env.example` sets `ACCESS_GROUPS=/staff`. The Keycloak
admin console is at http://localhost:8106 (admin / admin); the `connector`
client has a service account with `view-users` for `DIRECTORY=keycloak`.

To try sources, run the other apps (Handbook, Logbook, Library, CRM) in
development (on other ports) and connect them under **Administration →
Sources**, or send signed webhooks by hand ([Sources](docs/sources.md)).
Notion needs an integration in a real workspace (a free one will do).

`npm run dev` starts the Vite dev server and the server with `APP_ROLE=all`,
so the worker runs too. The Vite server passes `/api`, `/mcp`, `/oauth`,
`/.well-known`, `/scim` and `/hooks` to the server, so agents can connect to
`http://localhost:5173/mcp` as well.

## Checks

```sh
node scripts/check-public-repository.mjs
npm run lint
npm run format:check      # npm run format fixes it
npm run typecheck
npm test                  # unit tests
npm run test:integration  # needs the PostgreSQL of compose.dev.yaml
npm run build
npm run test:e2e          # needs compose.dev.yaml and a build; see e2e/README.md
```

CI (`.github/workflows/ci.yaml`) runs all of them, scans the history for
secrets, checks that the migrations match the schema, audits the
production dependencies, and builds and starts the Docker image with
`compose.yaml`.

## Database changes

Edit `apps/server/src/db/schema/`, run `npm run db:generate`, and commit the
generated migration in `apps/server/drizzle/`. Migrations run before the new
version starts (`migrate` service), and a deploy that fails puts the
previous version back on the migrated database: add columns with defaults,
don't rename in place.

## Tests

Unit tests sit next to the code (`*.test.ts`). Integration tests
(`*.int.test.ts`) get a fresh database (`TEST_DATABASE_URL`, default
`connector_test` on the development PostgreSQL). Tests never call real
services: Handbook, CRM, Notion's API and their OAuth servers are local stand-ins
(`apps/server/src/test/fake-app.ts`). End-to-end tests in `e2e/` sign in
through the development Keycloak in a real browser.

## Pull requests

Write the title as one plain line of what changes. Label a pull request
`breaking` when the people who run the app must act on it, and describe the
steps in it. Update the docs when behavior or configuration changes.

## Builds and deploys

Every commit on `main` that passes CI is built and deployed; there are no
releases (`docs/deployment.md`, Builds and deploys). The Deploy workflow
uploads the source maps to the Sentry project `projecttogether/connector`
with the secret `SENTRY_AUTH_TOKEN` (Dockerfile); without the secret, it
uploads nothing.

## Data, secrets and privacy

Never commit secrets, real personal data or data from a real organization,
also not in tests and fixtures. Use `example.org` addresses and invented
content. `scripts/check-public-repository.mjs` rejects private file types,
unknown hosts and email domains, internal names and token formats; add a
host there only when it is public and intended.
