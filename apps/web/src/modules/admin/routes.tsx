import type { ReactNode } from "react";
import { createRoute, notFound, type AnyRoute } from "@tanstack/react-router";
import { z } from "zod";
import { setupAppSchema } from "@connector/shared/api/status";
import { appRoute, requireAdmin } from "@/routes/app";
import { AdminActivityPage } from "./activity-page";
import { AdminDirectoryPage } from "./directory-page";
import { AdminPeoplePage } from "./people-page";
import { AdminServiceTokensPage } from "./service-tokens-page";
import { AdminSourcesPage } from "./sources-page";
import { AdminStatusPage } from "./status-page";
import { SetupPage } from "./setup/setup-page";

const page = (path: string, component: () => ReactNode) =>
  createRoute({ getParentRoute: () => appRoute, path, beforeLoad: requireAdmin(), component });

const peopleRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin/people",
  beforeLoad: requireAdmin(),
  validateSearch: z.object({ q: z.string().trim().max(100).optional().catch(undefined) }),
  component: function PeopleRoute() {
    const { q } = peopleRoute.useSearch();
    return <AdminPeoplePage initialQuery={q ?? ""} />;
  },
});

const setupRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin/setup/$app",
  beforeLoad: requireAdmin(),
  validateSearch: z.object({ source: z.uuid().optional().catch(undefined) }),
  component: function SetupRoute() {
    const params = setupRoute.useParams();
    const { source } = setupRoute.useSearch();
    const navigate = setupRoute.useNavigate();
    const app = setupAppSchema.safeParse(params.app);
    if (!app.success) throw notFound();
    return (
      <SetupPage
        app={app.data}
        sourceId={source}
        onCreated={(id) => void navigate({ search: { source: id }, replace: true })}
      />
    );
  },
});

/** Routes of this module inside the signed-in app (children of appRoute). */
export const routes: AnyRoute[] = [
  page("/admin", AdminStatusPage),
  setupRoute,
  page("/admin/sources", AdminSourcesPage),
  peopleRoute,
  page("/admin/directory", AdminDirectoryPage),
  page("/admin/service-tokens", AdminServiceTokensPage),
  page("/admin/activity", AdminActivityPage),
];
