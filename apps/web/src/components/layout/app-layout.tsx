import { Link, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { setupAppSchema } from "@connector/shared/api/status";
import { AppFrame, type FrameLink, type NavGroup } from "@/components/ui/app-frame";
import { AppIcon, SidebarOrganization } from "@/components/brand";
import { useMe } from "@/hooks/use-me";
import { useTheme } from "@/lib/theme";
import { authClient } from "@/lib/auth-client";
import { useAuthConfig } from "@/lib/auth-config";
import { queryClient } from "@/lib/query";
import { defineMessages, useT } from "@/i18n";
import { breadcrumbsFor, NAVIGATION, navMessages } from "@/app/navigation";
import { messages as settingsMessages } from "@/modules/settings/messages";
import { messages as setupMessages } from "@/modules/admin/setup/messages";
import { findItems, isAppAddress } from "@/modules/search/api";

const messages = defineMessages({
  en: {
    admin: "Admin",
  },
});

const DEFAULT_APP_NAME = "Connector";

/**
 * TanStack Router's link for the frame: every other prop goes on to the <a>.
 * `exact`: otherwise TanStack marks every link whose path the address starts
 * with as the current page (Status on the other admin pages, breadcrumb parents).
 */
const AppLink: FrameLink = ({ href, ...props }) => (
  <Link to={href} activeOptions={{ exact: true }} {...props} />
);

/** The signed-in application frame: the AppFrame with Connector's navigation. */
export function AppLayout() {
  const me = useMe();
  const m = useT(messages);
  const t = useT(navMessages);
  const tSettings = useT(settingsMessages);
  const tSetup = useT(setupMessages);
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { theme, setTheme } = useTheme();
  const appName = useAuthConfig()?.appName || DEFAULT_APP_NAME;
  useEffect(() => {
    document.title = appName;
  }, [appName]);

  const nav: NavGroup[] = NAVIGATION.filter((group) => !group.adminOnly || me.isAdmin).map((group) => ({
    label: t(group.key),
    items: group.items.map((item) => ({
      label: t(item.key),
      href: item.to,
      shortcut: item.shortcut,
      exact: item.exact,
      match: item.match,
    })),
  }));
  const breadcrumbs = breadcrumbsFor(pathname, {
    items: nav.flatMap((group) => group.items),
    labels: {
      admin: t("admin"),
      settings: tSettings("title"),
      setup: (app) => {
        const known = setupAppSchema.safeParse(app);
        return known.success ? tSetup(`title_${known.data}`) : undefined;
      },
    },
  });

  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear();
    window.location.assign("/sign-in");
  };

  return (
    <AppFrame
      app={{ name: appName, icon: <AppIcon /> }}
      sidebarFooter={<SidebarOrganization />}
      nav={nav}
      pathname={pathname}
      link={AppLink}
      navigate={(href) => {
        // A search result opens in its app, in a new tab as on the search page.
        if (isAppAddress(href)) window.open(href, "_blank", "noopener,noreferrer");
        else void router.navigate({ href });
      }}
      user={{
        name: me.name || me.email,
        email: me.email,
        detail: me.isAdmin ? m("admin") : undefined,
        image: me.image,
      }}
      theme={theme}
      onThemeChange={setTheme}
      settingsHref="/settings"
      onSignOut={() => void signOut()}
      breadcrumbs={breadcrumbs}
      search={{
        find: findItems,
        // The router's own encoding: it reads query values as JSON, so "123" must stay a string.
        allResultsHref: (q) => router.buildLocation({ to: "/search", search: { q } }).href,
      }}
    >
      <Outlet />
    </AppFrame>
  );
}
