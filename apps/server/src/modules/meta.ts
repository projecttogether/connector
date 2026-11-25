import { Hono } from "hono";
import type { About, AuthConfig, Me } from "@connector/shared/api/users";
import { config } from "../config";
import type { AppEnv } from "../http/env";
import { requireUser, requireWebUser } from "../http/middleware";

const router = new Hono<AppEnv>();

router.get("/auth-config", (c) => {
  const body: AuthConfig = { appName: config().APP_NAME, providerName: config().OIDC_PROVIDER_NAME };
  return c.json(body);
});

router.get("/me", (c) => {
  const principal = requireUser(c);
  const body: Me = {
    id: principal.id,
    email: principal.email,
    name: principal.name || principal.email,
    image: principal.image,
    isAdmin: principal.isAdmin,
    groups: principal.groups,
  };
  return c.json(body);
});

/** The version that runs (the commit of the image), for the About card of the settings page. */
router.get("/about", (c) => {
  requireWebUser(c);
  const body: About = { version: config().APP_VERSION ?? null };
  return c.json(body);
});

export default router;
