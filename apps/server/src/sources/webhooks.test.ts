import { describe, expect, it } from "vitest";
import { signatureOf, validSignature } from "./webhooks";

describe("webhook signatures", () => {
  const now = 1_800_000_000;
  const body = '{"event":"entry.changed"}';
  const signature = signatureOf("secret-secret-secret", String(now), body);

  it("match the apps' format: sha256= and the hex HMAC of <timestamp>.<body>", () => {
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(
      validSignature({ secret: "secret-secret-secret", timestamp: String(now), signature, body, now }),
    ).toBe(true);
  });

  it("refuse other bodies, secrets, old timestamps and missing headers", () => {
    const base = { secret: "secret-secret-secret", timestamp: String(now), signature, body, now };
    expect(validSignature({ ...base, body: `${body} ` })).toBe(false);
    expect(validSignature({ ...base, secret: "another-secret-value" })).toBe(false);
    expect(validSignature({ ...base, now: now + 301 })).toBe(false);
    expect(validSignature({ ...base, timestamp: undefined })).toBe(false);
    expect(validSignature({ ...base, timestamp: "12abc" })).toBe(false);
    expect(validSignature({ ...base, signature: signature.slice(0, -1) })).toBe(false);
  });
});
