// Highlights, underlines and passage-linked notes, drawn as a layer over each page.
import type { Board } from "./board";
import { clamp, type Rect } from "./geometry";
import type { PDFDocumentProxy } from "./pdf";
import { buildPageText, hitTest, quoteOf, rangeRects, wordAt, type PageText } from "./text";

export type Tag = "yellow" | "blue" | "coral" | "green";
export const TAG_ORDER: Tag[] = ["yellow", "blue", "coral", "green"];
export const TAGS: Record<Tag, { label: string; mark: string; dot: string; chipBg: string; chipInk: string }> = {
  yellow: { label: "Important", mark: "rgba(255,214,10,.5)", dot: "#F5C400", chipBg: "#FFF3B8", chipInk: "#5E4A00" },
  blue: { label: "Question", mark: "rgba(90,200,250,.42)", dot: "#32ADE6", chipBg: "#DDF2FF", chipInk: "#004E80" },
  coral: { label: "Disagree", mark: "rgba(255,105,97,.36)", dot: "#FF5A4F", chipBg: "#FFE3E0", chipInk: "#8E1B12" },
  green: { label: "Idea", mark: "rgba(48,209,88,.36)", dot: "#28C24F", chipBg: "#DCF6E3", chipInk: "#13612C" },
};

export interface Annotation {
  id: string;
  page: number; // 0-based
  start: number; end: number; // character offsets in the page text index
  quote: string; prefix: string; suffix: string; // re-anchoring if the index ever changes
  rects: Rect[]; // fractions of the page width/height, so they line up at any zoom
  tag: Tag;
  underline: boolean;
  note: string | null; // null = plain highlight; a string (even empty) = linked note
  createdAt: number; updatedAt: number;
}

export interface AnnotatorHooks {
  onChange(list: Annotation[]): void;
  onNoteRequested(id: string): void; // "Add note" / "Open note" / pin tapped
  onPinTapped(id: string): void;
}

/** Extend a selection to whole words at both ends, like iPad text selection. */
function snapWords(t: PageText, a: number, b: number): [number, number] | null {
  if (b < a) [a, b] = [b, a];
  if (a === b) return null;
  const wa = wordAt(t, a);
  const wb = wordAt(t, Math.max(a, b - 1));
  const s = wa && wa[0] < a ? wa[0] : a;
  const e = wb && wb[1] > b ? wb[1] : b;
  // Trim whitespace at the edges.
  let x = s, y = e;
  while (x < y && /\s/.test(t.text[x])) x++;
  while (y > x && /\s/.test(t.text[y - 1])) y--;
  return y > x ? [x, y] : null;
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export class Annotator {
  list: Annotation[] = [];
  lastTag: Tag = "yellow";
  private doc: PDFDocumentProxy | null = null;
  private texts = new Map<number, Promise<PageText>>();
  private ready = new Map<number, PageText>();
  private gen = 0;
  private pop = document.getElementById("annPop")!;
  private popFor: string | null = null;
  private sel: { page: number; anchor: number | null; focus: number | null; startPt: { x: number; y: number } } | null = null;

  constructor(private board: Board, private hooks: AnnotatorHooks) {
    this.bindPopover();
  }

  setDocument(doc: PDFDocumentProxy, list: Annotation[]) {
    this.gen++;
    this.doc = doc;
    this.texts.clear();
    this.ready.clear();
    this.list = list;
    this.hidePopover();
    const pages = new Set(list.map((a) => a.page));
    this.board.layout?.pages.forEach((_, i) => this.drawPage(i, pages.has(i)));
  }

  /** Load text for pages before the user selects on them. */
  preload(pages: number[]) { for (const p of pages) void this.text(p); }

  private text(i: number): Promise<PageText> {
    let p = this.texts.get(i);
    if (!p) {
      const gen = this.gen;
      p = this.doc!.getPage(i + 1).then(buildPageText).then((t) => { if (gen === this.gen) this.ready.set(i, t); return t; });
      p.catch(() => this.texts.delete(i));
      this.texts.set(i, p);
    }
    return p;
  }

  // ---------- selection (driven by the board's gestures) ----------

  selectStart(page: number, pt: { x: number; y: number }) {
    this.hidePopover();
    this.sel = { page, anchor: null, focus: null, startPt: pt };
    const t = this.ready.get(page);
    if (t) this.sel.anchor = hitTest(t, pt.x, pt.y);
    else void this.text(page).then((tt) => { if (this.sel?.page === page && this.sel.anchor == null) this.sel.anchor = hitTest(tt, pt.x, pt.y); });
  }

  selectMove(pt: { x: number; y: number }) {
    const s = this.sel;
    if (!s) return;
    const t = this.ready.get(s.page);
    if (!t || s.anchor == null) return;
    s.focus = hitTest(t, pt.x, pt.y);
    const r = s.focus != null ? snapWords(t, s.anchor, s.focus) : null;
    this.drawSelection(r ? rangeRects(t, r[0], r[1]) : []);
  }

  selectEnd() {
    const s = this.sel;
    this.sel = null;
    this.drawSelection([]);
    if (!s || s.anchor == null || s.focus == null || s.anchor === s.focus) return;
    const t = this.ready.get(s.page);
    const r = t && snapWords(t, s.anchor, s.focus);
    if (r) this.create(s.page, r[0], r[1]);
  }

  selectCancel() { this.sel = null; this.drawSelection([]); }

  /** Tap: open an existing highlight, or in select mode highlight the word under the finger. */
  tap(target: Element | null, page: number | null, pt: { x: number; y: number } | null, selecting: boolean, zoomedIn: boolean): boolean {
    const pin = target?.closest?.("[data-pin]") as HTMLElement | null;
    if (pin) { this.hooks.onPinTapped(pin.dataset.pin!); return true; }
    const hit = target?.closest?.("[data-ann]") as HTMLElement | null;
    if (hit && (selecting || zoomedIn)) { this.showPopover(hit.dataset.ann!); return true; }
    if (this.popFor) { this.hidePopover(); return true; }
    if (!selecting || page == null || !pt) return false;
    void this.text(page).then((t) => {
      const at = hitTest(t, pt.x, pt.y);
      const w = at == null ? null : wordAt(t, at);
      if (w) this.create(page, w[0], w[1]);
    });
    return true;
  }

  private create(page: number, a: number, b: number) {
    const t = this.ready.get(page);
    const r = this.board.layout?.pages[page];
    if (!t || !r) return;
    const rects = rangeRects(t, a, b).map((q) => ({ x: q.x / r.w, y: q.y / r.h, w: q.w / r.w, h: q.h / r.h }));
    if (!rects.length) return;
    const now = Date.now();
    const ann: Annotation = { id: uid(), page, start: a, end: b, ...quoteOf(t, a, b), rects, tag: this.lastTag, underline: false, note: null, createdAt: now, updatedAt: now };
    this.list = [...this.list, ann];
    this.changed(page);
    this.showPopover(ann.id);
  }

  update(id: string, patch: Partial<Annotation>) {
    const a = this.list.find((x) => x.id === id);
    if (!a) return;
    Object.assign(a, patch, { updatedAt: Date.now() });
    this.list = [...this.list];
    this.changed(a.page);
  }

  remove(id: string) {
    const a = this.list.find((x) => x.id === id);
    if (!a) return;
    this.list = this.list.filter((x) => x.id !== id);
    this.changed(a.page);
    if (this.popFor === id) this.hidePopover();
  }

  private changed(page: number) {
    this.drawPage(page, true);
    this.hooks.onChange(this.list);
    if (this.popFor) this.renderPopover();
  }

  // ---------- drawing ----------

  private layer(i: number, cls: string): HTMLElement | null {
    const el = this.board.pageEl(i);
    if (!el) return null;
    let l = el.querySelector(`:scope > .${cls}`) as HTMLElement | null;
    if (!l) {
      l = document.createElement("div");
      l.className = cls;
      el.insertBefore(l, el.querySelector(":scope > .pnum"));
    }
    return l;
  }

  drawPage(i: number, force = false) {
    const items = this.list.filter((a) => a.page === i);
    if (!items.length && !force) return;
    const l = this.layer(i, "ann");
    if (!l) return;
    const parts: string[] = [];
    for (const a of items) {
      const t = TAGS[a.tag];
      for (const q of a.rects) {
        const style = `left:${q.x * 100}%;top:${q.y * 100}%;width:${q.w * 100}%;height:${q.h * 100}%;` +
          (a.underline ? `border-bottom:max(1.2px, calc(1.6px * var(--inv)));border-bottom-style:solid;border-color:${t.dot};` : `background:${t.mark};`);
        parts.push(`<div class="mark${a.underline ? " u" : ""}" data-ann="${a.id}" style="${style}"></div>`);
      }
      if (a.note !== null && a.rects[0]) {
        const q = a.rects[0];
        parts.push(`<button type="button" class="pin" data-pin="${a.id}" aria-label="Open note: ${t.label}, page ${a.page + 1}" style="left:calc(${q.x * 100}% - max(8px, 18px * var(--inv)));top:${(q.y + q.h / 2) * 100}%;background:${t.dot}"><svg class="icon"><use href="#i-lines"/></svg></button>`);
      }
    }
    l.innerHTML = parts.join("");
  }

  private drawSelection(rects: Rect[]) {
    const page = this.sel?.page ?? this.lastSelPage;
    if (page == null) return;
    this.lastSelPage = page;
    const l = this.layer(page, "sel");
    if (!l) return;
    l.innerHTML = rects.map((q) => `<div style="left:${q.x}px;top:${q.y}px;width:${q.w}px;height:${q.h}px"></div>`).join("");
  }
  private lastSelPage: number | null = null;

  flash(id: string) {
    const a = this.list.find((x) => x.id === id);
    if (!a) return;
    const els = this.board.pageEl(a.page)?.querySelectorAll(`[data-ann="${a.id}"]`);
    els?.forEach((e) => { e.classList.remove("flash"); void (e as HTMLElement).offsetWidth; e.classList.add("flash"); });
  }

  /** World point at the centre of an annotation. */
  center(id: string) {
    const a = this.list.find((x) => x.id === id);
    const r = a && this.board.layout?.pages[a.page];
    if (!a || !r || !a.rects.length) return null;
    const x0 = Math.min(...a.rects.map((q) => q.x)), x1 = Math.max(...a.rects.map((q) => q.x + q.w));
    const y0 = Math.min(...a.rects.map((q) => q.y)), y1 = Math.max(...a.rects.map((q) => q.y + q.h));
    return { x: r.x + ((x0 + x1) / 2) * r.w, y: r.y + ((y0 + y1) / 2) * r.h, page: a.page };
  }

  // ---------- popover ----------

  showPopover(id: string) { this.popFor = id; this.renderPopover(); }
  hidePopover() { this.popFor = null; this.pop.hidden = true; }
  get popoverOpen() { return !!this.popFor; }

  private renderPopover() {
    const a = this.list.find((x) => x.id === this.popFor);
    if (!a) { this.hidePopover(); return; }
    this.pop.querySelectorAll<HTMLButtonElement>("[data-tag]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tag === a.tag)));
    this.pop.querySelector("#popTag")!.textContent = TAGS[a.tag].label;
    this.pop.querySelector("#popU")!.setAttribute("aria-pressed", String(a.underline));
    this.pop.querySelector("#popNoteLabel")!.textContent = a.note === null ? "Add note" : "Open note";
    this.pop.hidden = false;
    this.placePopover(a);
  }

  placePopover(a?: Annotation) {
    a ??= this.list.find((x) => x.id === this.popFor);
    const r = a && this.board.layout?.pages[a.page];
    if (!a || !r) return;
    const cam = this.board.cam;
    const xs = a.rects.map((q) => r.x + q.x * r.w), ys = a.rects.map((q) => r.y + q.y * r.h);
    const ye = a.rects.map((q) => r.y + (q.y + q.h) * r.h);
    const sx = ((Math.min(...xs) + Math.max(...a.rects.map((q, k) => xs[k] + q.w * r.w))) / 2) * cam.s + cam.tx;
    const top = Math.min(...ys) * cam.s + cam.ty, bottom = Math.max(...ye) * cam.s + cam.ty;
    const pw = this.pop.offsetWidth || 420, ph = this.pop.offsetHeight || 48;
    let y = top - ph - 12;
    if (y < 76) y = bottom + 12;
    y = clamp(y, 76, window.innerHeight - ph - 12);
    this.pop.style.left = clamp(sx - pw / 2, 12, window.innerWidth - pw - 12) + "px";
    this.pop.style.top = y + "px";
  }

  private bindPopover() {
    this.pop.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.pop.addEventListener("click", (e) => {
      const b = (e.target as Element).closest("button") as HTMLButtonElement | null;
      const id = this.popFor;
      if (!b || !id) return;
      const a = this.list.find((x) => x.id === id);
      if (!a) return;
      if (b.dataset.tag) { this.lastTag = b.dataset.tag as Tag; this.update(id, { tag: b.dataset.tag as Tag }); }
      else if (b.id === "popU") this.update(id, { underline: !a.underline });
      else if (b.id === "popDel") this.remove(id);
      else if (b.id === "popNote") {
        if (a.note === null) this.update(id, { note: "" });
        this.hidePopover();
        this.hooks.onNoteRequested(id);
      }
    });
  }
}
