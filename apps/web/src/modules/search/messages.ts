import { defineMessages } from "@/i18n";

export const messages = defineMessages({
  en: {
    title: "Search",
    description: "Every connected app you may use, at once. Results link to the app that holds them.",
    query: "Search for",
    placeholder: "Words, or a reference such as LB-12",
    submit: "Search",
    sources: "Sources",
    allSources: "All sources",
    start: "Search all your apps",
    startHint:
      "Handbook pages, Logbook decisions, Library notes, CRM records, Notion pages and IT Knowledge Base pages, ordered by the source order.",
    noResults: "Nothing found",
    noResultsHint: "Try other words, or check that the sources answered.",
    results: "{count} results",
    results_one: "1 result",
    previewTitle: "Item",
    changed: "Last changed {date}",
    openInApp: "Open in {app}",
    facts: "Facts",
    related: "Related",
    noSources: "No sources yet",
    noSourcesHint: "An admin connects the organization's apps under Administration → Sources.",
  },
});
