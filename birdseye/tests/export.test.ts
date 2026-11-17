import { describe, expect, it } from "vitest";
import { buildBrief } from "../src/export";
import type { Annotation } from "../src/annotations";

const ann = (page: number, start: number, tag: Annotation["tag"], quote: string, note: string | null): Annotation =>
  ({ id: `${page}-${start}`, page, start, end: start + 5, quote, prefix: "", suffix: "", rects: [], tag, underline: false, note, createdAt: 0, updatedAt: 0 });

const list = [
  ann(5, 10, "coral", "Compute is important for now.", "Weak point of the analogy."),
  ann(0, 3, "yellow", "Self-reporting is not enough.", ""),
  ann(5, 2, "blue", "What if it still goes wrong?", null),
];
const base = { title: "Seminar", pages: 14, date: "2026-11-17", general: "Thesis: an IAEA for AI.", annotations: list, includeHighlights: true, includeGeneral: true };

describe("Markdown brief", () => {
  it("groups by page in reading order, with tags", () => {
    const md = buildBrief({ ...base, groupBy: "page" });
    expect(md).toContain("## Notes\n\nThesis: an IAEA for AI.");
    expect(md.indexOf("## Page 1")).toBeLessThan(md.indexOf("## Page 6"));
    expect(md.indexOf("What if it still")).toBeLessThan(md.indexOf("Compute is important"));
    expect(md).toContain("> — Disagree\n\nWeak point of the analogy.");
  });
  it("groups by tag with counts and page references", () => {
    const md = buildBrief({ ...base, groupBy: "tag" });
    expect(md).toContain("## Important (1)");
    expect(md).toContain("> — p. 6\n\nWeak point");
    expect(md.indexOf("## Important")).toBeLessThan(md.indexOf("## Disagree"));
  });
  it("can leave out plain highlights and the general notes", () => {
    const md = buildBrief({ ...base, groupBy: "page", includeHighlights: false, includeGeneral: false });
    expect(md).not.toContain("What if it still");
    expect(md).not.toContain("Thesis");
    expect(md).toContain("Self-reporting");
  });
});
