# Architecture

How Connector works inside, for contributors. `AGENTS.md` has the
code rules; `docs/agents.md` explains agent access, `docs/sources.md` the
sources.

## Idea

Connector is the memory layer of the AI Operating System: it connects the
places where an organization keeps its knowledge (Handbook, Logbook,
Library, CRM, Notion, IT Knowledge Base) to the people and agents who work with it, and enforces who
may see what. Every kind of information keeps its home in its app:
Connector asks live sources at every request and keeps only an index of
what webhook sources send, replaced on every change and deleted on removal.

```text
 Claude · ChatGPT · Le Chat · Support Agent · browser
        │ MCP (OAuth 2.1) · REST · knowledge API
 ┌──────▼──────────────────────────────────────────┐
 │ Connector                                        │
 │  auth: OIDC sessions, tokens, OAuth server       │
 │  access: sources open to groups / service tokens │
 │  federation: ask every source, merge, cite        │
 │  index: Logbook and Library items (PostgreSQL FTS)│
 │  directory: Keycloak sync, SCIM 2.0 server        │
 └──┬───────────┬────────────┬───────────┬──────────┘
    │ REST       │ webhook    │ webhook    │ REST
 Handbook     Logbook      Library      CRM
 (service token or the person's linked account)
```

## Concepts

- **Source**: one connected app (`sources`): kind, slug, address
  (`config.baseUrl`), encrypted credentials, access groups, whether service
  tokens may read it, the last check or delivery.
- **Adapter**: the code of one kind (`apps/server/src/sources/`):
  `check`, `search`, `fetch`, `recent`. Live adapters (Handbook, CRM,
  Notion) call the app's REST API; webhook adapters (Logbook, Library, IT Knowledge Base) read the index.
- **Item**: anything a source returns, with the ID
  `<source slug>:<type>:<id in the app>` (`packages/shared/src/sources.ts`).
- **Authority**: an item's level in the source order (rules, decision,
  knowledge, history, record, library). Adapters set it: Handbook pages in
  rule spaces are `rules`, Logbook decisions in force are `decision`.
- **Principal**: who asks (`auth/principal.ts`): a person (web session,
  personal token, connected app) with their groups, or a service token. The
  operator is not one: only `src/cli` creates it (a symbol no request can
  carry), and only admin changes and the audit log take it (`Actor`).
- **Source health**: how a source is doing (`sources/health.ts`), from its
  last check or delivery, agents' and bots' reads of it, and its
  credentials. Its state means the same on the status page, the home page
  and in `list_sources`; only admins get the problems behind it.

## Processes

One Docker image, one Node.js entry point (`apps/server/src/main.ts`);
`APP_ROLE` picks what runs:

- **web**: the Hono server: the JSON API under `/api/v1`, sign-in under
  `/api/auth` (Better Auth; only the routes of the sign-in flow), the OAuth
  server under `/.well-known/*` and `/oauth/*`, MCP at `/mcp`, SCIM at
  `/scim/v2`, webhooks at `/hooks/<slug>`, health checks under `/-/`, and
  the built web app.
- **worker**: syncs the Keycloak directory (`DIRECTORY=keycloak`), checks
  the live sources every `SOURCE_CHECK_MINUTES` for the status page,
  rebuilds the index's search data when `SEARCH_LANGUAGES` changed, and
  removes
  expired OAuth requests and tokens, OAuth clients without a grant,
  unfinished account links, and old audit and activity entries.
- **migrate**: applies the Drizzle migrations under an advisory lock.
- **all**: web and worker in one process.

A deploy may restart web and worker at any time (SIGTERM). Web stops taking
connections and finishes the requests in progress; the longest, an agent's
proposal, takes up to 25 seconds (`longestRequestMs`), so `compose.yaml`
gives web 30 seconds to stop. The worker waits for its running job; a job
cut short starts over at the next start, and none leaves half a result:
the index rebuild stores its languages only at the end, the Keycloak sync
is one transaction. Logbook and Library send a delivery again until it is
answered with 200, with the item's whole current content.

The operator command (`apps/server/src/cli.ts`, `cli` in the image) is a
second entry point: `cli settings …` and `cli tokens …`
([Deployment](deployment.md#settings-from-the-command-line)) call the
functions that the admin routes call (`sources/service.ts`,
`auth/admin-tokens.ts`), log to stderr and exit. Every process reads the
sources from the database at each request, so nothing has to be told.

## Data

PostgreSQL holds everything (`apps/server/src/db/schema/`).

- `users` (+ Better Auth's `sessions`, `accounts`, `verifications`,
  `auth_rate_limits`): people who signed in or whom the directory knows;
  `is_admin`, `blocked_at` and `blocked_by` (`app` or `directory`),
  `sign_in_groups`, `title`, `directory_source` (`scim`, `keycloak`) and
  `directory_id`. The provider's tokens are removed after the sign-in check.
  Removed people keep their row under a `removed.invalid` address, so the
  logs still name someone; `removePerson` also takes their name and email
  out of `audit_log` and `activity`.
- `groups`, `group_members`: directory groups (`app`, `scim`, `keycloak`)
  with their identity system ID (`external_id`).
- `sources`: as above; `secret_encrypted` and `oauth_client_encrypted`
  (Connector's registration at a source's OAuth server) are AES-256-GCM
  with `ENCRYPTION_KEY` (`core/crypto.ts`).
- `items`: the index of webhook sources: type, reference (`LB-12`), title,
  URL, summary, body, status, `in_force`, metadata, related references,
  `visibility` (`all` or `groups`) with `visibility_groups`
  (`group:<name>`, `kc:<Keycloak group ID>`), dates, `search_vector`.
- `source_links`, `link_requests`: linked accounts (encrypted tokens) and
  links in progress (hashed state, encrypted PKCE verifier).
- `credentials`: personal tokens (`cn_pat_`), service tokens (`cn_svc_`),
  SCIM tokens (`cn_scim_`), OAuth access and refresh tokens (`cn_at_`,
  `cn_rt_`), as SHA-256 hashes. `oauth_clients`, `oauth_grants`,
  `oauth_requests`: the OAuth server.
- `activity`: what agents, personal tokens and bots asked (no results).
  `audit_log`: admin changes and directory changes, never secrets.
  `settings`: app state (search languages of the index, last directory sync).

## Access

`sources/service.ts` decides which sources a principal may use
(`mayUse`): enabled, and for a person no access groups or one of them
(`directory/groups.ts`, `inAnyGroup`: subgroups count); for a service token
`service_access`. Adapters run only through `sources/use.ts`: `useSources`
and `useSource` check `mayUse` themselves, so `fetch` of a closed source
answers 404 like an unknown item; admin pages and the worker use
`administerSource`, as Connector itself with the source's own credentials,
never a person's. Every use has a time budget and ends in an outcome (ok,
count, time, error), whether it worked or not, for the answer and the
activity log.

Inside a source:

- **Handbook**: the app decides. With a linked account, Connector calls
  Handbook as the person; else with the service token, which never sees
  drafts.
- **CRM**: the API key's sharing decides, Connector's access groups
  decide who sees the key's results.
- **Notion**: only pages of the databases the source names, whatever else
  the integration sees (`notion.ts`, `databaseOf`); Connector's access
  groups decide who sees them.
- **Logbook**: everyone with access reads every entry; drafts never arrive.
- **Library**: `visibility = groups` items match the caller's group names
  and Keycloak group IDs (`index-store.ts`, `visible`); service tokens see
  only `all`.
- **IT Knowledge Base**: public pages are `all`; every other page carries
  its groups as `group:<path>` and matches the caller's group paths
  exactly, as the site does; service tokens read as members of the
  source's access groups (`serviceKeys`). Pages not meant for answers are
  not kept.

Agents carry their person's groups (resolved on every request), so a person
removed from a group loses the source for their agents too. Blocking,
removal, a SCIM deactivation or a Keycloak deactivation revokes their
agents.

## Search

`search/federate.ts` asks every usable source at the same time
(`useSources`), each with its own `SOURCE_TIMEOUT_SECONDS` budget, and
reports each source's outcome. A failing or slow source never fails the
request.

- **Merge** (`mergeResults`): round-robin by each source's own rank; within
  a round the stronger authority first, then the source's place in the
  list. Each source's best answers lead; the source order decides ties.
- **Context** (`buildContext`): per source the best few, Handbook pages
  dated through `fetch`; grouped by authority; notes for decisions newer
  than pages, replaced decisions, and sources that did not answer.
- **Recent**: each adapter's changes since a date (Handbook `/recent`, the
  index's `changed_at`, Notion's last edit), newest first. The CRM has none.
- **Notion** (`sources/notion.ts`): each named database's tables (data
  sources) are asked for pages whose title or text properties contain every
  search word; their IDs and property IDs are kept in memory for five
  minutes, keyed by the source's `updated_at`.
- **Index search** (`index-store.ts`): `websearch_to_tsquery` in each
  `SEARCH_LANGUAGES` configuration plus `simple`, ranked with `ts_rank`; an
  exact reference (`LB-12`) ranks first; snippets from `ts_headline` with
  `\u0002`/`\u0003` marks (stripped for agents and bots).
- **Activity**: every read by an agent, token or bot is recorded
  (`logActivity`); web app reads are not. A failure is kept in Connector's
  own words (the `SourceError`'s diagnostic), never what the app said.

## Webhooks

`sources/webhooks.ts`: `POST /hooks/<slug>` checks the HMAC-SHA256 of
`<timestamp>.<raw body>` against the source's webhook secret in constant
time, refuses timestamps more than 300 seconds off, then validates the
payload with zod. Logbook `entry.changed`, Library `note.changed` and IT
Knowledge Base `page.changed` replace the item (`upsertItem`),
`note.removed` deletes it, and the IT Knowledge Base's `export.completed`
deletes the pages it no longer lists (`removeItemsExcept`). Deliveries are
idempotent; the source's status shows the last delivery or the last
refused one (`recordDelivery`, source health).

## Source health

`sources/health.ts` records and judges how every source is doing. It
records the checks of live sources (`checkSource` for the admin's button,
`checkLiveSources` for the worker; both ask the app through
`administerSource`) and the deliveries and refused deliveries of webhook
sources (`recordDelivery`), each stamped with the database's time so the
setup guide compares one clock. Judging reads only the database, never the
apps, including agents' and bots' reads of a source from the activity log:
the last 24 hours, since the source with that slug was created, proposals
left out.

One judgment gives every source a state (off, setup, failing, waiting,
unchecked, ok, the first that applies). A source whose latest read failed
stays failing until a read works again, whatever a check says. Two readers
get it:

- **The status page** (`sourcesHealth`): the state with the problem that
  needs an admin, and whether the worker still checks.
- **The home page and `list_sources`** (`sourceStateJudge`, through
  `GET /sources`): the same state of the sources the caller may use,
  without the problems.

## Linked accounts

`sources/links.ts` is an OAuth 2.1 client: discovery (RFC 9728, RFC 8414),
dynamic client registration once per source, authorization code with PKCE
and `resource`, the `iss` check (RFC 9207), refresh before expiry under a
row lock and within the request's time budget (a refresh token works once,
and Handbook ends the whole grant on reuse), removal of the link when the
source refuses the refresh token, and revocation on unlink. Its requests go
through `sourceFetch` like every other call to an app. Proposals (`sources/handbook.ts`,
`proposeHandbookChange`) create a change set, apply the edits or the new
page, and submit it.

## Directory

- **People** (`people/lifecycle.ts`): every change to a person's
  lifecycle, whoever makes it: blocking (`setBlocked`; the directory's
  through `setDirectoryActive`, which writes the audit log), address
  changes (`changeEmail`: admin rights from `ADMIN_EMAILS` stay with the
  address), `ADMIN_EMAILS` at sign-in and removal (`removePerson`).
- **Sign-in** (`auth/sign-in.ts`): stores the groups of every sign-in
  (claim or Keycloak Admin API) and checks `ACCESS_GROUPS`.
- **Keycloak sync** (`directory/sync.ts`): all users and groups of the
  realm into `users`, `groups` and `group_members` in one transaction under
  an advisory lock; `setDirectoryActive` blocks and unblocks.
- **SCIM** (`scim/`): the RFC 7644 subset identity systems use, with a SCIM
  token; `active` maps to `setDirectoryActive`, delete to `removePerson`.

## Agents

### OAuth server

`oauth/`: protected resource and authorization server metadata, dynamic
client registration and client ID metadata documents (fetched with SSRF
protection), authorization code with PKCE (S256) and `resource`, a consent
screen in the web app (`/oauth/consent`), rotating refresh tokens with
reuse detection, revocation, rate limits per client address.

### MCP server

`mcp/`: stateless Streamable HTTP; a new server per POST, JSON answers.
Bearer tokens only (personal tokens, OAuth access tokens, service tokens);
without one, 401 with the protected resource metadata. Tools
(`mcp/tools.ts`) call the REST API in-process with the caller's
`Authorization` header (`mcp/client.ts`), so access rules exist once.

## REST API

Under `/api/v1`, JSON, contracts in `packages/shared/src/api/`:

- Everyone: `GET /me`, `GET /sources`, `GET /search`, `GET /items/<id>`,
  `POST /context`, `GET /recent`, `GET /people`, `POST /proposals`,
  `POST /knowledge/search`, tokens, connected apps, `GET|POST|DELETE
/links…`.
- Admins: `/admin/sources…` (with `/check` and `/webhook-secret`),
  `/admin/people…`, `/admin/groups…`, `/admin/directory` (and `/sync`),
  `/admin/service-tokens…`, `/admin/scim-tokens…`, `/admin/audit`,
  `/admin/activity`, `/admin/status`.
- People in the web app only (no tokens or agents): `GET /about`, the
  version that runs (`APP_VERSION`, the commit of the image).

Errors are `{ error: { code, message, fields? } }`. Browser requests that
change something need the app's origin; bearer requests are exempt.

## Web app

`apps/web`: Vite, React 19, TanStack Router and Query, Tailwind CSS 4.
`src/components/ui/` holds the theme with ProjectTogether's colors
(`styles.css`), the shadcn/ui components, the app frame, the page layout,
the page states, the sign-in page, the confirm dialog, the copy button, the
secret input and the pager; `src/components/brand.tsx` the app icon and
ProjectTogether's logo. `components/layout/app-layout.tsx` fills the frame
(`AppFrame`): the navigation of `app/navigation.ts`, its breadcrumbs
(`breadcrumbsFor`), and the search through `GET /search` (`findItems`;
results open in their app). Modules under `src/modules/<area>`: home,
search, context, people, connect, settings (with the version that runs, in
**About**), admin (status and setup guides, sources, people, directory,
service tokens, activity, audit), OAuth consent.
