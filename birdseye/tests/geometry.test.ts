import { describe, expect, it } from "vitest";
import {
  PAGE_W, GAP_X, bestLayout, centerOn, fitRect, freeRegion, layoutPages, renderBucket, screenToWorld, visibleWorld, zoomAt,
} from "../src/geometry";

const letter = { w: 612, h: 792 };

describe("layout", () => {
  it("places pages in rows of the requested width", () => {
    const l = layoutPages(Array(7).fill(letter), 3);
    expect(l.pages).toHaveLength(7);
    expect(l.pages[3]).toMatchObject({ x: 0 });
    expect(l.pages[3].y).toBeGreaterThan(l.pages[0].y);
    expect(l.world.w).toBeCloseTo(3 * PAGE_W + 2 * GAP_X);
  });
  it("keeps each page's aspect ratio", () => {
    const l = layoutPages([letter, { w: 842, h: 595 }], 2);
    expect(l.pages[0].h).toBeCloseTo(PAGE_W * 792 / 612);
    expect(l.pages[1].h).toBeCloseTo(PAGE_W * 595 / 842);
  });
  it("chooses more columns for a wide screen than a tall one", () => {
    const pages = Array(14).fill(letter);
    const wide = bestLayout(pages, { w: 1200, h: 600 });
    const tall = bestLayout(pages, { w: 600, h: 1200 });
    expect(wide.cols).toBeGreaterThan(tall.cols);
  });
});

describe("camera", () => {
  it("zoomAt keeps the point under the finger fixed", () => {
    const cam = { s: 0.5, tx: 30, ty: -20 };
    const before = screenToWorld(cam, 400, 300);
    const after = screenToWorld(zoomAt(cam, 2.3, 400, 300), 400, 300);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });
  it("centerOn puts a world point in the middle of the region", () => {
    const region = { x: 400, y: 76, w: 600, h: 500 };
    const cam = centerOn(150, 200, 1.7, region);
    expect(150 * cam.s + cam.tx).toBeCloseTo(700);
    expect(200 * cam.s + cam.ty).toBeCloseTo(326);
  });
  it("fitRect fits the whole rect inside the region", () => {
    const region = { x: 0, y: 0, w: 1000, h: 600 };
    const cam = fitRect({ x: 0, y: 0, w: 2000, h: 900 }, region, 24);
    const v = visibleWorld(cam, { w: 1000, h: 600 });
    expect(v.x).toBeLessThanOrEqual(0);
    expect(v.y).toBeLessThanOrEqual(0);
    expect(v.x + v.w).toBeGreaterThanOrEqual(2000);
    expect(v.y + v.h).toBeGreaterThanOrEqual(900);
  });
});

describe("free region beside the notes panel", () => {
  const view = { w: 1000, h: 600 };
  it("uses the right side when the panel is on the left", () => {
    const r = freeRegion(view, { x: 20, y: 100, w: 300, h: 370 }, 76, 16);
    expect(r.x).toBe(320);
    expect(r.w).toBe(680);
  });
  it("uses the left side when the panel is on the right", () => {
    const r = freeRegion(view, { x: 680, y: 100, w: 300, h: 370 }, 76, 16);
    expect(r.x).toBe(0);
    expect(r.w).toBe(680);
  });
  it("falls back to the whole screen when no side is wide enough", () => {
    const r = freeRegion(view, { x: 300, y: 100, w: 400, h: 370 }, 76, 16);
    expect(r).toEqual({ x: 0, y: 76, w: 1000, h: 508 });
  });
});

describe("render resolution", () => {
  it("rounds up to √2 steps so small zooms reuse a render", () => {
    expect(renderBucket(1, 2)).toBeCloseTo(2);
    expect(renderBucket(1.05, 2)).toBeCloseTo(2 * Math.SQRT2);
    expect(renderBucket(1.4, 2)).toBeCloseTo(2 * Math.SQRT2);
    expect(renderBucket(1.42, 2)).toBeCloseTo(4);
  });
});
