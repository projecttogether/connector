import { describe, expect, it } from "vitest";
import { breadcrumbsFor, NAVIGATION, type CrumbLabels } from "./navigation";

const find = [
  { label: "Overview", href: "/" },
  { label: "Search", href: "/search" },
  { label: "Context", href: "/context" },
  { label: "People", href: "/people" },
  { label: "Connect an agent", href: "/connect" },
];
const admin = [
  { label: "Status", href: "/admin" },
  { label: "Sources", href: "/admin/sources" },
  { label: "People", href: "/admin/people" },
  { label: "Audit log", href: "/admin/audit" },
];
const labels: CrumbLabels = {
  admin: "Administration",
  settings: "Settings",
  setup: (app) => (app === "logbook" ? "Connect Logbook" : undefined),
};
const crumbs = (pathname: string, items = [...find, ...admin]) => breadcrumbsFor(pathname, { items, labels });

describe("NAVIGATION", () => {
  const items = NAVIGATION.flatMap((group) => group.items);

  it("gives each main page its own letter, the start page o, and admin pages none", () => {
    const shortcuts = items.flatMap((item) => (item.shortcut ? [item.shortcut] : []));
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
    expect(items.find((item) => item.to === "/")?.shortcut).toBe("o");
    for (const group of NAVIGATION.filter((group) => group.adminOnly)) {
      expect(group.items.every((item) => !item.shortcut)).toBe(true);
    }
  });
});

describe("breadcrumbsFor", () => {
  it("names the main pages by their sidebar item", () => {
    expect(crumbs("/")).toEqual([{ label: "Overview" }]);
    expect(crumbs("/search")).toEqual([{ label: "Search" }]);
    expect(crumbs("/people")).toEqual([{ label: "People" }]);
    expect(crumbs("/connect/")).toEqual([{ label: "Connect an agent" }]);
  });

  it("puts Administration before admin pages, so both People pages differ", () => {
    expect(crumbs("/admin/people")).toEqual([
      { label: "Administration", href: "/admin" },
      { label: "People" },
    ]);
    expect(crumbs("/admin/audit")).toEqual([
      { label: "Administration", href: "/admin" },
      { label: "Audit log" },
    ]);
    // The admin start page is where "Administration" leads.
    expect(crumbs("/admin")).toEqual([{ label: "Status" }]);
  });

  it("leads from a setup guide back to Status", () => {
    expect(crumbs("/admin/setup/logbook")).toEqual([
      { label: "Administration", href: "/admin" },
      { label: "Status", href: "/admin" },
      { label: "Connect Logbook" },
    ]);
    expect(crumbs("/admin/setup/unknown")).toEqual([
      { label: "Administration", href: "/admin" },
      { label: "Status", href: "/admin" },
    ]);
  });

  it("names the settings page", () => {
    expect(crumbs("/settings")).toEqual([{ label: "Settings" }]);
  });

  it("has nothing for unknown pages or pages outside the person's sidebar", () => {
    expect(crumbs("/somewhere")).toEqual([]);
    expect(crumbs("/admin/sources/extra")).toEqual([]);
    expect(crumbs("/admin/sources", find)).toEqual([]);
    expect(crumbs("/admin/setup/logbook", find)).toEqual([]);
  });
});
