// The canvas: camera, gestures and level-of-detail page rendering.
import {
  clamp, inflate, intersect, renderBucket, visibleWorld, zoomAt, fitRect, centerOn,
  type Camera, type Layout, type Rect,
} from "./geometry";
import { releaseCanvas, renderRegion, renderThumb, type PDFDocumentProxy, type RenderTask } from "./pdf";
import { getThumb, putThumb } from "./store";

const THUMB_PX = 256; // thumbnail width in device pixels
const TILE_MAX_PX = 4_000_000; // one canvas never exceeds this many pixels
const TOTAL_BUDGET_PX = 12_000_000; // all sharp tiles together
const THUMB_WINDOW = 1.0; // keep thumbnails decoded within this many screens of the view
const SETTLE_MS = 140;
const ANIM_MS = 560;

interface PageView {
  el: HTMLDivElement;
  img: HTMLImageElement;
  thumbUrl: string | null;
  thumbShown: boolean;
  tile: { canvas: HTMLCanvasElement; k: number; rect: Rect } | null;
}

export interface BoardHooks {
  /** Screen rect the camera should centre content in (the area not covered by notes). */
  region(): Rect;
  onCamera(cam: Camera): void;
  onSettle(cam: Camera): void;
  onFirstGesture(): void;
}

export interface Stats { tiles: number; tileMP: number; lastRenderMs: number; thumbs: number; pages: number; renders: number }

export class Board {
  cam: Camera = { s: 1, tx: 0, ty: 0 };
  layout: Layout | null = null;
  stats: Stats = { tiles: 0, tileMP: 0, lastRenderMs: 0, thumbs: 0, pages: 0, renders: 0 };
  private doc: PDFDocumentProxy | null = null;
  private docId = "";
  private views: PageView[] = [];
  private gen = 0; // bumps whenever the document changes
  private renderPass = 0; // bumps whenever the camera changes, cancelling stale renders
  private settleTimer = 0;
  private animTimer = 0;
  private current: RenderTask | null = null;
  private thumbQueueRunning = false;
  private gestured = false;

  constructor(private viewport: HTMLElement, private world: HTMLElement, private hooks: BoardHooks) {
    this.bindGestures();
  }

  // ---------- document ----------

  async setDocument(doc: PDFDocumentProxy, docId: string, layout: Layout) {
    this.clear();
    this.doc = doc;
    this.docId = docId;
    this.layout = layout;
    this.gen++;
    this.world.style.width = layout.world.w + "px";
    this.world.style.height = layout.world.h + "px";
    layout.pages.forEach((r, i) => {
      const el = document.createElement("div");
      el.className = "page loading";
      el.dataset.i = String(i);
      el.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
      const img = document.createElement("img");
      img.className = "thumb";
      img.alt = "";
      img.decoding = "async";
      const num = document.createElement("div");
      num.className = "pnum";
      num.textContent = `p. ${i + 1}`;
      el.append(img, num);
      this.world.append(el);
      this.views.push({ el, img, thumbUrl: null, thumbShown: false, tile: null });
    });
    this.stats.pages = layout.pages.length;
    this.stats.thumbs = 0;
    this.runThumbQueue();
  }

  clear() {
    this.gen++;
    this.current?.cancel();
    for (const v of this.views) {
      if (v.tile) releaseCanvas(v.tile.canvas);
      if (v.thumbUrl) URL.revokeObjectURL(v.thumbUrl);
    }
    this.views = [];
    this.world.replaceChildren();
    this.doc = null;
    this.layout = null;
  }

  // ---------- camera ----------

  private get view() { return { w: this.viewport.clientWidth, h: this.viewport.clientHeight }; }
  get fitCamera(): Camera | null {
    if (!this.layout) return null;
    return fitRect({ x: 0, y: 0, ...this.layout.world }, this.hooks.region(), 28);
  }
  get minScale() { return Math.min(0.5, (this.fitCamera?.s ?? 1) * 0.5); }
  get maxScale() { return Math.max(12, (this.pageScale() ?? 1) * 10); }

  /** Scale at which one page fills the free region. */
  pageScale(i = 0): number | null {
    const r = this.layout?.pages[i];
    if (!r) return null;
    return fitRect(r, this.hooks.region(), 20).s;
  }

  setCamera(cam: Camera, animate = false) {
    const s = clamp(cam.s, this.minScale, this.maxScale);
    if (s !== cam.s) cam = zoomAt(cam, s, this.view.w / 2, this.view.h / 2);
    this.cam = cam;
    if (animate) {
      this.world.classList.add("anim");
      this.viewport.classList.add("anim");
      clearTimeout(this.animTimer);
      this.animTimer = window.setTimeout(() => {
        this.world.classList.remove("anim");
        this.viewport.classList.remove("anim");
      }, ANIM_MS);
    } else {
      clearTimeout(this.animTimer);
      this.world.classList.remove("anim");
      this.viewport.classList.remove("anim");
    }
    this.apply();
    this.renderPass++;
    this.current?.cancel();
    clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => this.settle(), animate ? ANIM_MS : SETTLE_MS);
    this.updateThumbVisibility();
    this.hooks.onCamera(this.cam);
  }

  private apply() {
    const { s, tx, ty } = this.cam;
    this.world.style.transform = `translate(${tx}px,${ty}px) scale(${s})`;
    this.world.style.setProperty("--inv", String(1 / s));
    // Page numbers keep a readable size but never grow taller than the gap under the page.
    const lab = Math.min(1 / s, 1.6);
    this.world.style.setProperty("--lab", String(lab));
    this.world.style.setProperty("--labo", 22 * lab * s < 8 ? "0" : "1");
    const g = 48 * s;
    this.viewport.style.backgroundSize = `${g}px ${g}px`;
    this.viewport.style.backgroundPosition = `${tx}px ${ty}px`;
  }

  fit(animate = true) { const c = this.fitCamera; if (c) this.setCamera(c, animate); }

  zoomBy(f: number, animate = true) {
    const r = this.hooks.region();
    this.setCamera(zoomAt(this.cam, clamp(this.cam.s * f, this.minScale, this.maxScale), r.x + r.w / 2, r.y + r.h / 2), animate);
  }

  zoomToPage(i: number) {
    const r = this.layout?.pages[i];
    if (r) this.setCamera(fitRect(r, this.hooks.region(), 20), true);
  }

  /** World point at the centre of the free region — what we save so the view restores on any screen. */
  get viewState() {
    const r = this.hooks.region();
    return { cx: (r.x + r.w / 2 - this.cam.tx) / this.cam.s, cy: (r.y + r.h / 2 - this.cam.ty) / this.cam.s, s: this.cam.s };
  }
  restoreView(v: { cx: number; cy: number; s: number }) { this.setCamera(centerOn(v.cx, v.cy, v.s, this.hooks.region())); }

  // ---------- rendering ----------

  private visible(): Rect { return visibleWorld(this.cam, this.view); }

  private updateThumbVisibility() {
    if (!this.layout) return;
    const many = this.views.length > 60;
    const win = inflate(this.visible(), THUMB_WINDOW);
    this.views.forEach((v, i) => {
      const want = !!v.thumbUrl && (!many || !!intersect(this.layout!.pages[i], win));
      if (want !== v.thumbShown) {
        v.thumbShown = want;
        if (want) v.img.src = v.thumbUrl!;
        else v.img.removeAttribute("src");
      }
    });
  }

  /** Thumbnails: cached ones load instantly; missing ones render one at a time, nearest the view first. */
  private async runThumbQueue() {
    if (this.thumbQueueRunning) return;
    this.thumbQueueRunning = true;
    const gen = this.gen;
    try {
      while (gen === this.gen && this.doc && this.layout) {
        const i = this.nextThumb();
        if (i < 0) break;
        const v = this.views[i];
        let blob = await getThumb(this.docId, i);
        if (gen !== this.gen) break;
        if (!blob) {
          const page = await this.doc.getPage(i + 1);
          blob = await renderThumb(page, THUMB_PX);
          page.cleanup();
          if (gen !== this.gen) break;
          void putThumb(this.docId, i, blob);
        }
        v.thumbUrl = URL.createObjectURL(blob);
        v.el.classList.remove("loading");
        this.stats.thumbs++;
        this.updateThumbVisibility();
        await new Promise((r) => setTimeout(r, 0)); // keep gestures responsive
      }
    } catch (e) {
      console.warn("thumbnail queue stopped", e);
    } finally {
      this.thumbQueueRunning = false;
    }
  }

  private nextThumb(): number {
    const vis = this.visible();
    const cx = vis.x + vis.w / 2, cy = vis.y + vis.h / 2;
    let best = -1, bestD = Infinity;
    this.views.forEach((v, i) => {
      if (v.thumbUrl) return;
      const r = this.layout!.pages[i];
      const d = Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  /** After the camera stops: render sharp tiles for visible pages, release everything else. */
  private async settle() {
    this.hooks.onSettle(this.cam);
    if (!this.doc || !this.layout) return;
    const pass = this.renderPass;
    const gen = this.gen;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const vis = this.visible();
    const thumbK = THUMB_PX / this.layout.pages[0].w;
    const need = this.cam.s * dpr > thumbK * 1.15;

    const jobs: { i: number; rect: Rect; area: number }[] = [];
    this.views.forEach((v, i) => {
      const page = this.layout!.pages[i];
      const seen = need ? intersect(page, vis) : null;
      if (!seen) { this.dropTile(v); return; }
      // Render a little beyond the screen so small pans stay sharp.
      const rect = intersect(page, inflate(seen, 0.15))!;
      const local = { x: rect.x - page.x, y: rect.y - page.y, w: rect.w, h: rect.h };
      jobs.push({ i, rect: local, area: seen.w * seen.h });
    });
    // Largest visible pages first.
    jobs.sort((a, b) => b.area - a.area);
    const perTile = clamp(TOTAL_BUDGET_PX / Math.max(1, jobs.length), 1_000_000, TILE_MAX_PX);

    for (const job of jobs) {
      if (pass !== this.renderPass || gen !== this.gen) return;
      const v = this.views[job.i];
      let k = renderBucket(this.cam.s, dpr);
      const px = job.rect.w * job.rect.h * k * k;
      if (px > perTile) k = Math.sqrt(perTile / (job.rect.w * job.rect.h));
      // Reuse the existing tile if it is sharp enough and still covers what is on screen.
      const seenLocal = intersect(this.layout.pages[job.i], vis)!;
      const need2 = { x: seenLocal.x - this.layout.pages[job.i].x, y: seenLocal.y - this.layout.pages[job.i].y, w: seenLocal.w, h: seenLocal.h };
      if (v.tile && v.tile.k >= k * 0.98 && contains(v.tile.rect, need2)) continue;
      await this.renderTile(job.i, k, job.rect, pass);
    }
    this.updateStats();
  }

  private async renderTile(i: number, k: number, rect: Rect, pass: number) {
    const v = this.views[i];
    const canvas = document.createElement("canvas");
    canvas.className = "tile";
    const t0 = performance.now();
    try {
      const page = await this.doc!.getPage(i + 1);
      if (pass !== this.renderPass) { releaseCanvas(canvas); return; }
      const r = renderRegion(page, canvas, k, rect);
      this.current = r.task;
      await r.done;
      this.current = null;
      if (pass !== this.renderPass) { releaseCanvas(canvas); return; }
      canvas.style.cssText = `left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px`;
      this.dropTile(v);
      v.el.insertBefore(canvas, v.el.lastChild);
      v.tile = { canvas, k, rect };
      this.stats.lastRenderMs = Math.round(performance.now() - t0);
      this.stats.renders++;
      this.updateStats();
    } catch (e) {
      releaseCanvas(canvas);
      if ((e as { name?: string })?.name !== "RenderingCancelledException") console.warn("render failed", e);
    }
  }

  private dropTile(v: PageView) {
    if (!v.tile) return;
    v.tile.canvas.remove();
    releaseCanvas(v.tile.canvas);
    v.tile = null;
  }

  private updateStats() {
    let n = 0, px = 0;
    for (const v of this.views) if (v.tile) { n++; px += v.tile.canvas.width * v.tile.canvas.height; }
    this.stats.tiles = n;
    this.stats.tileMP = Math.round(px / 1e5) / 10;
  }

  // ---------- gestures ----------

  private bindGestures() {
    const vp = this.viewport;
    const ptrs = new Map<number, { x: number; y: number }>();
    let last: { x: number; y: number } | null = null;
    let lastDist = 0;
    let start: { x: number; y: number; t: number } | null = null;
    let moved = false;
    let downTarget: EventTarget | null = null;
    let samples: { x: number; y: number; t: number }[] = [];
    let inertia = 0;

    const local = (e: { clientX: number; clientY: number }) => {
      const r = vp.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const centroid = () => {
      let x = 0, y = 0;
      ptrs.forEach((p) => { x += p.x; y += p.y; });
      return { x: x / ptrs.size, y: y / ptrs.size };
    };
    const spread = () => {
      const [a, b] = [...ptrs.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const first = () => { if (!this.gestured) { this.gestured = true; this.hooks.onFirstGesture(); } };

    vp.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      cancelAnimationFrame(inertia);
      vp.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, local(e));
      if (ptrs.size === 1) {
        const p = local(e);
        start = { ...p, t: performance.now() };
        moved = false;
        downTarget = e.target;
        samples = [{ ...p, t: start.t }];
      } else moved = true;
      last = centroid();
      lastDist = ptrs.size > 1 ? spread() : 0;
      vp.classList.add("dragging");
    });

    vp.addEventListener("pointermove", (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, local(e));
      const c = centroid();
      if (start && Math.hypot(c.x - start.x, c.y - start.y) > 7) moved = true;
      if (!moved || !last) return;
      first();
      let cam = { ...this.cam };
      if (ptrs.size >= 2) {
        const d = spread();
        if (lastDist > 0) cam = zoomAt(cam, clamp(cam.s * (d / lastDist), this.minScale, this.maxScale), c.x, c.y);
        lastDist = d;
      }
      cam.tx += c.x - last.x;
      cam.ty += c.y - last.y;
      last = c;
      const t = performance.now();
      samples.push({ ...c, t });
      while (samples.length > 2 && t - samples[0].t > 90) samples.shift();
      this.setCamera(cam);
    });

    const end = (e: PointerEvent) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      if (ptrs.size > 0) {
        last = centroid();
        lastDist = ptrs.size > 1 ? spread() : 0;
        samples = [];
        return;
      }
      vp.classList.remove("dragging");
      if (e.type === "pointercancel") return;
      if (!moved) { first(); this.tap(downTarget, local(e)); return; }
      // Glide after a flick.
      const a = samples[0], b = samples[samples.length - 1];
      if (a && b && b.t - a.t > 10) {
        let vx = (b.x - a.x) / (b.t - a.t), vy = (b.y - a.y) / (b.t - a.t);
        if (Math.hypot(vx, vy) > 0.35) {
          let prev = performance.now();
          const step = (now: number) => {
            const dt = Math.min(32, now - prev); prev = now;
            const decay = Math.pow(0.994, dt);
            vx *= decay; vy *= decay;
            this.setCamera({ ...this.cam, tx: this.cam.tx + vx * dt, ty: this.cam.ty + vy * dt });
            if (Math.hypot(vx, vy) > 0.02) inertia = requestAnimationFrame(step);
          };
          inertia = requestAnimationFrame(step);
        }
      }
    };
    vp.addEventListener("pointerup", end);
    vp.addEventListener("pointercancel", end);

    // Trackpad and mouse wheel: pinch (ctrl) zooms, two-finger scroll pans.
    vp.addEventListener("wheel", (e) => {
      e.preventDefault();
      cancelAnimationFrame(inertia);
      first();
      const m = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.view.h : 1;
      const p = local(e);
      if (e.ctrlKey || e.metaKey) {
        this.setCamera(zoomAt(this.cam, clamp(this.cam.s * Math.exp(-e.deltaY * m * 0.01), this.minScale, this.maxScale), p.x, p.y));
      } else {
        this.setCamera({ ...this.cam, tx: this.cam.tx - e.deltaX * m, ty: this.cam.ty - e.deltaY * m });
      }
    }, { passive: false });

    // Safari on Mac reports trackpad pinch as gesture events; on iPad, pointers already handle it.
    let gStart = 1;
    const gs = (e: Event) => { e.preventDefault(); gStart = this.cam.s; };
    const gc = (e: Event) => {
      e.preventDefault();
      if (ptrs.size) return;
      const ge = e as unknown as { scale: number; clientX: number; clientY: number };
      const p = local(ge);
      this.setCamera(zoomAt(this.cam, clamp(gStart * ge.scale, this.minScale, this.maxScale), p.x, p.y));
    };
    vp.addEventListener("gesturestart", gs as EventListener);
    vp.addEventListener("gesturechange", gc as EventListener);
    document.addEventListener("gesturestart", (e) => e.preventDefault());

    // Double-tap while reading returns to the bird's-eye view.
    let lastTapAt = 0;
    this.tap = (target, p) => {
      const now = performance.now();
      const pageEl = (target as Element | null)?.closest?.(".page") as HTMLElement | null;
      const ps = this.pageScale() ?? 1;
      const zoomed = this.cam.s >= ps * 0.6;
      if (zoomed) {
        if (now - lastTapAt < 320) { this.fit(); lastTapAt = 0; }
        else lastTapAt = now;
        return;
      }
      lastTapAt = 0;
      if (pageEl) this.zoomToPage(Number(pageEl.dataset.i));
      else this.setCamera(zoomAt(this.cam, this.cam.s * 1.6, p.x, p.y), true);
    };

    window.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("textarea, input, [contenteditable]")) return;
      const step = 120;
      if (e.key === "0" || e.key === "Escape") this.fit();
      else if (e.key === "+" || e.key === "=") this.zoomBy(1.4);
      else if (e.key === "-") this.zoomBy(1 / 1.4);
      else if (e.key === "ArrowLeft") this.setCamera({ ...this.cam, tx: this.cam.tx + step }, true);
      else if (e.key === "ArrowRight") this.setCamera({ ...this.cam, tx: this.cam.tx - step }, true);
      else if (e.key === "ArrowUp") this.setCamera({ ...this.cam, ty: this.cam.ty + step }, true);
      else if (e.key === "ArrowDown") this.setCamera({ ...this.cam, ty: this.cam.ty - step }, true);
      else return;
      e.preventDefault();
    });
  }

  private tap: (target: EventTarget | null, p: { x: number; y: number }) => void = () => {};
}

function contains(outer: Rect, inner: Rect) {
  return inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 &&
    inner.x + inner.w <= outer.x + outer.w + 0.5 && inner.y + inner.h <= outer.y + outer.h + 0.5;
}
