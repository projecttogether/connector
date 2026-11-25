import { defineMessages } from "@/i18n";

export const navMessages = defineMessages({
  en: {
    find: "Find",
    overview: "Overview",
    search: "Search",
    context: "Context",
    people: "People",
    agents: "AI agents",
    connect: "Connect an agent",
    admin: "Administration",
    status: "Status",
    sources: "Sources",
    adminPeople: "People",
    directory: "Directory",
    serviceTokens: "Service tokens",
    activity: "Activity",
    audit: "Audit log",
  },
});

export type NavKey = keyof typeof navMessages.en;
/**
 * `shortcut`: "G then this letter" opens the page (main pages only, each
 * letter once). `exact` and `match` as in the frame's `NavItem`.
 */
export type NavItem = { key: NavKey; to: string; shortcut?: string; exact?: boolean; match?: string[] };
export type NavGroup = { key: NavKey; items: NavItem[]; adminOnly: boolean };

/**
 * The sidebar, as text. The search sits above it in the frame; Search stays
 * a page of its own, with the source filters and previews. The server
 * checks access too.
 */
export const NAVIGATION: NavGroup[] = [
  {
    key: "find",
    adminOnly: false,
    items: [
      { key: "overview", to: "/", shortcut: "o" },
      { key: "search", to: "/search", shortcut: "s" },
      { key: "context", to: "/context", shortcut: "c" },
      { key: "people", to: "/people", shortcut: "p" },
    ],
  },
  {
    key: "agents",
    adminOnly: false,
    items: [{ key: "connect", to: "/connect", shortcut: "a" }],
  },
  {
    key: "admin",
    adminOnly: true,
    items: [
      // The admin start page; the setup guides belong to it.
      { key: "status", to: "/admin", exact: true, match: ["/admin/setup"] },
      { key: "sources", to: "/admin/sources" },
      { key: "adminPeople", to: "/admin/people" },
      { key: "directory", to: "/admin/directory" },
      { key: "serviceTokens", to: "/admin/service-tokens" },
      { key: "activity", to: "/admin/activity" },
      { key: "audit", to: "/admin/audit" },
    ],
  },
];

export type Crumb = { label: string; href?: string };

export type CrumbLabels = {
  /** The admin section, before the admin pages other than Status: "Administration". */
  admin: string;
  settings: string;
  /** The title of a setup guide, e.g. "Connect Logbook"; undefined for an unknown app. */
  setup: (app: string) => string | undefined;
};

const ADMIN = "/admin";

/**
 * Where a page sits: its sidebar item, after "Administration" for admin
 * pages other than Status (so its People differs from the other), and a
 * setup guide after Status. `items` are the sidebar items the person sees, so a page they
 * may not open has none.
 */
export function breadcrumbsFor(
  pathname: string,
  context: { items: { label: string; href: string }[]; labels: CrumbLabels },
): Crumb[] {
  const { items, labels } = context;
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/settings") return [{ label: labels.settings }];

  const setup = /^\/admin\/setup\/([^/]+)$/.exec(path);
  const item = items.find((candidate) => candidate.href === (setup ? ADMIN : path));
  if (!item) return [];
  // "Administration" leads to the admin start page; that page is Status itself.
  const crumbs: Crumb[] =
    item.href.startsWith(`${ADMIN}/`) || setup ? [{ label: labels.admin, href: ADMIN }] : [];
  if (!setup) return [...crumbs, { label: item.label }];
  const title = labels.setup(setup[1]!);
  crumbs.push({ label: item.label, href: item.href });
  return title ? [...crumbs, { label: title }] : crumbs;
}
