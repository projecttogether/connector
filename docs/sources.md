# Sources

A source is one connected app. Admins connect sources with a setup guide
per app (**Administration → Status**, or **Connect a source** under
**Administration → Sources**); each has a kind, an address, credentials,
and the people who may use it. On the server, `cli settings apply sources`
does the same without a browser
([Settings from the command line](deployment.md#settings-from-the-command-line)).

| Kind              | Holds                                                      | How Connector reads it                                                |
| ----------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| Handbook          | Policies, guides, playbooks                                | Live, through its API (service token, or the person's linked account) |
| Logbook           | Decisions, updates, learnings                              | Its webhook; Connector keeps a search index                           |
| Library           | Studies, reports, articles with source notes               | Its webhook; Connector keeps a search index                           |
| CRM               | Contacts, organizations, deals, events, meetings, segments | Live, through its API (API key)                                       |
| Notion            | Pages of the databases an admin chose                      | Live, through its API (integration secret)                            |
| IT Knowledge Base | Tools, access, devices, security, onboarding, IT policies  | Its webhook after each build; Connector keeps a search index          |

Live sources answer at every request, so nothing is copied and nothing
gets stale. Webhook sources send each published item and each change;
Connector stores the item as sent, replaces it on every change, deletes it
when the app removes it, and deletes everything of a source when the source
is removed.

Items have IDs of the form `<source slug>:<type>:<id in the app>`, e.g.
`logbook:decision:0196…`. Every item links back to its page in the app.

## Who may use a source

- **Everyone signed in**, or only members of the groups listed under
  _Access groups_ (Keycloak paths count their subgroups: `/staff` admits
  `/staff/it`; the IT Knowledge Base admits only members of a group itself,
  as its site does). Groups come from the sign-in, the Keycloak directory and
  SCIM ([Identity and access](identity-and-access.md)).
- **Service tokens** (bots such as the Support Agent) read a source only
  when _Service tokens may read_ is on, and then only content meant for
  everyone who may use it.
- Each app's own rules apply on top; see each kind below.
- Admins see sources in the admin pages, but search them only when they
  are in the access groups themselves.

Make the access groups match who may use the app itself. A service token or
API key sees more than a single person might; Connector shows its results
only to the people the source is open to.

## Setup guides and status

Each app has a guide at **Administration → Status**: where the app is, the
credentials to create there (with a link to the right page of the app),
who may use the source, and then a test (Handbook, CRM, Notion) or a wait for the
first delivery (Logbook, Library, IT Knowledge Base) that turns green on its own. The guides
for IAM and the Support Agent create their token, show it once,
list the exact fields to enter in that app, and wait for its first request.

**Administration → Status** shows every source with its state, refreshed
every 30 seconds:

| State                      | Meaning                                                                           |
| -------------------------- | --------------------------------------------------------------------------------- |
| Working                    | The last check or delivery worked.                                                |
| Failing                    | The last check or delivery failed, or the latest reads of agents and bots failed. |
| Waiting for first delivery | A webhook source that has not delivered yet.                                      |
| Needs setup                | A credential is missing, or Connector cannot read it (`ENCRYPTION_KEY` changed).  |
| Not checked yet            | A live source nobody checked yet.                                                 |
| Off                        | Turned off.                                                                       |

People see the same state of the sources they may use on their home page,
and agents in `list_sources`; only admins see what needs fixing.

Above them, **Needs attention** lists what needs an admin, with a link to
fix each: failing sources, a stopped worker or Keycloak sync, failed SCIM
requests, service and SCIM tokens that expire within 14 days, expired or
revoked tokens that a bot or IAM still sends, and people whose Keycloak
address another person has. The worker checks the live sources every
`SOURCE_CHECK_MINUTES` (15), so a refused token or an app that is down
shows up without anyone searching. Failed requests count from the activity
log (agents and bots; searches in the browser are not recorded).

## Source order

When sources disagree, the higher level wins. Every result carries its
level; agents get the order in the MCP instructions.

1. **Purpose and rules**: Handbook pages in the spaces listed as _rule
   spaces_, and IT Knowledge Base pages in its _rule sections_.
2. **Decisions in force**: Logbook decisions that no newer decision
   replaced; the newest wins.
3. **Knowledge base**: other Handbook pages and IT Knowledge Base pages.
4. **Logbook history**: updates, learnings, and decisions that are no longer
   in force.
5. **Records**: CRM records.
6. **Library**: notes about outside sources.

Notion pages take the level an admin chose for their database: knowledge
base, Logbook history, records or library (never purpose and rules or
decisions in force).

Search merges each source's best results first and lets the higher level
win within a round. `get_context` groups a topic by level and adds hints:
a decision newer than a page on the same topic, and decisions replaced by
another.

## Handbook

The guide **Connect Handbook** walks through these steps:

1. Handbook's public address (its `APP_URL`; linked accounts need it).
2. In Handbook, create a service token under **Administration → Service
   tokens** (it reads every page that is not a draft) and paste it.
3. Set _Access groups_ to the groups that may sign in to Handbook
   (Handbook's `ACCESS_GROUPS`), or leave it empty when everyone may.
4. **Connect and test** saves the source and reads Handbook's spaces.
5. Tick the spaces that hold the purpose and the rules: they become the
   _rule spaces_.

### Linked accounts

With _People may link their Handbook account_ on (the default), people
link their account under **Settings → Linked accounts**. Connector then
reads Handbook as that person (Handbook shows editors their drafts, as in
the browser) and agents can propose changes as that person
(`propose_handbook_change`): Connector starts a change set in the page's
space, makes the change, and submits it for review. Editors merge it in
Handbook; nothing goes live from Connector.

Linking uses Handbook's OAuth server the way MCP clients do: protected
resource metadata, authorization server metadata, dynamic client
registration (Connector registers itself once, as "Connector", or
`<APP_NAME> (Connector)` with another `APP_NAME`),
authorization code with PKCE and the
resource indicator. The redirect address is
`<APP_URL>/api/v1/links/callback`; Handbook accepts it when Connector runs
on https (or on localhost). Handbook's sign-in server must be on the
source's address; Connector refuses others, because its client secret and
the tokens go there. Changing a source's address to another host removes
its stored credentials and the linked accounts. Tokens are stored encrypted; Connector
refreshes them, and removes the link when Handbook ends it (the person
links again). Unlinking revokes the tokens at Handbook.

## Logbook

1. In the guide **Connect Logbook**, enter Logbook's address
   (for links) and who may use it, and choose **Connect**. Connector
   generates the webhook secret and shows the URL
   `<APP_URL>/hooks/<slug>` and the secret once.
2. In Logbook, open **Admin › Integrations**, enter both under **Webhook**
   (_URL_ and _Signing secret_), and choose **Save webhook**. No restart.
   On the server instead, pipe
   `{"url": "<APP_URL>/hooks/<slug>", "secret": "<secret>"}` into
   `docker compose run --rm -T migrate cli settings apply webhook` in
   Logbook's folder, or run `cli settings apply webhook` in a terminal of
   Logbook's `web` container, paste the body (it is not shown) and press
   Ctrl-D.
3. Logbook sends every entry within a few minutes of the save, then each
   change within a minute. The guide waits and turns green at the first
   delivery, or says why a delivery was refused (e.g. another secret).

Logbook up to 0.3.2 has no **Admin › Integrations**: add both values to its
`.env` as `WEBHOOK_URL` and `WEBHOOK_SECRET` and restart it. It then sends
every entry in its first nightly run (02:30). Newer versions copy the two
variables into their database once.

Logbook sends published updates, learnings and logged decisions, and
decided or rejected proposals; never drafts or open proposals. Everyone
with access to Logbook reads every entry, so Connector shows them to
everyone the source is open to: set _Access groups_ to Logbook's access
group. Decisions carry _in force_, _superseded by LB-…_ or _rejected_.

## Library

1. Connect [Library](https://github.com/projecttogether/library) with the guide
   **Connect Library** as for Logbook:
   in Library, both values go under **Admin → Integrations → Webhook**
   (_URL_, _Signing secret_, then **Save**), or into
   `cli settings apply webhook` with the same body. Library sends each
   change within a minute, and every note in its first nightly run (02:30).
   Library up to 0.3.2 reads `WEBHOOK_URL` and `WEBHOOK_SECRET` from its
   `.env` instead and needs a restart; newer versions copy them once.
2. Notes for everyone are shown to everyone the source is open to. **Team
   notes** are shown only to the team: to members of the Keycloak group the
   note names (Library with `DIRECTORY=keycloak`, Connector with
   `DIRECTORY=keycloak`), or to members of `<team group prefix>/<team
name>` when a _team group prefix_ is set (e.g. `/teams` for
   `/teams/Programs`). Without either, nobody sees team notes in Connector.

Library removes a note from Connector when it is unpublished, made private
or deleted.

## CRM

1. In the CRM, an admin creates an API key under **Administration → API
   keys**: role viewer, the `:read` scopes of the record types to search
   (and `activities:read` for the timeline). A key sees the records shared
   with it or with the whole organization, plus its own.
2. Share with the key what everyone who may use the source may see, and
   set _Access groups_ accordingly (e.g. the fundraising team).
3. In Connector, the guide **Connect CRM** asks for the CRM's
   address, the key and the record types to search, and tests them.

Connector does not use CRM webhooks: their payloads skip the CRM's sharing
rules.

## Notion

One Notion source searches several databases of a workspace, up to 10,
each at its own level in the source order. Connect another Notion source
for databases that other groups may use.

1. In Notion, a workspace owner opens
   [Integrations](https://www.notion.so/profile/integrations) and creates
   one: name _Connector_, the workspace, type _Internal_. Under
   _Capabilities_ it needs only _Read content_ (add _Read user information
   without email addresses_ to show people's names). Copy the _Internal
   integration secret_.
2. Share each database with the integration: in the integration's
   **Access** tab (**Edit access**), or in the database's **•••** menu under
   **Connections**.
3. In Connector, the guide **Connect Notion** asks for the workspace's
   address (results link to their pages; `https://www.notion.so` by
   default), the secret and the databases: each database's link (**•••** →
   **Copy link**) or ID, and its level: _Knowledge base_ (the default) for
   wikis and guides, _Logbook history_ for meeting notes and project logs,
   _Records_ for lists of people, partners or projects, _Library_ for notes
   about outside sources. **Connect and test** reads every database and
   names them; a database that is not shared with the integration fails
   the test with its ID.

Connector shows only pages of these databases, even when the integration
sees more: pages in other databases, pages inside a database's page and
pages in the trash are not found. Notion's own sharing does not reach
Connector (one integration reads for everyone), so set _Access groups_ to
who may read the databases in Notion.

Notion's API cannot search the text of pages. Connector asks each
database's tables (data sources) for pages whose title or text properties
contain every search word; common words such as "the" do not count, and
"quoted phrases" stay whole. Pages whose title matches come first, then the
latest edits. Reading a page gives its properties and its content as
Markdown (Notion's tags for callouts, toggles, columns, styled tables,
mentions and dates become plain text and links); recent changes are the
pages edited since the date. A status property becomes the result's
status.

Notion allows about three table queries a second per integration, so a
search asks three tables at once and the rest a third of a second apart: a
long list of databases makes searches slower. A database that does not
answer in time is left out; the source fails only when none answers.
Connector keeps the databases' tables and property names, never pages, in
memory for five minutes; any change to the source reads them again.

## IT Knowledge Base

The IT Knowledge Base is a site of Markdown pages whose build makes a
memory export: every page with its chunks, its status and the Keycloak
groups that may read it. After each build of its main branch, its CI sends
the export to Connector's webhook.

1. In the guide **Connect the IT Knowledge Base**, enter the site's address,
   who may use it (the group that may read the site) and the _rule
   sections_, and choose **Connect**. Connector generates the webhook secret
   and shows the URL `<APP_URL>/hooks/<slug>` and the secret once.
2. In the knowledge base's repository on GitHub, add both as Actions
   secrets: `CONNECTOR_WEBHOOK_URL` and `CONNECTOR_WEBHOOK_SECRET`.
3. The next build of the main branch sends every page (run the CI workflow
   on main again to send now). The guide turns green at the first delivery.

Connector shows each page to whom the site shows it:

- a public page to everyone who may use the source;
- every other page only to members of one of the page's groups (the site's
  `allowed_groups`), compared exactly, as the site does: a subgroup does not
  count;
- service tokens (bots such as the Support Agent), when the source is open
  to them, read what is meant for everyone the source is open to: the
  public pages and the pages meant for all of the source's access groups
  (with the site's staff group as the one access group, every staff page).
  In a source open to the staff group, pages for other groups, such as the
  IT or HR operators' pages, stay with their members; with several access
  groups, bots read only pages meant for all of them.

Group names count from wherever Connector knows them (sign-in, the Keycloak
directory, SCIM, groups made here), as for every source: name no group here
like one of the site's groups unless the same people belong to it. Unlike
other sources, the access groups admit only their direct members, as the
site's sign-in does: a subgroup of the staff group does not count.

Pages the knowledge base marks as not meant for answers
(`agent_can_answer: false`) are not kept. Deprecated pages carry the status
_deprecated_, pages of draft confidence _draft guidance_. Pages in a _rule
section_ (the page's folder in the knowledge base's repository, `docs/<section>/`; `policies` by default) rank
with purpose and rules unless deprecated; all others rank as knowledge
base. The rule sections are read at every search, so a change applies at
once. The export's German search terms are searched too.

### The webhook

Each delivery is a `POST` of JSON to `<APP_URL>/hooks/<slug>` with the
headers `itkb-timestamp` (Unix seconds) and `itkb-signature`
(`sha256=<hex HMAC-SHA256 of "<timestamp>.<body>" with the secret>`), as
for Logbook and Library. Connector refuses timestamps more than five
minutes off.

- `page.changed`: `{ "event": "page.changed", "page": <page record of the
export>, "chunks": [{ "text": … }, …] }`, the page's chunks in order.
  Connector replaces the page.
- `export.completed`: `{ "event": "export.completed", "source_version":
"<commit>", "page_ids": [<every page of the export>] }`, sent after all
  pages. Connector removes the pages it no longer lists.

The page record has `id`, `title`, `description`, `search_terms`,
`page_type`, `status`, `visibility`, `allowed_groups`, `last_updated`,
`source_path`, `rendered_url` and `agent` (`confidence`, `can_answer`,
`escalation`); other fields are ignored.

## Support Agent (a bot that reads)

The [Support Agent](https://github.com/projecttogether/support-agent)
answers questions in Slack from knowledge sources. One Connector service
token gives it every source opened to service tokens. The guide
**Connect the Support Agent** does the Connector side
and lists the Support Agent's fields:

1. Choose the sources the bot may read (_Bots may read it_).
2. Create a service token; it is shown once.
3. In the Support Agent, **Knowledge sources → Add knowledge source**:
   - Search URL: `<APP_URL>/api/v1/knowledge/search`
   - Authentication: Bearer token, the service token
   - JSON body: the standard body
     (`{"query": "{{query}}", "limit": "{{limit}}"}`)
   - Response mapping: list of results `results`, title `title`, URL `url`,
     text `text`, section `section` (Section is empty by default there)
4. The guide turns green at the bot's first search.

Anything the bot gets can reach everyone in its channels, so open only
sources meant for all of them.

## IAM (people and groups)

[IAM](https://github.com/projecttogether/iam) provisions people and fills groups through SCIM 2.0
([Identity and access](identity-and-access.md#scim-20)). The guide
**Connect IAM** creates the groups IAM should fill (IAM imports
groups and does not create them), creates a SCIM token, lists IAM's fields
(**Admin → Connections → Add connection → SCIM 2.0 app**: SCIM base URL
`<APP_URL>/scim/v2`, the bearer token, user name _Work email_, when access
ends _Deactivate the user_, manage groups on) and waits for IAM's first
request.

## Apps without an interface yet

[Helpdesk](https://github.com/projecttogether/helpdesk) and the
Reimbursement Portal have no interface for other servers (no API tokens,
webhooks or MCP server), so Connector cannot read them yet.
