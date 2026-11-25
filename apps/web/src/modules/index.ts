import type { AnyRoute } from "@tanstack/react-router";
import { routes as admin } from "./admin/routes";
import { routes as audit } from "./audit/routes";
import { routes as connect } from "./connect/connect-page";
import { routes as context } from "./context/context-page";
import { routes as home } from "./home/routes";
import { routes as oauth, rootRoutes as oauthRoot } from "./oauth/routes";
import { routes as people } from "./people/people-page";
import { routes as search } from "./search/routes";
import { routes as settings } from "./settings/routes";

/** Routes of every module inside the signed-in app. Add new modules here. */
export const appRoutes: AnyRoute[] = [
  ...home,
  ...search,
  ...context,
  ...people,
  ...connect,
  ...settings,
  ...admin,
  ...audit,
  ...oauth,
];

/** Routes outside the app layout (children of the root route), e.g. the OAuth consent screen. */
export const rootRoutes: AnyRoute[] = [...oauthRoot];
