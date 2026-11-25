import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { config } from "../config";
import { getDb } from "../db/client";
import { resolveScimToken } from "../auth/credentials";
import { bearerToken } from "../auth/resolve";
import type { AppEnv } from "../http/env";
import { logger } from "../logger";
import { putSetting } from "../core/settings";
import {
  createGroup,
  createUser,
  deleteGroup,
  deleteUser,
  ERROR_SCHEMA,
  getGroup,
  getUser,
  groupResource,
  GROUP_SCHEMA,
  listGroups,
  listUsers,
  patchGroup,
  patchUser,
  replaceGroup,
  replaceUser,
  ScimError,
  userResource,
  USER_SCHEMA,
} from "./service";

/**
 * The SCIM 2.0 server at /scim/v2 (RFC 7644) for identity systems such as
 * IAM, Microsoft Entra ID or Okta: people and groups, with a SCIM
 * token (`cn_scim_`, Administration → Directory) as bearer token.
 */

const SCIM_TYPE = "application/scim+json";
const MAX_COUNT = 200;

function scimJson(
  c: Context<AppEnv>,
  body: unknown,
  status: 200 | 201 = 200,
  headers: Record<string, string> = {},
) {
  return c.body(JSON.stringify(body), status, { "content-type": SCIM_TYPE, ...headers });
}

function scimError(c: Context<AppEnv>, error: ScimError) {
  return c.body(
    JSON.stringify({
      schemas: [ERROR_SCHEMA],
      status: String(error.status),
      detail: error.detail,
      ...(error.scimType ? { scimType: error.scimType } : {}),
    }),
    error.status,
    { "content-type": SCIM_TYPE },
  );
}

async function body(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const parsed: unknown = await c.req.json().catch(() => null);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ScimError(400, "The body must be a JSON object", "invalidSyntax");
  }
  return parsed as Record<string, unknown>;
}

function paging(c: Context<AppEnv>) {
  const start = Number.parseInt(c.req.query("startIndex") ?? "1", 10);
  const count = Number.parseInt(c.req.query("count") ?? "100", 10);
  return {
    filter: c.req.query("filter"),
    // Bounded: the database takes no offset beyond its integers.
    startIndex: Number.isFinite(start) && start >= 1 ? Math.min(start, 1_000_000_000) : 1,
    count: Number.isFinite(count) ? Math.min(Math.max(count, 0), MAX_COUNT) : 100,
  };
}

/** Settings keys: the last SCIM request, and the last one that failed (status page). */
export const SCIM_LAST_REQUEST = "scim.last";
export const SCIM_LAST_ERROR = "scim.last_error";

/**
 * Notes how an identity system's request went, without IDs or personal
 * data: only known resources (`PATCH /Users`) and fixed reasons, because
 * paths and error details can carry what the client sent. A missing person
 * on a lookup (404 on GET) is normal and counts as answered.
 */
const RESOURCES = new Set(["Users", "Groups", "ServiceProviderConfig", "ResourceTypes", "Schemas"]);
const REASONS: Record<string, string> = {
  uniqueness: "a person or group with this email address or name exists",
  invalidValue: "a value is not valid",
  invalidSyntax: "the request is not valid SCIM",
  invalidFilter: "the filter is not supported",
  invalidPath: "changing this attribute is not supported",
  mutability: "the group comes from Keycloak and cannot change here",
};

async function recordRequest(c: Context<AppEnv>) {
  const method = c.req.method;
  const status = c.res.status;
  const segment = c.req.path.split("/scim/v2/")[1]?.split("/")[0] ?? "";
  const label = `${method} ${RESOURCES.has(segment) ? `/${segment}` : "another path"}`;
  const failed = status >= 500 || (status >= 400 && !(status === 404 && method === "GET"));
  const at = new Date().toISOString();
  let message = label;
  if (failed) {
    const known = c.error instanceof ScimError ? c.error : null;
    const reason =
      (known?.scimType && REASONS[known.scimType]) ||
      (known && status === 404 ? "no such person or group" : status >= 500 ? "something went wrong" : "");
    message = `${label} failed (HTTP ${status})${reason ? `: ${reason}` : ""}`;
  }
  try {
    const db = getDb();
    await putSetting(db, SCIM_LAST_REQUEST, { at, ok: !failed, message });
    if (failed) await putSetting(db, SCIM_LAST_ERROR, { at, ok: false, message });
  } catch (error) {
    logger.warn({ err: error }, "could not record a SCIM request");
  }
}

/** `attributes=displayName` or `excludedAttributes=members`: groups without their members. */
function withoutMembers(c: Context<AppEnv>): boolean {
  const attributes = (c.req.query("attributes") ?? "").toLowerCase();
  const excluded = (c.req.query("excludedAttributes") ?? "").toLowerCase();
  return (
    excluded
      .split(",")
      .map((item) => item.trim())
      .includes("members") ||
    (attributes !== "" &&
      !attributes
        .split(",")
        .map((item) => item.trim())
        .includes("members"))
  );
}

export function scimRoutes() {
  const scim = new Hono<AppEnv>();
  scim.use("*", bodyLimit({ maxSize: 1024 * 1024 }));
  scim.use("*", async (c, next) => {
    const token = bearerToken(c.req.raw.headers);
    const credentialId = token ? await resolveScimToken(getDb(), token) : null;
    if (!credentialId) {
      return c.body(
        JSON.stringify({
          schemas: [ERROR_SCHEMA],
          status: "401",
          detail: "Send a SCIM token as bearer token",
        }),
        401,
        { "content-type": SCIM_TYPE, "www-authenticate": 'Bearer realm="scim"' },
      );
    }
    await next();
    await recordRequest(c);
  });
  scim.onError((error, c) => {
    if (error instanceof ScimError) return scimError(c, error);
    logger.error(
      { err: error, requestId: c.get("requestId"), route: `${c.req.method} ${c.req.routePath}` },
      "SCIM request failed",
    );
    return scimError(c, new ScimError(500, "Something went wrong"));
  });

  scim.get("/ServiceProviderConfig", (c) =>
    scimJson(c, {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      documentationUri: `${config().APP_URL}/admin/directory`,
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: MAX_COUNT },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: "oauthbearertoken",
          name: "Bearer token",
          description: "A SCIM token from Administration → Directory",
          primary: true,
        },
      ],
      meta: { resourceType: "ServiceProviderConfig", location: `${config().scimUrl}/ServiceProviderConfig` },
    }),
  );
  scim.get("/ResourceTypes", (c) =>
    scimJson(c, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: 2,
      Resources: [
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
          id: "User",
          name: "User",
          endpoint: "/Users",
          schema: USER_SCHEMA,
        },
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
          id: "Group",
          name: "Group",
          endpoint: "/Groups",
          schema: GROUP_SCHEMA,
        },
      ],
    }),
  );
  scim.get("/Schemas", (c) =>
    scimJson(c, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: 2,
      Resources: [
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
          id: USER_SCHEMA,
          name: "User",
          attributes: [],
        },
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
          id: GROUP_SCHEMA,
          name: "Group",
          attributes: [],
        },
      ],
    }),
  );

  scim.get("/Users", async (c) => scimJson(c, await listUsers(getDb(), paging(c))));
  scim.get("/Users/:id", async (c) =>
    scimJson(c, await userResource(getDb(), await getUser(getDb(), c.req.param("id")))),
  );
  scim.post("/Users", async (c) => {
    // 201 also when an existing person (signed in before) is taken over.
    const { user } = await createUser(getDb(), await body(c));
    const resource = await userResource(getDb(), user);
    return scimJson(c, resource, 201, { location: String((resource.meta as { location: string }).location) });
  });
  scim.put("/Users/:id", async (c) =>
    scimJson(c, await userResource(getDb(), await replaceUser(getDb(), c.req.param("id"), await body(c)))),
  );
  scim.patch("/Users/:id", async (c) =>
    scimJson(c, await userResource(getDb(), await patchUser(getDb(), c.req.param("id"), await body(c)))),
  );
  scim.delete("/Users/:id", async (c) => {
    await deleteUser(getDb(), c.req.param("id"));
    return c.body(null, 204);
  });

  scim.get("/Groups", async (c) =>
    scimJson(c, await listGroups(getDb(), { ...paging(c), withMembers: !withoutMembers(c) })),
  );
  scim.get("/Groups/:id", async (c) =>
    scimJson(c, await groupResource(getDb(), await getGroup(getDb(), c.req.param("id")), !withoutMembers(c))),
  );
  scim.post("/Groups", async (c) => {
    const group = await createGroup(getDb(), await body(c));
    const resource = await groupResource(getDb(), group);
    return scimJson(c, resource, 201, { location: String((resource.meta as { location: string }).location) });
  });
  scim.put("/Groups/:id", async (c) =>
    scimJson(c, await groupResource(getDb(), await replaceGroup(getDb(), c.req.param("id"), await body(c)))),
  );
  scim.patch("/Groups/:id", async (c) => {
    const group = await patchGroup(getDb(), c.req.param("id"), await body(c));
    return scimJson(c, await groupResource(getDb(), group));
  });
  scim.delete("/Groups/:id", async (c) => {
    await deleteGroup(getDb(), c.req.param("id"));
    return c.body(null, 204);
  });

  scim.all("*", (c) => scimError(c, new ScimError(404, "Not found")));
  return scim;
}
