# User guide

Connector brings together what your organization keeps in its Handbook,
Logbook, Library, CRM, Notion and IT Knowledge Base, for you and for your AI assistant. You see only
what you may see in each app.

## Searching

**Search** at the top of the sidebar (Ctrl+K or ⌘K, or `/`) finds items
as you type; a result opens in its app, in a new tab. **Show all results**
there, the search box on the overview and **Search** in the sidebar lead to
the search page. It asks every source you may use at once and shows:

- each result's source, type (page, decision, note, contact, …) and date;
- its level in the **source order**, which decides when sources disagree:
  purpose and rules first, then decisions in force, the knowledge base, the
  logbook's history, records, and the library;
- its status, e.g. a decision that is _in force_ or _superseded by LB-14_.

Open a result in its app, or **Preview** it here. Filter by source with the
chips above the results. When a source does not answer, the page says so.

**Keys:** G then O opens the overview, G then S the search page, G then C
Context, G then P People and G then A how to connect an agent. Ctrl+/ lists
every shortcut. Shortcuts with single letters can be turned off under
**Settings**, which also has the appearance (light, dark or the device's
setting) and, under **About**, the version that runs (its commit).

## Context

**Context** shows everything on a topic, grouped by the source order, with
hints: a decision newer than a Handbook page on the same topic, or a
decision replaced by another. This is what your AI assistant gets when it
asks Connector for context.

## People

**People** finds colleagues by name, email address, job title or group.

## Connecting your AI

**Connect your AI** shows Connector's MCP address and the steps for Claude,
ChatGPT, Le Chat and other assistants. You approve the connection once.
Your assistant then works as you: it sees what you see, cites the source of
every claim, and can propose Handbook changes for you to review in
Handbook. Remove a connection under **Settings → Connected apps**.

Scripts and command-line agents can use a **personal token**
(**Settings → Personal tokens**).

## Linked accounts

Under **Settings → Linked accounts**, link your Handbook account. Connector
then reads Handbook as you (you see your drafts, if you edit a space) and
your assistant can propose changes in your name. Unlink any time.

## Your groups

**Settings** lists your groups. They decide which sources you may use; ask
an admin if a source is missing.

## Admins

- **Status**: what needs an admin (failing sources, tokens that expire or
  were revoked but are still sent, a stopped sync), every source's state,
  the directory, and how much agents and bots use Connector. Each app has
  a setup guide here: Handbook, Logbook, Library, CRM, Notion, the IT Knowledge Base, IAM and
  the Support Agent ([Sources](sources.md#setup-guides-and-status)).
- **Sources**: connect Handbook, Logbook, Library, CRM, Notion and the IT Knowledge Base, decide who may
  use them, check them ([Sources](sources.md)).
- **People**: admins, blocking, removal.
- **Directory**: the Keycloak sync, SCIM tokens for IAM, groups.
- **Service tokens**: bots such as the Support Agent.
- **Activity**: what agents and bots asked. **Audit log**: admin changes.
