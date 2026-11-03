import { describe, expect, it } from "vitest";
import { hitTest, quoteOf, rangeRects, wordAt, type PageText } from "../src/text";

// Two lines: "Compute is necessary." and "Verify it."
const even = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n);
const l1 = "Compute is necessary.";
const l2 = "Verify it.";
const pt: PageText = {
  text: l1 + "\n" + l2,
  runs: [
    { start: 0, len: l1.length, x: 20, y: 10, w: 210, h: 10, cx: even(l1.length) },
    { start: l1.length + 1, len: l2.length, x: 20, y: 24, w: 100, h: 10, cx: even(l2.length) },
  ],
};

describe("text index", () => {
  it("finds the caret under a point", () => {
    expect(hitTest(pt, 20, 15)).toBe(0);
    expect(hitTest(pt, 20 + 10 * 8 + 1, 15)).toBe(8); // inside "is"
    expect(hitTest(pt, 22, 29)).toBe(l1.length + 1); // second line
    expect(hitTest(pt, 500, 15)).toBe(l1.length); // past the end of line 1
  });
  it("covers a range with one box per line", () => {
    const r = rangeRects(pt, 8, l1.length + 1 + 6);
    expect(r).toHaveLength(2);
    expect(r[0].x).toBeCloseTo(100);
    expect(r[1].w).toBeCloseTo(60);
  });
  it("expands a tap to the whole word", () => {
    expect(wordAt(pt, 12)).toEqual([11, 20]);
    expect(pt.text.slice(...wordAt(pt, 12)!)).toBe("necessary");
    expect(wordAt(pt, 10)).toEqual([8, 10]);
  });
  it("quotes with context", () => {
    const q = quoteOf(pt, 11, 20);
    expect(q.quote).toBe("necessary");
    expect(q.prefix.endsWith("is ")).toBe(true);
  });
});
