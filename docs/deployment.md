# Deployment

For the person who runs Connector on a Linux server, such as a VPS with
Debian or Ubuntu: requirements, [setup](#setup),
[settings from the command line](#settings-from-the-command-line),
[upgrades](#upgrades), [builds and deploys](#builds-and-deploys), backups,
Sentry and troubleshooting. Every environment variable is described in
[Configuration](configuration.md).

## Requirements

- **A server with Debian 12 or later** (or a similar system with systemd and
  apt, such as Ubuntu 24.04), with Docker Engine and its Compose plugin, and a
  domain name that points at it.
- **PostgreSQL 16 or later:** a database of your own, or the one
  `compose.postgres.yaml` adds.
- **Caddy** (or another reverse proxy on the server) that terminates HTTPS.
- **An OpenID Connect provider** for sign-in (Keycloak, Microsoft Entra ID,
  Google, Authentik, …), see [Identity and access](identity-and-access.md).
- **The apps to connect** (Handbook, Logbook, Library, CRM, Notion), reachable from
  Connector's server; Logbook and Library must reach Connector's `/hooks/`
  addresses ([Sources](sources.md)).

## What runs

The [Deploy workflow](#builds-and-deploys) builds the image
`ghcr.io/projecttogether/connector` (linux/amd64) from every commit on
`main` that passes CI, tagged `sha-<commit>` and `latest`. There are no
numbered releases: the commit is the version. `CONNECTOR_IMAGE_TAG` in
`.env` picks the image: `latest` (the default) or `sha-<commit>` for one
build.

| File                    | Contains                                                                          |
| ----------------------- | --------------------------------------------------------------------------------- |
| `Dockerfile`            | The image. Its command (`all`, `web`, `worker`, `migrate`, `cli`) picks the role. |
| `compose.yaml`          | A one-off `migrate`, the web app (`web`) and the `worker`.                        |
| `compose.postgres.yaml` | Adds a PostgreSQL 18 container, for servers without a database of their own.      |

The image runs as an unprivileged user (uid 1000). `web` listens on port
3000, published on `127.0.0.1:3000` for a reverse proxy on the same machine;
`CONNECTOR_PORT` changes the host port. Everything Connector keeps is in
PostgreSQL; the image needs no volume.

The reverse proxy must pass `/mcp`, `/oauth/*`, `/.well-known/*`,
`/scim/v2/*` and `/hooks/*` to the app unchanged (agents, identity systems
and webhooks connect there), and must not buffer or cache `/mcp`:
`/mcp` streams its answers as events (nginx: `proxy_buffering off;` for
`/mcp`). The app compresses its responses itself (scripts and styles with
brotli or gzip; JSON and HTML with gzip; never `/mcp`), so the proxy needs
no compression of its own. A proxy that
compresses anyway must leave `/mcp` alone.

### One container

Platforms that run a single image (no Compose) can use the command `all`
with `RUN_MIGRATIONS=true`: the web app and the worker then share one
process.

## Setup

On a server with Debian 12 or later, or a similar system such as Ubuntu,
run the commands as root (`sudo -i`).

1. **Docker:** install Docker Engine and the Compose plugin from Docker's
   apt repository ([Debian](https://docs.docker.com/engine/install/debian/),
   [Ubuntu](https://docs.docker.com/engine/install/ubuntu/)), and Git:
   `apt install git`.
2. **Get the files:**

   ```sh
   git clone https://github.com/projecttogether/connector.git /srv/connector
   cd /srv/connector
   ```

3. **Register the app at your provider** with the redirect URL
   `<APP_URL>/api/auth/callback/oidc` ([Identity and access](identity-and-access.md)).
4. **Create `.env`** from `.env.example` (`cp .env.example .env`,
   `chmod 600 .env`) and set production values: `APP_URL`, `DATABASE_URL`,
   a new `AUTH_SECRET` and `ENCRYPTION_KEY` (each `openssl rand -base64 32`),
   the `OIDC_*` values, your address in `ADMIN_EMAILS`, `DIRECTORY`, and
   `SEARCH_LANGUAGES` for the languages of your Logbook and Library. Remove
   `NODE_ENV=development`, `RUN_MIGRATIONS` and
   `OAUTH_ALLOW_PRIVATE_CLIENT_URLS`. With an `https` `APP_URL`, the app
   does not start with the example `AUTH_SECRET` or `ENCRYPTION_KEY`, or with
   `OAUTH_ALLOW_PRIVATE_CLIENT_URLS`. Without a database of your own, add
   `COMPOSE_FILE=compose.yaml:compose.postgres.yaml`, a `POSTGRES_PASSWORD`
   (`openssl rand -hex 32`) and
   `DATABASE_URL=postgres://connector:<POSTGRES_PASSWORD>@postgres:5432/connector`.
5. **Start:** `docker compose up -d --pull always`.
6. **HTTPS:** point the domain's DNS at the server, install Caddy
   (`apt install caddy`), and put this site into `/etc/caddy/Caddyfile`, in
   place of the package's example site `:80` and next to the sites of other
   apps:

   ```text
   connector.example.org {
   	reverse_proxy 127.0.0.1:3000
   }
   ```

   Then `systemctl reload caddy`. Caddy gets the certificate itself, and it
   passes the event streams of `/mcp` through without buffering. With
   `CONNECTOR_PORT` set, use that port instead of 3000.

7. Open `APP_URL`, sign in, and connect the first source with its guide
   under **Administration → Status** ([Sources](sources.md)), or
   [without a browser](#settings-from-the-command-line).

## Settings from the command line

`cli` is Connector's operator command. It sets what admins set under
**Administration**, the sources and the tokens, with the same checks, and
the audit log names the `operator` and the command. On the server, in
`/srv/connector`:

```sh
docker compose run --rm -T migrate cli settings list
```

In a running container, the command is just `cli …`
(`docker compose exec web cli settings list`).

| Command                                        | What it does                                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli settings list [--json]`                   | Every source with its ID: set, or incomplete (its secret is missing or unreadable), with hints; never a secret                                    |
| `cli settings show sources [--id <id>]`        | Every source, or one, as JSON, as the admin page reads it                                                                                         |
| `cli settings show sources --id <id> --spaces` | The spaces of a Handbook, for `ruleSpaces`                                                                                                        |
| `cli settings apply sources [--id <id>]`       | Reads the JSON body of the admin page from stdin and saves it; without `--id`, connects a new source and prints its ID. Prints what `show` prints |
| `cli settings test sources --id <id>`          | What the page's **Check** button does                                                                                                             |
| `cli settings remove sources --id <id>`        | Removes the source and everything Connector kept of it                                                                                            |
| `cli tokens create <kind> …`                   | Issues a token and prints it once, alone on stdout ([below](#tokens))                                                                             |
| `cli tokens list [--json]`                     | The service and SCIM tokens: name, first characters, dates                                                                                        |
| `cli tokens revoke <id>`                       | Ends a service or SCIM token for good                                                                                                             |
| `cli help`                                     | The commands                                                                                                                                      |

Secrets go only on stdin, never in an argument: arguments show in `ps` and
the shell history. Pasted into a terminal, the body is not shown; end it
with Ctrl-D. Exit codes: 0 done, 1 refused (the page's message on stderr),
2 a wrong command or a body that is not JSON.

An AI agent with access to the server sets a secret like this: the secret
arrives as a file, the agent pipes the body into `cli settings apply`, runs
`cli settings test`, and deletes the file.

```sh
jq -n --rawfile token handbook-token.txt \
  '{kind: "handbook", slug: "handbook", name: "Handbook",
    config: {baseUrl: "https://handbook.example.org"},
    secret: {serviceToken: ($token | rtrimstr("\n"))}}' |
  docker compose run --rm -T migrate cli settings apply sources
docker compose run --rm -T migrate cli settings test sources --id <id>
rm handbook-token.txt
```

### sources

A new source names its `kind`, a `slug` (it starts item IDs and the webhook
address, and cannot change later), a `name` and its `config`; the rest is
optional:

```json
{
  "kind": "handbook",
  "slug": "handbook",
  "name": "Handbook",
  "description": "Policies and guides",
  "enabled": true,
  "accessGroups": ["/staff"],
  "serviceAccess": false,
  "config": {
    "baseUrl": "https://handbook.example.org",
    "ruleSpaces": ["policies"],
    "allowLinking": true
  },
  "secret": { "serviceToken": "<Handbook's service token>" }
}
```

```json
{
  "kind": "crm",
  "slug": "crm",
  "name": "CRM",
  "accessGroups": ["/staff/fundraising"],
  "config": { "baseUrl": "https://crm.example.org", "types": ["contact", "organization", "deal"] },
  "secret": { "apiKey": "<the CRM's API key>" }
}
```

```json
{
  "kind": "notion",
  "slug": "notion",
  "name": "Notion",
  "config": {
    "baseUrl": "https://www.notion.so/example-org",
    "databases": [
      {
        "id": "https://www.notion.so/example-org/Wiki-1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6",
        "authority": "knowledge"
      },
      { "id": "2b3c4d5e6f7a48b9c0d1e2f3a4b5c6d7", "authority": "history" }
    ]
  },
  "secret": { "integrationSecret": "<the Notion integration's secret>" }
}
```

A Notion source's `databases` take each database's link or ID and a level
(`knowledge`, `history`, `record` or `library`); `apiUrl` (Notion's API,
`https://api.notion.com`) changes only for a proxy.

```json
{
  "kind": "logbook",
  "slug": "logbook",
  "name": "Logbook",
  "config": { "baseUrl": "https://logbook.example.org" }
}
```

```json
{
  "kind": "library",
  "slug": "library",
  "name": "Library",
  "config": { "baseUrl": "https://library.example.org", "teamGroupPrefix": "/teams" }
}
```

With `--id`, a body changes only the fields it names; `config` is replaced
as a whole, and the kind and the slug stay:
`{ "accessGroups": ["/staff"], "secret": { "apiKey": "<a new key>" } }`. A
secret that is left out or empty stays as saved. A Handbook or CRM that
moves to another host, or a Notion source with another `apiUrl`, loses its
secret and its linked accounts, as on the page: send the new secret along,
or apply it next.

### Tokens

| Kind             | Options                                           | For                                                                                                  |
| ---------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `service`        | `--name <name> [--expires-in-days <days>\|never]` | Bots such as the Support Agent; stderr names the search URL                                          |
| `scim`           | `--name <name> [--expires-in-days <days>\|never]` | Identity systems such as IAM; stderr names the SCIM base URL                                         |
| `webhook-secret` | `--source <id>`                                   | Logbook and Library: a new webhook secret that replaces the one before; stderr names the webhook URL |

Run these in the running container, with `docker compose exec`: the token
is alone on stdout, so `> file` keeps only the token, and Docker does not log
it (it logs what `docker compose run` prints). `umask` makes the new file
private; `set -C` refuses to overwrite one that is there already, which would
keep its permissions.

```sh
(umask 077; set -C; docker compose exec -T web cli tokens create service --name "Support Agent" > token.txt)
```

Without `--expires-in-days`, a token stops working after 90 days.

Connect a Logbook (or a Library) without a browser, in Connector's folder
and then in Logbook's:

```sh
docker compose run --rm -T migrate cli settings apply sources < logbook.json   # prints the ID
(umask 077; set -C; docker compose exec -T web cli tokens create webhook-secret --source <id> > secret.txt)

cd /srv/logbook
jq -n --rawfile secret /srv/connector/secret.txt \
  '{url: "https://connector.example.org/hooks/logbook", secret: ($secret | rtrimstr("\n"))}' |
  docker compose run --rm -T migrate cli settings apply webhook
rm /srv/connector/secret.txt
```

Logbook and Library up to 0.3.2 have no `cli settings apply webhook`
([Sources](sources.md#logbook)).

## Health checks

- `GET /-/livez`: the web process runs.
- `GET /-/readyz`: it reaches the database.
- The worker touches `/tmp/worker-heartbeat` every few seconds;
  `compose.yaml` checks its age. It stops while a job runs far longer than
  it should (the hourly cleanup 30 minutes, rebuilding the search index 4
  hours), so the check fails and the platform can restart the worker.
- Database connections give up after 10 seconds of waiting for a
  connection, end statements after `DATABASE_STATEMENT_TIMEOUT_SECONDS`
  and transactions left idle for a minute, and probe idle connections for
  lost ones.

Docker Compose marks a container whose check fails as unhealthy, but does
not restart it. Set up an uptime check from outside the server (your
monitoring or an uptime service) on `<APP_URL>/-/readyz`, so that someone
hears when the app is down.

## Upgrades

An upgrade pulls a newer image. In `/srv/connector`:

1. Read the pull requests merged since the running commit (**Settings**
   shows it under **About**). A pull request labeled `breaking` says what to
   do; take those steps.
2. Run `git pull` for the newest `compose.yaml`, then
   `docker compose up -d --pull always`. With `CONNECTOR_IMAGE_TAG` pinned
   to `sha-<commit>`, set the new commit first.

The `migrate` service applies database migrations before `web` and `worker`
start. An upgrade can happen at any time: `web` finishes the requests in
progress first (`compose.yaml` gives it 30 seconds, enough for an agent's
Handbook proposal), and a job of the worker that the stop cuts short starts
over after the restart. Logbook and Library send a webhook delivery again
until Connector answers it.

## Builds and deploys

Every commit on `main` that passes CI is built and, at ProjectTogether,
deployed. There are no numbered releases: the commit is the version.

- **CI** (`.github/workflows/ci.yaml`, on every pull request and on `main`):
  the history for secrets (Gitleaks), the files for private artifacts,
  internal names and credential formats (`scripts/check-public-repository.mjs`),
  lint, formatting, types, unit tests, migration drift, the build, the
  production dependencies (`npm audit`), the integration tests
  (PostgreSQL), the browser tests (Keycloak), and the image (started with
  `compose.yaml`).
- **Deploy** (`.github/workflows/deploy.yml`), when CI passes on `main`, or
  by hand (Actions → Deploy → Run workflow), for example after a setting
  changed:
  1. It builds `ghcr.io/projecttogether/connector` with `APP_VERSION` set to
     the first 12 characters of the commit and pushes it as `sha-<commit>`
     and `latest`.
  2. It sends the image and the app's settings to the server of the GitHub
     environment `production` over SSH. The server's deploy script pulls the
     image, writes the settings, runs the migrations, starts `web` and
     `worker`, waits until both are healthy, and puts the previous image and
     settings back when they do not become healthy. One deploy runs at a
     time; a newer one waits.

Without the variable `DEPLOY_HOST` in the environment `production`, step 2
deploys nothing. Label a pull request `breaking` when the people who run the
app must act on it, and write the steps into its description; merging
deploys it, so take steps that must come first before merging.

The package `connector` in GitHub's container registry must be public, so
that servers can pull it without a token: an owner of the organization sets
that once, after the first build.

### Settings

The settings come from two places:

- **Server settings**, written on the server by its own configuration
  (ProjectTogether's infrastructure repository): `APP_URL`, `DATABASE_URL`,
  `TRUST_PROXY`, `ENCRYPTION_KEY`, `AUTH_SECRET`, `CONNECTOR_PORT`, and
  `POSTGRES_PASSWORD` with `compose.postgres.yaml`. They win over the app
  settings. A server may also set `TZ`; Connector keeps its times in UTC
  and does not depend on it.
- **App settings**, sent by the Deploy workflow at each deploy from the
  environment `production`: every other variable of
  [Configuration](configuration.md) that the app reads, as the workflow's
  `SETTINGS` list names them. Empty values are left out, so the app's
  default applies. A new setting needs a line in `SETTINGS` and its own line
  below it.

| Kind      | Names                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secrets   | `DEPLOY_SSH_KEY`, `OIDC_CLIENT_SECRET`, `KEYCLOAK_CLIENT_SECRET`, `SENTRY_DSN`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Variables | `DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS`, `APP_URL` (the environment's link only), `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_PROVIDER_NAME`, `OIDC_SCOPES`, `OIDC_PKCE`, `OIDC_GROUPS_CLAIM`, `OIDC_REQUIRE_EMAIL_VERIFIED`, `ADMIN_EMAILS`, `ALLOWED_EMAIL_DOMAINS`, `ACCESS_GROUPS`, `SESSION_DAYS`, `AGENT_SIGN_IN_DAYS`, `DIRECTORY`, `KEYCLOAK_CLIENT_ID`, `DIRECTORY_SYNC_MINUTES`, `OAUTH_ACCESS_TOKEN_MINUTES`, `OAUTH_REFRESH_TOKEN_DAYS`, `SOURCE_TIMEOUT_SECONDS`, `SOURCE_CHECK_MINUTES`, `SEARCH_LANGUAGES`, `ACTIVITY_LOG_DAYS`, `AUDIT_LOG_DAYS`, `APP_NAME`, `LOG_LEVEL`, `DATABASE_POOL_SIZE`, `DATABASE_STATEMENT_TIMEOUT_SECONDS`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE` |

The build reads one more secret, of the repository or the organization, not
of the environment: `SENTRY_AUTH_TOKEN`
([Sentry](#error-reports-and-performance-data-sentry)). Elsewhere,
`compose.yaml` with a plain `.env` holds both kinds of settings
([Setup](#setup)).

### Rollbacks

A deploy that does not become healthy puts the previous image back by
itself. To go back by hand, revert the change on `main`, or run the server's
rollback. Neither undoes database migrations, so a migration keeps the
previous version working: add columns with a database default.

## Backups

Back up together:

- the PostgreSQL database (`pg_dump`, or the `postgres` volume): sources
  and their encrypted credentials, the index of Logbook and Library,
  people, groups, linked accounts, tokens (as hashes), the logs;
- `ENCRYPTION_KEY` (keep it apart from the database backup): without it the
  stored credentials cannot be read, and admins enter them again.

The index of webhook sources can also be rebuilt: Logbook and Library
resend every item in their nightly run once the receiver lacks it. Test a
restore once: restore the database on another machine, start the app with
the same `ENCRYPTION_KEY`, and **Check** each source.

## Error reports and performance data (Sentry)

With `SENTRY_DSN` set, the server and the web app send error reports to
Sentry (or a compatible service). The release is `connector@<commit>` for
the images of the Deploy workflow, unless `SENTRY_RELEASE` is set, so
reports link to the code: the Deploy workflow uploads the source maps to
the Sentry project `projecttogether/connector` when the secret
`SENTRY_AUTH_TOKEN` (an organization token) is set; without it, nothing is
uploaded. The web app's source maps are not in the image, so browsers
cannot download them.

- **Errors:** crashes, failed requests and errors the server logs, from the
  server and from browsers.
- **Performance:** set `SENTRY_TRACES_SAMPLE_RATE` (e.g. `0.2`) to trace
  that share of requests and page loads.
- **Logs:** warnings and errors of the server.
- **Cron monitors:** the worker's cleanup job checks in as `connector-prune`,
  the Keycloak directory sync as `connector-directory-sync`.

Reports never contain item texts, titles, search words, names, email
addresses, tokens, request data or variables; error messages are left out because database
errors can quote values. There are no session replays.

## Logs

Every process logs JSON lines to standard output (`docker compose logs
web`). Logs carry identifiers (source, link, request), never item texts,
search words or email addresses. Sign-ins that were refused log the reason (`sign-in
refused: email domain not allowed`, `… not in ACCESS_GROUPS`, `… blocked`,
`… email address not verified by the provider`).

## Hardening

- Serve the app over HTTPS only.
- Use your organization's own identity provider, where people cannot choose
  their email address themselves. With a public provider (e.g. Google),
  set `ALLOWED_EMAIL_DOMAINS` or `ACCESS_GROUPS`; without either, the
  server logs a warning at start.
- Keep `OIDC_REQUIRE_EMAIL_VERIFIED` on unless your provider does not send
  `email_verified` ([Identity and access](identity-and-access.md#verified-email-addresses)).
- When someone leaves, block them in the app for immediate effect
  ([Identity and access](identity-and-access.md#when-someone-leaves)).
- Keep `ADMIN_EMAILS` to one or two people.
- Open each source only to the groups that may use the app itself, and to
  service tokens only where everyone in the bot's audience may read it
  ([Sources](sources.md#who-may-use-a-source)).
- Give Connector the narrowest credentials at each app: a Handbook service
  token, a CRM API key with the viewer role and read scopes only, a Notion
  integration that may only read content and sees only the databases
  Connector searches.
- Agents only propose Handbook changes; editors decide. Read the diff
  before merging, also when an agent made it: content can contain
  instructions meant to mislead agents.
- Keep `ENCRYPTION_KEY` secret and out of the database backup.
