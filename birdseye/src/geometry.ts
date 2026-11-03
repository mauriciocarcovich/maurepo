// Pure geometry: page layout, camera math and the notes-aware visible region.
// Nothing here touches the DOM, so it is covered by unit tests.

/** Every page is laid out at this width in world units; height follows its aspect ratio. */
export const PAGE_W = 300;
export const GAP_X = 24;
export const GAP_Y = 48; // room for the page number under each page

export interface Size { w: number; h: number }
export interface Rect { x: number; y: number; w: number; h: number }
export interface Camera { s: number; tx: number; ty: number }

export interface Layout {
  cols: number;
  pages: Rect[]; // world rect of each page
  world: Size;
}

/** Lay pages out in rows. Each row is as tall as its tallest page; pages sit at the row top. */
export function layoutPages(sizes: Size[], cols: number): Layout {
  cols = Math.max(1, Math.min(cols, sizes.length || 1));
  const pages: Rect[] = [];
  let y = 0;
  let worldW = 0;
  for (let start = 0; start < sizes.length; start += cols) {
    const row = sizes.slice(start, start + cols);
    let rowH = 0;
    row.forEach((sz, j) => {
      const h = PAGE_W * (sz.h / sz.w);
      pages.push({ x: j * (PAGE_W + GAP_X), y, w: PAGE_W, h });
      rowH = Math.max(rowH, h);
    });
    worldW = Math.max(worldW, row.length * PAGE_W + (row.length - 1) * GAP_X);
    y += rowH + GAP_Y;
  }
  return { cols, pages, world: { w: worldW, h: Math.max(0, y - GAP_Y) } };
}

/** Pick the column count that lets the whole document appear largest in the given region. */
export function bestLayout(sizes: Size[], region: Size, pad = 24): Layout {
  let best: Layout | null = null;
  let bestScale = -1;
  const maxCols = Math.max(1, sizes.length);
  for (let cols = 1; cols <= maxCols; cols++) {
    const l = layoutPages(sizes, cols);
    const s = fitScale(l.world, region, pad);
    if (s > bestScale + 1e-9) { bestScale = s; best = l; }
  }
  return best ?? layoutPages(sizes, 1);
}

export function fitScale(world: Size, region: Size, pad = 24): number {
  if (world.w <= 0 || world.h <= 0) return 1;
  return Math.min((region.w - pad * 2) / world.w, (region.h - pad * 2) / world.h);
}

/** Camera that fits the world rect `r` (world units) centred inside the screen rect `region`. */
export function fitRect(r: Rect, region: Rect, pad = 24): Camera {
  const s = Math.min((region.w - pad * 2) / r.w, (region.h - pad * 2) / r.h);
  return centerOn(r.x + r.w / 2, r.y + r.h / 2, s, region);
}

/** Camera with scale `s` that puts world point (wx, wy) in the centre of `region`. */
export function centerOn(wx: number, wy: number, s: number, region: Rect): Camera {
  return { s, tx: region.x + region.w / 2 - wx * s, ty: region.y + region.h / 2 - wy * s };
}

/** Zoom to `s2` keeping the world point under screen point (x, y) fixed. */
export function zoomAt(cam: Camera, s2: number, x: number, y: number): Camera {
  const wx = (x - cam.tx) / cam.s;
  const wy = (y - cam.ty) / cam.s;
  return { s: s2, tx: x - wx * s2, ty: y - wy * s2 };
}

export function screenToWorld(cam: Camera, x: number, y: number) {
  return { x: (x - cam.tx) / cam.s, y: (y - cam.ty) / cam.s };
}

/** The world rect currently visible on a screen of size `view`. */
export function visibleWorld(cam: Camera, view: Size): Rect {
  return { x: -cam.tx / cam.s, y: -cam.ty / cam.s, w: view.w / cam.s, h: view.h / cam.s };
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
}

export function inflate(r: Rect, f: number): Rect {
  const dx = r.w * f;
  const dy = r.h * f;
  return { x: r.x - dx, y: r.y - dy, w: r.w + dx * 2, h: r.h + dy * 2 };
}

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/**
 * The part of the screen not covered by the notes panel, where the camera centres things.
 * The panel covers one side; we use the larger free side. If neither is wide enough, the whole screen.
 */
export function freeRegion(view: Size, panel: Rect | null, top: number, bottom: number, minW = 360): Rect {
  const full: Rect = { x: 0, y: top, w: view.w, h: Math.max(1, view.h - top - bottom) };
  if (!panel) return full;
  const leftW = panel.x;
  const rightW = view.w - (panel.x + panel.w);
  const useRight = rightW >= leftW;
  const r: Rect = useRight
    ? { x: panel.x + panel.w, y: full.y, w: rightW, h: full.h }
    : { x: 0, y: full.y, w: leftW, h: full.h };
  return r.w >= minW ? r : full;
}

/**
 * Device-pixel scale at which to render a page so it looks sharp at camera scale `s`,
 * rounded up to a step of √2 so small zoom changes reuse the same render.
 */
export function renderBucket(s: number, dpr: number): number {
  const want = s * dpr;
  const step = Math.SQRT2;
  return Math.pow(step, Math.ceil(Math.log(want) / Math.log(step) - 1e-9));
}
