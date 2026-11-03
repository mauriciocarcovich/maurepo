import { describe, expect, it } from "vitest";
import { findAll, fold } from "../src/search";

describe("search matching", () => {
  it("keeps offsets aligned with the original text", () => {
    const s = "Regulación EN Venta";
    expect(fold(s)).toHaveLength(s.length);
    expect(fold(s)).toBe("regulacion en venta");
  });
  it("ignores case and accents in both directions", () => {
    expect(findAll("CONTROL DE SUPPLY CHAIN, REGULACIÓN EN VENTA", "regulacion")).toEqual([[25, 35]]);
    expect(findAll("regulacion", "Regulación")).toEqual([[0, 10]]);
  });
  it("matches phrases across line breaks", () => {
    expect(findAll("compute is\nnecessary", "is necessary")).toEqual([[8, 20]]);
  });
  it("finds every occurrence and ignores one-letter queries", () => {
    expect(findAll("AI and ai and Ai", "ai")).toHaveLength(3);
    expect(findAll("a a a", "a")).toEqual([]);
  });
});
