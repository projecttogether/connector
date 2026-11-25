import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { longestRequestMs } from "./use";

describe("longestRequestMs", () => {
  it("fits into the time compose.yaml gives the web app to stop", () => {
    const compose = readFileSync(path.resolve(import.meta.dirname, "../../../../compose.yaml"), "utf8");
    const web = /\n {2}web:\n([\s\S]*?)\n {2}\w/.exec(compose)?.[1] ?? "";
    const seconds = Number(/stop_grace_period: (\d+)s/.exec(web)?.[1]);
    // A deploy that stops web sooner would cut an agent's proposal off halfway.
    expect(longestRequestMs()).toBe(25_000);
    expect(seconds * 1000).toBeGreaterThan(longestRequestMs());
  });
});
