import { Hono } from "hono";
import { getDb } from "../db/client";
import type { AppEnv } from "../http/env";
import { requireAdmin } from "../http/middleware";
import { adminStatus } from "../status/service";

/** The admin status page: sources, directory, SCIM, agents and problems at a glance. */
const router = new Hono<AppEnv>();

router.get("/admin/status", async (c) => {
  requireAdmin(c);
  return c.json(await adminStatus(getDb()));
});

export default router;
