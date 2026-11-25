# Configuration

Every setting that comes from the environment. Blank values count as unset.
Sources, who may use them, groups and tokens are set up in the app; the
sources and the service and SCIM tokens also with the operator command
([Settings from the command line](deployment.md#settings-from-the-command-line)).
No secret of a connected app belongs here.

## Required

| Variable             | Meaning                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `APP_URL`            | The public URL, e.g. `https://connector.example.org`. Sign-in, OAuth and links depend on it.                                                                                   |
| `DATABASE_URL`       | PostgreSQL connection, e.g. `postgres://connector:secret@db:5432/connector`.                                                                                                   |
| `AUTH_SECRET`        | Signs sessions; at least 32 characters (`openssl rand -base64 32`); example values are refused.                                                                                |
| `ENCRYPTION_KEY`     | Encrypts stored source credentials and linked accounts: 32 random bytes, base64 (`openssl rand -base64 32`). Back it up; changing it makes them unreadable (enter them again). |
| `OIDC_ISSUER`        | The OpenID Connect provider, e.g. `https://login.example.org/realms/example`.                                                                                                  |
| `OIDC_CLIENT_ID`     | The app's client at the provider.                                                                                                                                              |
| `OIDC_CLIENT_SECRET` | Its secret.                                                                                                                                                                    |
| `ADMIN_EMAILS`       | Comma-separated addresses that are always admins: the first admin, and the way back in. Required in `compose.yaml`.                                                            |

## Sign-in and access

| Variable                                       | Default                | Meaning                                                                                                                                                                   |
| ---------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OIDC_PROVIDER_NAME`                           | `single sign-on`       | Shown on the sign-in button ("Sign in with …").                                                                                                                           |
| `OIDC_SCOPES`                                  | `openid email profile` | Scopes asked for. Add one that puts groups into the sign-in if you use `ACCESS_GROUPS` and your provider needs it.                                                        |
| `OIDC_PKCE`                                    | `true`                 | Proof Key for Code Exchange; turn off only for providers that reject it.                                                                                                  |
| `ALLOWED_EMAIL_DOMAINS`                        | (any)                  | Comma-separated domains that may sign in, e.g. `example.org`.                                                                                                             |
| `ACCESS_GROUPS`                                | (no check)             | Comma-separated groups; a person must be in one of them (or a subgroup, for Keycloak paths like `/staff`).                                                                |
| `OIDC_GROUPS_CLAIM`                            | `groups`               | The claim with a person's groups, from the ID token or the userinfo endpoint. A dotted name reads a nested claim.                                                         |
| `OIDC_REQUIRE_EMAIL_VERIFIED`                  | `true`                 | Only addresses the provider verified (`email_verified`) sign in. Turn off only for providers without the claim ([risk](identity-and-access.md#verified-email-addresses)). |
| `SESSION_DAYS`                                 | `7`                    | Sessions end this many days after sign-in, however much they are used.                                                                                                    |
| `AGENT_SIGN_IN_DAYS`                           | `30`                   | Personal tokens and connected apps stop when their person has not signed in for this long; `0`: no limit, else at least `SESSION_DAYS`.                                   |
| `DIRECTORY`                                    | `oidc`                 | `oidc`: groups from the sign-in (and SCIM). `keycloak`: also people, groups and deactivations from the Keycloak Admin API.                                                |
| `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET` | (the sign-in client)   | A client with a service account that has the realm-management role `view-users` (`DIRECTORY=keycloak`).                                                                   |
| `DIRECTORY_SYNC_MINUTES`                       | `15`                   | How often the worker syncs the Keycloak directory.                                                                                                                        |

See [Identity and access](identity-and-access.md).

## Agents (MCP and OAuth)

| Variable                          | Default | Meaning                                                                                                   |
| --------------------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `OAUTH_ACCESS_TOKEN_MINUTES`      | `60`    | Lifetime of a connected app's access token.                                                               |
| `OAUTH_REFRESH_TOKEN_DAYS`        | `30`    | Lifetime of a connected app's refresh token; each use gives a new one.                                    |
| `OAUTH_ALLOW_PRIVATE_CLIENT_URLS` | `false` | Development and tests only: accept client metadata documents on `http` and private addresses (localhost). |

See [Agents and MCP](agents.md).

## Sources and search

| Variable                 | Default   | Meaning                                                                                                                                                                                          |
| ------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SOURCE_TIMEOUT_SECONDS` | `8`       | How long a search waits for a live source (Handbook, CRM, Notion); a slower source is reported and left out.                                                                                     |
| `SOURCE_CHECK_MINUTES`   | `15`      | How often the worker checks the live sources (Handbook, CRM, Notion) for the status page; `0`: only admins check.                                                                                |
| `SEARCH_LANGUAGES`       | `english` | PostgreSQL text search configurations for the index of webhook sources (Logbook, Library), comma-separated, e.g. `english,german`. Exact words always match. The worker rebuilds after a change. |
| `ACTIVITY_LOG_DAYS`      | `90`      | Days the activity log keeps what agents and bots asked (with their search words); `0` records nothing.                                                                                           |

## Processes and server

| Variable                             | Default                          | Meaning                                                                                                                                                             |
| ------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ROLE`                           | `all`                            | `all`, `web`, `worker` or `migrate`; the image's command sets it.                                                                                                   |
| `APP_NAME`                           | `Connector`                      | The name in the app, on the sign-in page and for agents.                                                                                                            |
| `PORT`, `HOST`                       | `3000`, 0.0.0.0                  | Where the web process listens.                                                                                                                                      |
| `TRUST_PROXY`                        | `0`                              | Proxies in front that append to `X-Forwarded-For`: `true` (one), a number, or `false`. `compose.yaml` sets `true`.                                                  |
| `RUN_MIGRATIONS`                     | `false`                          | Apply migrations at start (single-container setups).                                                                                                                |
| `DATABASE_POOL_SIZE`                 | `10`                             | Connections per process.                                                                                                                                            |
| `DATABASE_STATEMENT_TIMEOUT_SECONDS` | `60`                             | Longest database statement of the web app and the worker; `0`: no limit. Migrations have none.                                                                      |
| `LOG_LEVEL`                          | `info`                           | `fatal` … `trace`, or `silent`.                                                                                                                                     |
| `AUDIT_LOG_DAYS`                     | `365`                            | Days the audit log keeps entries; the worker deletes older ones. `0` keeps them all.                                                                                |
| `WORKER_HEARTBEAT_FILE`              | (image: `/tmp/worker-heartbeat`) | The worker touches it every few seconds while no job hangs, for health checks.                                                                                      |
| `WEB_DIST_DIR`, `MIGRATIONS_DIR`     | (built in)                       | Paths of the built web app and the migrations; only for unusual layouts.                                                                                            |
| `APP_VERSION`                        | (image)                          | Set by the Deploy workflow: the first 12 characters of the commit. **Settings** shows it, and Sentry names the release after it. Unset in images built from source. |

Behind a reverse proxy, set `TRUST_PROXY`: the rate limits of sign-in and of
connected apps (OAuth) count per client address, and without it every
request seems to come from the proxy.

## Error reports (Sentry)

| Variable                    | Default                   | Meaning                                                          |
| --------------------------- | ------------------------- | ---------------------------------------------------------------- |
| `SENTRY_DSN`                | (off)                     | Send error reports, logs (warnings and up) and traces to Sentry. |
| `SENTRY_ENVIRONMENT`        |                           | e.g. `production`.                                               |
| `SENTRY_RELEASE`            | `connector@<APP_VERSION>` | Release name; the images of the Deploy workflow set the version. |
| `SENTRY_TRACES_SAMPLE_RATE` | `0`                       | Share of requests and page loads traced, 0 to 1.                 |

## Docker Compose only

| Variable              | Meaning                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `CONNECTOR_IMAGE_TAG` | The image to run: `latest` (the newest commit on `main`, the default) or `sha-<commit>` for one build. |
| `CONNECTOR_PORT`      | Host port of `web` on `127.0.0.1` (default 3000).                                                      |
| `POSTGRES_PASSWORD`   | With `compose.postgres.yaml`.                                                                          |
