import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "../config";
import { longestRequestMs } from "./use";

describe("longestRequestMs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigForTests();
  });

  it("fits into the time compose.yaml gives the web app to stop", () => {
    const compose = readFileSync(path.resolve(import.meta.dirname, "../../../../compose.yaml"), "utf8");
    const web = /\n {2}web:\n([\s\S]*?)\n {2}\w/.exec(compose)?.[1] ?? "";
    const seconds = Number(/stop_grace_period: (\d+)s/.exec(web)?.[1]);
    // A deploy that stops web sooner would cut an agent's proposal off halfway,
    // also at the highest SOURCE_TIMEOUT_SECONDS.
    expect(longestRequestMs()).toBe(25_000);
    vi.stubEnv("SOURCE_TIMEOUT_SECONDS", "60");
    resetConfigForTests();
    expect(longestRequestMs()).toBe(181_000);
    expect(seconds * 1000).toBeGreaterThan(longestRequestMs());
  });
});
