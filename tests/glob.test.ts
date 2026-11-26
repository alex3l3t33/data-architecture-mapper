import { describe, expect, it } from "vitest";
import { isInside, matchesAnyGlob } from "../src/discovery/glob";

describe("file discovery patterns", () => {
  it("supports recursive globs and brace extensions", () => {
    expect(matchesAnyGlob("prod/connectors/orders.json", ["**/*.{json,yaml,yml,properties}"])).toBe(true);
    expect(matchesAnyGlob("orders.json", ["**/*.{json,yaml}"])).toBe(true);
    expect(matchesAnyGlob("orders.txt", ["**/*.{json,yaml}"])).toBe(false);
  });

  it("uses path-segment-aware folder containment", () => {
    expect(isInside("architecture/prod/orders.json", "architecture")).toBe(true);
    expect(isInside("architecture-copy/orders.json", "architecture")).toBe(false);
  });
});
