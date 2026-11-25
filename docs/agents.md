# Agents and MCP

Connector is an MCP server for AI agents: one connection reaches every
source the person may use. Agents act as their person: they see what the
person sees, never more, and never act as admins.

The MCP address is `<APP_URL>/mcp` (Streamable HTTP; shown under
**Connect your AI**).

## Connecting

- **Claude** (claude.ai, desktop): Settings → Connectors → Add custom
  connector → paste the address. Claude signs in with OAuth.
- **ChatGPT**: Settings → Apps & Connectors → Advanced settings → turn on
  developer mode, then Create → paste the address, authentication OAuth.
  `search` and `fetch` follow ChatGPT's company knowledge format, so
  ChatGPT can cite Connector items in deep research.
- **Le Chat (Mistral)**: Intelligence → Connectors → Add connector → Custom
  MCP connector → paste the address; Le Chat signs in with OAuth.
- **Other MCP clients and scripts** (Claude Code, Codex, MCP inspectors):
  use OAuth if the client supports it, else a personal token from
  **Settings → Personal tokens** as `Authorization: Bearer cn_pat_…`.

In an organization account (Claude Team or Enterprise, ChatGPT Business,
Le Chat Team), an owner may have to add the connector for everyone first.

The person approves the connection once on Connector's consent screen.
Connected apps are listed under **Settings → Connected apps**; removing one
ends its access at once.

## Tools

| Tool                      | Does                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_context`             | Everything the sources hold on a topic, grouped by the source order, with notes on conflicts and sources that did not answer. Agents should start here. |
| `search`                  | Searches every source at once; results with `id`, `title`, `url`, `text`, source, type, level, date, status.                                            |
| `fetch`                   | One item in full by its `id`: `id`, `title`, `text`, `url`, `metadata` (source, type, level, status, date, related items).                              |
| `recent_changes`          | What changed in the last days, newest first.                                                                                                            |
| `list_sources`            | The sources the person may use, how each is doing (`state`, as on the status page), and the source order.                                               |
| `find_people`             | Colleagues by name, email address, title or group.                                                                                                      |
| `propose_handbook_change` | Proposes a Handbook change as the person (exact text replacements or a new page) and submits it for review. Needs a linked Handbook account.            |

All tools but `propose_handbook_change` are read-only (`readOnlyHint`).
Every tool calls Connector's REST API as the caller, so the same rules
apply to the web app, the API and MCP.

The MCP instructions tell agents the source order, to cite the item URLs,
to say when something is missing, and that people publish what agents
draft.

## Bots (service tokens)

Bots without a person, such as the
[Support Agent](https://github.com/projecttogether/support-agent), use a service
token (`cn_svc_…`, **Administration → Service tokens**, or on the
[command line](deployment.md#tokens)). They read only
sources opened to service tokens, and only content meant for everyone there
(no team notes); they cannot look up people or propose changes.

The knowledge API follows the Support Agent's knowledge source contract:

```http
POST /api/v1/knowledge/search
Authorization: Bearer cn_svc_…
Content-Type: application/json

{ "query": "how do I book travel", "limit": 6 }
```

```json
{
  "results": [
    {
      "title": "Travel policy",
      "url": "https://handbook.example.org/s/policies/travel",
      "text": "The whole item, up to 4,000 characters…",
      "section": "Handbook"
    }
  ]
}
```

Results are ordered best first. Bots may also use the MCP server and the
REST API (`GET /api/v1/search`, `GET /api/v1/items/<id>`,
`POST /api/v1/context`) with the same token.

## OAuth details

Connector runs its own OAuth 2.1 authorization server for MCP clients:

- Protected resource metadata at
  `/.well-known/oauth-protected-resource/mcp`; a request to `/mcp` without
  a token answers 401 with `WWW-Authenticate: Bearer resource_metadata=…`.
- Authorization server metadata at
  `/.well-known/oauth-authorization-server`.
- Clients register with dynamic client registration (`/oauth/register`) or
  a client ID metadata document (an https `client_id`); PKCE (S256) is
  required; the `resource` must be `<APP_URL>/mcp` or `<APP_URL>`.
- Access tokens (`cn_at_`) last `OAUTH_ACCESS_TOKEN_MINUTES`; refresh
  tokens (`cn_rt_`) rotate on every use, and a reused one ends the whole
  connection.
- Tokens stop working when their person is blocked, removed, deactivated
  by the directory, or has not signed in for `AGENT_SIGN_IN_DAYS`.

## Oversight

**Administration → Activity** lists what agents, personal tokens and bots
asked: who, through which app, which tool, the search words, how many
results, and how each source answered. It never stores the results.
Searches in the web app are not listed. `ACTIVITY_LOG_DAYS` sets how long
entries stay (default 90; 0 keeps none). When an admin removes a person,
their entries stay as “Removed person”, without their name, email address
or token names ([Identity and access](identity-and-access.md#roles)).

## Safety

- Content from sources is data, not instructions; a page or note could
  still try to steer an agent. Agents should cite and let people decide.
- Proposals go through Handbook's review; Connector never publishes.
- Give each agent the least it needs: a person's agent sees what the
  person sees; open sources to service tokens only where everyone in the
  bot's audience may read them.
