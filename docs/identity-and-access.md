# Identity and access

People sign in through one OpenID Connect provider. Their groups decide
which sources they may use. Admins connect sources and manage people,
groups and tokens.

## Roles

| Who                                     | May                                                                                                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Everyone signed in                      | Search, read and get context from the sources open to them; look up colleagues; link their Handbook account; connect agents.                                                                 |
| Admin                                   | Also: connect sources and decide who may use them; people, groups, the directory; service and SCIM tokens; the audit and activity logs. Admins search a source only when it is open to them. |
| Agent (personal token or connected app) | Acts as its person: the same sources and items; proposes Handbook changes for review; never administers.                                                                                     |
| Service token                           | Bots such as the Support Agent: reads only sources opened to service tokens, and only content meant for everyone there.                                                                      |
| SCIM token                              | Identity systems such as IAM: people and groups at `/scim/v2`, nothing else.                                                                                                                 |
| Operator (`cli` on the server)          | Connects sources and manages service and SCIM tokens as an admin does ([Deployment](deployment.md#settings-from-the-command-line)); the audit log names the `operator`. Never over HTTP.     |

Admins come from `ADMIN_EMAILS` (always admins, also the way back in) or are
made admins by another admin under **Administration → People**. Admin rights
from `ADMIN_EMAILS` belong to the address: when the provider or the directory
changes it to one not in the list, they end. There,
admins can also block someone: blocked people cannot sign in, their sessions
end, and their personal tokens and connected apps are revoked for good
(unblocking does not bring them back).

Admins can also remove a person (**Remove** under **Administration →
People**), for example when someone leaves and asks for their data to be
deleted. Removal deletes:

- their name, email address, job title and picture: everywhere Connector
  shows them, they are now “Removed person”;
- their sign-ins, tokens, connected apps, linked accounts and group
  memberships;
- their email address from the audit log, which keeps their actions;
- their name, email address and personal token names from the activity
  log, which keeps what their agents asked under “Removed person”, so its
  counts and the status page stay right; their email address and full
  name also go from the search words of other people's agents (a one-word
  name stays there, since it is also an everyday word).

Their agents' own search words stay in the activity log until
`ACTIVITY_LOG_DAYS` ends them. If they sign in again, they start as a new
person. People in `ADMIN_EMAILS` cannot be removed, and nobody removes
themselves.

## Groups

A person's groups are the union of:

- the groups of their last sign-in (claim `OIDC_GROUPS_CLAIM`, default
  `groups`; with `DIRECTORY=keycloak` read from the Keycloak Admin API);
- their groups in the Keycloak directory (`DIRECTORY=keycloak`, synced every
  `DIRECTORY_SYNC_MINUTES`);
- groups that SCIM fills (e.g. IAM) or that admins create under
  **Administration → Directory**.

Access rules name groups by path or name. Keycloak paths count their
subgroups: `/staff` admits `/staff/it`. Case matters. People see their own
groups under **Settings**.

## Directory

The directory lists colleagues for `find_people` and the **People** page,
and keeps groups and deactivations current between sign-ins. It never
blocks people in `ADMIN_EMAILS`, and the audit log records whom it blocks
and unblocks.

### Keycloak (`DIRECTORY=keycloak`)

The worker reads every user with an email address and every group of the
realm through the Keycloak Admin API, every `DIRECTORY_SYNC_MINUTES` (15):
people appear before their first sign-in, groups and memberships follow
Keycloak, disabled or deleted users are blocked and their agents revoked;
enabled again, the directory lifts its own block (never an admin's). With
`ACCESS_GROUPS`, only members of those groups (and `ADMIN_EMAILS`) are
listed, and someone who leaves the groups is blocked at the next sync.

Give a client a service account: in the client, turn on _Service accounts
roles_ and assign the realm-management role `view-users` under _Service
account roles_. Keycloak 26.8.2 and later: also add the client scope
`kc-admin-api` under the client's _Client scopes_ as a _Default_ scope; the
Admin API refuses tokens without the audience it adds (HTTP 401), and an
upgrade of Keycloak does not add it. Connector uses the sign-in client unless
`KEYCLOAK_CLIENT_ID` and `KEYCLOAK_CLIENT_SECRET` name another one.
`OIDC_ISSUER` must be the realm URL (`…/realms/<realm>`).
**Administration → Directory** shows the last sync and has **Sync now**.

### SCIM 2.0

Identity systems provision people and groups at `<APP_URL>/scim/v2`
(RFC 7643 and 7644) with a SCIM token (`cn_scim_…`, **Administration →
Directory**):

- `Users`: list with `filter` (`userName`, `emails.value`, `externalId`,
  `id`, `active`, `displayName`; `eq`, joined by `and`) and paging
  (`startIndex`, `count` up to 200); get, create, replace, `PATCH`
  (`active`, `userName`, `emails`, `displayName`, `name`, `title`,
  `externalId`; path and value forms), delete.
- `Groups`: list (with `attributes=displayName` or
  `excludedAttributes=members` for lists without members; filters
  `displayName`, `externalId`, `members.value`), get, create, replace,
  `PATCH` (`add` and `remove` members, also `members[value eq "…"]`,
  `replace`), delete.
- `ServiceProviderConfig`, `ResourceTypes`, `Schemas`.

Creating a user whose email address exists (someone who signed in before)
takes that person over. Deleting a user removes the person as an admin
would: if the provider still lets them sign in, they come back as a new
person. So let the identity system deactivate people (`active: false`)
rather than delete them; IAM's _Deactivate the user_ does that. `active: false` blocks the person, ends their
sessions and revokes their agents; `true` lifts only the directory's block.
Deleting a person in `ADMIN_EMAILS` is refused (409). A new `userName`
keeps admin rights from `ADMIN_EMAILS` only if it is in `ADMIN_EMAILS` too.
Groups from Keycloak cannot be changed through SCIM.

**[IAM](https://github.com/projecttogether/iam):** the guide **Connect IAM** (**Administration →
Status**, or **Administration → Directory**) walks through it: create the
groups IAM should fill (IAM imports groups and does not create them),
create a SCIM token, and add Connector in IAM as a _SCIM 2.0 app_
connection with the SCIM address and token; the guide waits for IAM's
first request. Then map IAM teams and access profiles to the groups.

## Sign-in

Register a client at the provider (confidential, authorization code flow)
with this redirect URL:

```
<APP_URL>/api/auth/callback/oidc
```

and set `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`. The
provider must return the email address (scopes `openid email profile`) and
vouch for it (below). Use your organization's own provider, where people
cannot choose their address.

Examples of `OIDC_ISSUER`:

| Provider           | Issuer                                               |
| ------------------ | ---------------------------------------------------- |
| Keycloak           | `https://login.example.org/realms/<realm>`           |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| Google             | `https://accounts.google.com`                        |
| Authentik          | `https://auth.example.org/application/o/<slug>/`     |

### Verified email addresses

People are known by their email address: admins in `ADMIN_EMAILS` and
editors named before their first sign-in exist before they sign in, and
people who left keep their entry. So a sign-in counts only when the
provider vouches for the address: its claim `email_verified` must be `true`
(in the ID token, or in the userinfo response when the ID token has no
email address). Otherwise the sign-in is refused (the log says `sign-in
refused: email address not verified by the provider`), and the provider's
account is not linked to the person with that address.

Keycloak and Google send the claim (in Keycloak, mark addresses as verified
or let people verify them); with other providers, check that the ID token
or userinfo response has it. Microsoft Entra ID does not send it:
set `OIDC_REQUIRE_EMAIL_VERIFIED=false`. Then the app trusts every address
the provider returns, and anyone who can set an address there
(self-registration, an email attribute people may edit, guest or brokered
accounts) can sign in as the person with that address, an admin from
`ADMIN_EMAILS` included. Turn the check off only where the provider sets the
addresses and people cannot change them. With Entra ID, register the app
for your tenant only (the issuer with your tenant ID, as above) and admit
only your own staff with `ACCESS_GROUPS`. The server logs a warning at start
while the check is off.

## Who may sign in

By default everyone the provider lets through may sign in and use the
sources open to everyone; the server logs a warning at start. Two optional limits, checked at every
sign-in:

- `ALLOWED_EMAIL_DOMAINS=example.org,example.net`: only these domains.
- `ACCESS_GROUPS=/staff`: only members of one of these groups. The groups
  come from the claim `OIDC_GROUPS_CLAIM` (default `groups`) of the ID
  token, or of the userinfo endpoint when the ID token has none. Keycloak
  group paths count their subgroups: `/staff` admits `/staff/it`.

People refused at sign-in see "This account has no access"; the log says
why. Admins in `ADMIN_EMAILS` are never refused.

### Keycloak

1. Create a client (`Client authentication` on, standard flow) with the
   redirect URL above and the web origin `APP_URL`.
2. For groups (access rules, `ACCESS_GROUPS`): add a mapper "Group
   Membership" to the client's dedicated scope with claim name `groups`,
   "Full group path" on, and "Add to ID token" on. Then use group paths,
   e.g. `/staff`.
3. For the directory (`DIRECTORY=keycloak`): the service account above.

### Microsoft Entra ID

Register an app with the redirect URL above (platform Web) and a client
secret. For `ACCESS_GROUPS`, add the groups claim in **Token configuration**
(the claim then holds group object IDs; use those in `ACCESS_GROUPS`).

## Sessions

A session lasts `SESSION_DAYS` (7) from sign-in; using the app does not
extend it. Then the person signs in again (with the provider's own session,
often without typing anything), and every sign-in checks access again:
blocked, verified address, email domain and groups, and stores the groups.

## Agents

Agents act as a person through a connected app (OAuth) or a personal token,
with the limits above. See [Agents and MCP](agents.md).

The provider is asked only at sign-in, so agents work only while their
person keeps signing in: when someone has not signed in for
`AGENT_SIGN_IN_DAYS` (30), their personal tokens and connected apps stop
working. Agents then get a 401 with "Sign in to … again"; signing in to the
web app brings them back. `AGENT_SIGN_IN_DAYS=0` turns this off.

Service and SCIM tokens belong to the installation, not to a person: they
keep working when the admin who created them leaves or is blocked. The
token lists show who created each one.

## When someone leaves

- **Block them** under **Administration → People** for immediate effect:
  their sessions end, sign-in is refused, and their personal tokens and
  connected apps are revoked for good. The Keycloak directory and SCIM do
  the same when the identity system deactivates them.
- **Otherwise**, once the provider no longer lets them in (account disabled,
  removed from `ACCESS_GROUPS`), they cannot sign in again: their open
  sessions end within `SESSION_DAYS` of their last sign-in, and their agents
  stop within `AGENT_SIGN_IN_DAYS` of it.
- **Admins:** revoke and replace the service and SCIM tokens they created,
  and rotate source credentials they saw (Handbook service tokens, CRM API
  keys, Notion integration secrets, webhook secrets).
