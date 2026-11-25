import { defineMessages } from "@/i18n";

export const messages = defineMessages({
  en: {
    title: "Audit log",
    description:
      "Who connected or changed sources, changed admins, blocked people, managed groups, and created or revoked tokens; and what the directory (SCIM) changed. Entries never contain secrets.",
    empty: "No entries yet",
    emptyHint: "Changes by admins and owners appear here as they happen.",
    colWhen: "When",
    colWho: "Who",
    colWhat: "What",
    system: "System",
  },
});
