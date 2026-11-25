import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetConfigForTests } from "../config";
import { getDb } from "../db/client";
import type { UserPrincipal } from "../auth/principal";
import { createSource, resetDatabase } from "../test/helpers";
import { SourceError } from "./types";
import { administerSource, useSource, useSources } from "./use";

const rita: UserPrincipal = {
  kind: "user",
  id: "00000000-0000-4000-8000-000000000001",
  email: "rita@example.org",
  name: "Rita",
  image: null,
  isAdmin: false,
  channel: "token",
  agent: true,
  clientName: null,
  credentialId: null,
  groups: ["/staff"],
  groupIds: [],
};

beforeAll(() => {
  process.env.SOURCE_TIMEOUT_SECONDS = "1";
  resetConfigForTests();
});
afterAll(() => {
  delete process.env.SOURCE_TIMEOUT_SECONDS;
  resetConfigForTests();
});

describe("source use", () => {
  beforeEach(resetDatabase);

  it("gives a source only to those who may use it", async () => {
    const closed = await createSource({ kind: "logbook", config: {}, accessGroups: ["/board"] });
    const off = await createSource({ kind: "library", config: {}, enabled: false });
    let asked = 0;
    const operation = async () => {
      asked += 1;
      return [];
    };
    expect(await useSource(getDb(), rita, closed, operation)).toBeNull();
    expect(await useSource(getDb(), rita, off, operation)).toBeNull();
    expect(await useSources(getDb(), rita, undefined, operation)).toEqual({
      answers: [],
      outcomes: [],
      logged: [],
    });
    expect(asked).toBe(0);
  });

  it("ends a use at its budget, even when the operation does not listen", async () => {
    const row = await createSource({ kind: "logbook", name: "Logbook", config: {} });
    const started = Date.now();
    const use = await useSource(getDb(), rita, row, () => new Promise<never>(() => {}));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(use).toMatchObject({
      ok: false,
      outcome: { slug: "logbook", ok: false, count: 0, error: "Logbook did not answer in time" },
    });
  });

  it("lets a proposal that runs out of time say what it left behind", async () => {
    const row = await createSource({ kind: "handbook", name: "Handbook", config: {} });
    const use = await useSource(
      getDb(),
      rita,
      row,
      // Like proposeHandbookChange: its own error comes a little after the deadline.
      (_, context) =>
        new Promise<never>((_, reject) =>
          context.signal.addEventListener("abort", () =>
            setTimeout(
              () => reject(new SourceError("Handbook did not answer in time. The change set #7 stays open")),
              10,
            ),
          ),
        ),
      "propose",
    );
    expect(use).toMatchObject({
      ok: false,
      outcome: { error: "Handbook did not answer in time. The change set #7 stays open" },
    });
  });

  it("turns every failure into an outcome", async () => {
    const logbook = await createSource({ kind: "logbook", name: "Logbook", config: {} });
    await createSource({ kind: "library", name: "Library", config: {} });
    const { answers, outcomes, logged } = await useSources(getDb(), rita, undefined, async (adapter) => {
      if (adapter.kind === "logbook") {
        throw new SourceError("Logbook refused the credentials: Unknown token", {
          kind: "refused",
          diagnostic: "Logbook refused the credentials",
        });
      }
      throw new TypeError("a bug in an adapter");
    });
    expect(answers.map((answer) => answer.value)).toEqual([[], []]);
    expect(outcomes).toMatchObject([
      { slug: "logbook", ok: false, error: "Logbook refused the credentials: Unknown token" },
      { slug: "library", ok: false, error: "The source failed" },
    ]);
    // The activity log gets Connector's own words only.
    expect(logged).toMatchObject([
      { slug: "logbook", ok: false, error: "Logbook refused the credentials" },
      { slug: "library", ok: false, error: "The source failed" },
    ]);
    const fetched = await useSource(getDb(), rita, logbook, async () => ({ title: "LB-1" }));
    expect(fetched).toMatchObject({ ok: true, value: { title: "LB-1" }, outcome: { ok: true, count: 1 } });
  });

  it("administers a source as Connector itself, never as a person", async () => {
    const row = await createSource({ kind: "logbook", config: {}, accessGroups: ["/board"] });
    const use = await administerSource(getDb(), row, async (_, context) => context.principal);
    expect(use).toMatchObject({ ok: true, value: { kind: "service", name: "Connector" } });
  });
});
