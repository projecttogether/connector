import { describe, expect, it } from "vitest";
import { createKeycloakClient, DirectoryError } from "./keycloak";

const issuer = "http://keycloak.test/realms/connector";

/** A Keycloak that issues tokens and answers every Admin API request with `status`. */
function keycloak(status: number) {
  const calls: string[] = [];
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/protocol/openid-connect/token")) {
      return Response.json({ access_token: "token", expires_in: 60 });
    }
    return new Response(null, { status });
  }) as typeof globalThis.fetch;
  return {
    calls,
    client: createKeycloakClient({ issuer, clientId: "connector", clientSecret: "secret", fetch }),
  };
}

describe("Keycloak Admin API errors", () => {
  it("names the kc-admin-api scope when Keycloak refuses its own token", async () => {
    const { calls, client } = keycloak(401);
    const error = await client.users().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DirectoryError);
    expect((error as Error).message).toContain("add the client scope kc-admin-api to client connector");
    // One retry with a fresh token before giving up.
    expect(calls.filter((url) => url.endsWith("/token"))).toHaveLength(2);
  });

  it("names the view-users role on HTTP 403", async () => {
    const { client } = keycloak(403);
    await expect(client.users()).rejects.toThrow("realm-management role view-users");
  });
});
