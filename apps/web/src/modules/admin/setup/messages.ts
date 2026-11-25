import { defineMessages } from "@/i18n";

export const messages = defineMessages({
  en: {
    title_handbook: "Connect Handbook",
    title_crm: "Connect CRM",
    title_logbook: "Connect Logbook",
    title_library: "Connect Library",
    title_iam: "Connect IAM",
    "title_support-agent": "Connect the Support Agent",
    editTitle: "Set up “{name}”",
    notFound: "This source does not exist anymore.",
    done: "Done",
    toStatus: "Back to the status",
    shownOnce: "Copy it now: Connector shows it only this once.",

    // Sources: where the app is.
    whereTitle: "Where is {app}?",
    whereDescription: "The address people open in their browser. Connector links every result there.",
    address: "Address",
    moreOptions: "Name and short name",
    name: "Name",
    nameHint: "What people and agents see.",
    slug: "Short name",
    slugHint: "Starts item IDs and the webhook address. Cannot change later.",
    description: "Description",
    descriptionHint: "Optional: what this source holds for your organization.",

    // Handbook and CRM: credentials.
    handbookTokenTitle: "Create a service token in Handbook",
    handbookTokenText:
      "In Handbook, open {link}, choose New service token, name it “Connector” and copy the token. It reads every space and changes nothing.",
    handbookTokenLink: "Administration → Service tokens",
    serviceToken: "Service token",
    crmKeyTitle: "Create an API key in the CRM",
    crmKeyText:
      "In the CRM, open {link} and choose Create API key. Name it “Connector”, pick the role Viewer and All read scopes, choose an expiry, and copy the key.",
    crmKeyLink: "Administration → API keys",
    crmKeySees: "The key sees the records that are shared with it or with the whole organization.",
    apiKey: "API key",
    types: "Record types to search",
    stored: "Stored ({hint}); leave blank to keep it.",

    // Access.
    accessTitle: "Who may use it",
    accessDescription: "Connector checks this before it asks the app; the app's own rules apply too.",
    accessGroups: "Groups",
    accessGroupsHint:
      "Comma-separated, e.g. /staff. Members and subgroups may use it. Empty: everyone signed in.",
    allowLinking: "People may link their Handbook account",
    allowLinkingHint: "Their agents then see their drafts and can propose changes in their name.",
    serviceAccess: "Bots may read it",
    serviceAccessHint: "Service tokens (e.g. the Support Agent) read the content meant for everyone.",
    teamGroupPrefix: "Team groups",
    teamGroupPrefixHint:
      "Team notes are shown to members of <prefix>/<team name>, e.g. /teams. Members of the Keycloak group a note names always see it.",

    // Test.
    testTitle: "Test the connection",
    testDescription: "Connector saves the source and asks {app} with these settings.",
    connectAndTest: "Connect and test",
    saveAndTest: "Save and test",
    testing: "Testing…",
    testOk: "Connected",
    testFailed: "{app} did not accept the connection",
    testFailedHint: "Fix the settings above and test again.",

    // Handbook rule spaces.
    ruleSpacesTitle: "Which spaces hold your purpose and rules?",
    ruleSpacesDescription:
      "Pages in these spaces rank first, above decisions. Leave all unticked if you have none.",
    ruleSpacesSave: "Save rule spaces",
    ruleSpacesSaved: "Rule spaces saved",
    noSpaces: "Handbook has no spaces yet.",
    missingSpace: "Not in Handbook anymore",

    // Webhook sources.
    connect: "Connect",
    connecting: "Connecting…",
    sendTitle: "Tell {app} where to send",
    sendText: "In {app}, open {link}, enter these two values under Webhook, and save. No restart.",
    sendLink: "Admin → Integrations",
    sendEnvironment:
      "{app} up to 0.3.2 has no such page: add them as WEBHOOK_URL and WEBHOOK_SECRET to its environment (for example the .env file next to its compose.yaml) and restart it.",
    fieldWebhookUrl: "URL",
    fieldSigningSecret: "Signing secret",
    sendStored:
      "A secret is stored ({hint}). If you don't have it anymore, generate a new one; it replaces the old one.",
    newSecret: "Generate a new secret",
    connectFirst: "Connect the source first.",
    waitTitle: "Wait for the first delivery",
    waiting: "Waiting for {app}…",
    waitingHint:
      "{app} sends something within a minute after it is published or changed, and everything in its first nightly run (02:30, server time) at the latest.",
    received: "{app} delivered",
    receivedText: "{message} · {items}",
    deliveryFailed: "{app}'s delivery was refused",

    // IAM.
    groupsTitle: "Create the groups IAM fills",
    groupsText:
      "IAM fills groups that exist here; it does not create them. Create the groups your access rules name, e.g. /staff or /teams/Programs, then import them in IAM.",
    groupsKeycloak:
      "The Keycloak sync is on: Keycloak's groups are here already, and IAM cannot change them.",
    groupsNone: "No groups yet.",
    groupsSome: "Groups here: {names}",
    groupName: "New group",
    addGroup: "Add group",
    groupAdded: "Group added",
    scimTokenTitle: "Create a SCIM token",
    scimTokenText:
      "IAM sends it with every request. It can manage people and groups, nothing else, and expires in a year.",
    scimTokenExisting:
      "{count} SCIM tokens exist. Connector shows a token only when it is created; create a new one if IAM needs it.",
    scimTokenExisting_one:
      "1 SCIM token exists. Connector shows a token only when it is created; create a new one if IAM needs it.",
    createScimToken: "Create SCIM token",
    token: "Token",
    iamTitle: "Add Connector in IAM",
    iamText: "In IAM, open {link}, choose SCIM 2.0 app and enter:",
    iamLink: "Admin → Connections → Add connection",
    iamAfter:
      "Save. On the connection's page, choose Test connection, then Import groups, and turn the connection on.",
    iamDeactivate:
      "Deactivate blocks the person here and stops their agents; Delete removes them from Connector with their tokens and links.",
    fieldName: "Name",
    fieldScimUrl: "SCIM base URL",
    fieldBearer: "Bearer token",
    fieldUserName: "User name",
    fieldAccessEnds: "When access ends",
    fieldManageGroups: "Manage groups",
    valueUserName: "Work email",
    valueAccessEnds: "Deactivate the user (active = false)",
    valueOn: "On",
    valueTokenAbove: "The token from step {step}",
    iamWaitTitle: "Wait for IAM",
    iamWaiting: "Waiting for IAM's first request…",
    iamWaitingHint: "Test connection in IAM sends one.",
    iamConnected: "IAM is connected",
    iamConnectedText: "Last request {when}",

    // Support Agent.
    botsTitle: "Choose what the bot may read",
    botsText:
      "Bots read only what is meant for everyone: no team notes, no drafts, and nothing of sources closed to bots.",
    botsNone: "Connect a source first.",
    botAccess: "{name}: bots may read it",
    serviceTokenTitle: "Create a service token",
    serviceTokenText:
      "The Support Agent sends it with every search. It reads the sources chosen above and expires in a year.",
    serviceTokenExisting:
      "{count} service tokens exist. Connector shows a token only when it is created; create a new one if the bot needs it.",
    serviceTokenExisting_one:
      "1 service token exists. Connector shows a token only when it is created; create a new one if the bot needs it.",
    createServiceToken: "Create service token",
    agentTitle: "Add Connector in the Support Agent",
    agentText: "In the Support Agent, open Knowledge sources, choose Add knowledge source and enter:",
    agentAfter: "Save, search for something under Test, and choose the agents that use it.",
    fieldSearchUrl: "Search URL",
    fieldAuth: "Authentication",
    fieldJsonBody: "JSON body",
    fieldResults: "List of results",
    fieldTitle: "Title",
    fieldUrl: "URL",
    fieldText: "Text",
    fieldSection: "Section",
    valueBearer: "Bearer token",
    valueStandardBody: "standard",
    agentWaitTitle: "Wait for the first search",
    agentWaiting: "Waiting for the Support Agent's first search…",
    agentWaitingHint: "A test search in the Support Agent counts.",
    agentConnected: "The Support Agent is connected",
    agentConnectedText: "Last search {when}",
  },
});
