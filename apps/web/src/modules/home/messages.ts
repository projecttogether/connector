import { defineMessages } from "@/i18n";

export const messages = defineMessages({
  en: {
    greeting: "Hello, {name}",
    description: "Find what your organization knows across its apps, and connect your AI agents to it.",
    search: "Search all your apps",
    searchPlaceholder: "What are you looking for?",
    submit: "Search",
    sourcesTitle: "Your sources",
    sourcesDescription: "The apps you may search. Each one stays the home of its content.",
    noSources: "No sources you may use yet",
    noSourcesHint: "An admin connects the organization's apps under Administration → Sources.",
    live: "Asked live",
    webhook: "Sent by the app",
    link: "Link your account",
    linked: "Account linked",
    linkHint: "Agents then see your drafts there and can propose changes as you.",
    recentTitle: "Changed this week",
    recentEmpty: "Nothing changed in the last 7 days.",
    connectTitle: "Connect your AI",
    connectText:
      "Claude, ChatGPT, Le Chat and other assistants can use these sources through one connection. They see only what you may see.",
    connectAction: "Connect an agent",
  },
});
