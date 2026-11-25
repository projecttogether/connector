import { createRoute, type AnyRoute } from "@tanstack/react-router";
import { z } from "zod";
import { appRoute } from "@/routes/app";
import { SettingsPage } from "./settings-page";

const text = z.string().max(500).optional().catch(undefined);

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  // Linking an account comes back here: ?linked=<slug> or ?link_error=<message>.
  validateSearch: z.object({ linked: text, link_error: text }),
  component: function SettingsRoute() {
    const search = settingsRoute.useSearch();
    return <SettingsPage linked={search.linked} linkError={search.link_error} />;
  },
});

/** Routes of this module inside the signed-in app (children of appRoute). */
export const routes: AnyRoute[] = [settingsRoute];
