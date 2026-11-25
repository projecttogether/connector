import { createRoute, type AnyRoute } from "@tanstack/react-router";
import { z } from "zod";
import { appRoute } from "@/routes/app";
import { SearchPage } from "./search-page";

const text = z.string().trim().max(300).optional().catch(undefined);

const searchRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/search",
  validateSearch: z.object({ q: text, sources: text }),
  component: function SearchRoute() {
    const params = searchRoute.useSearch();
    const navigate = searchRoute.useNavigate();
    return (
      <SearchPage
        key={params.q ?? ""}
        params={params}
        onChange={(next) =>
          void navigate({ search: { q: next.q || undefined, sources: next.sources || undefined } })
        }
      />
    );
  },
});

/** Routes of this module inside the signed-in app (children of appRoute). */
export const routes: AnyRoute[] = [searchRoute];
