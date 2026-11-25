import { defineMessages } from "@/i18n";

export const messages = defineMessages({
  en: {
    title: "Settings",
    description: "Your agents, linked accounts, groups and appearance.",
    about: "Connector is ProjectTogether's open-source memory layer for AI agents.",

    agentsTitle: "What agents may do",
    agentsText:
      "Agents act as you: they see only the sources and items you may see, and they propose Handbook changes for review instead of publishing them. Disconnect them here at any time.",
    connectLink: "How to connect an agent",

    linksTitle: "Linked accounts",
    linksDescription:
      "Link your account at a source so Connector reads there as you (your drafts too) and agents can propose changes in your name.",
    noLinkable: "No source takes linked accounts.",
    link: "Link",
    unlink: "Unlink",
    linkedAs: "Linked as {label}",
    linkedSince: "Linked",
    notLinked: "Not linked",
    unlinkTitle: "Unlink your {name} account?",
    unlinkDescription:
      "Connector then reads there with its shared access, and agents can no longer propose changes as you.",
    unlinked: "Account unlinked",
    linkedDone: "Your {name} account is linked",
    linkFailed: "Linking failed: {message}",

    groupsTitle: "Your groups",
    groupsDescription: "From your sign-in and the directory. Admins open sources to groups.",
    noGroups: "You are in no groups.",

    tokensTitle: "Personal tokens",
    tokensDescription:
      "For agents and scripts that cannot sign in themselves. A token acts as you, with the same limits as connected apps.",
    newToken: "New token",
    createTokenTitle: "New personal token",
    createTokenDescription: "The agent that uses it acts as you: it reads every space and suggests changes.",
    tokenNameHint: "Name it after the agent or script that uses it, e.g. “Claude Code on my laptop”.",
    tokenCreated: "Token created",
    noTokens: "No personal tokens.",
    colName: "Name",
    colToken: "Token",
    colCreated: "Created",
    colLastUsed: "Last used",
    colExpires: "Expires",
    never: "Never",
    notUsed: "Not used yet",
    revoke: "Revoke",
    revokeTitle: "Revoke “{name}”?",
    revokeDescription: "Agents and scripts that use it lose access at once.",
    revoked: "Token revoked",

    appsTitle: "Connected apps",
    appsDescription: "Apps you connected by signing in, such as Claude, ChatGPT or Le Chat.",
    noApps: "No connected apps.",
    colApp: "App",
    colRedirect: "Returns to",
    colConnected: "Connected",
    disconnect: "Disconnect",
    disconnectTitle: "Disconnect “{name}”?",
    disconnectDescription: "The app loses access at once. You can connect it again later.",
    disconnected: "App disconnected",
  },
});
