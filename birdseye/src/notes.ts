// The floating Notes panel: a fixed-size overlay you can drag, resize and minimize.
// Geometry is kept as fractions of the screen so it keeps its proportions on any screen.
import { clamp, type Rect } from "./geometry";
import type { PanelGeom } from "./store";
import { TAGS, TAG_ORDER, type Annotation, type Tag } from "./annotations";

const MIN_W = 280;
const MIN_H = 240;
const MARGIN = 8;
const TOP_RESERVED = 72; // keep the header below the top bar

export interface NotesHooks {
  onGeometry(g: PanelGeom): void;
  onText(text: string): void;
  onLinkedOpen(open: boolean): void;
  onExport(): void;
  onGo(id: string): void;
  onNoteText(id: string, text: string): void;
}

export class NotesPanel {
  geom: PanelGeom;
  private el = byId("notes");
  private head = byId("notesHead");
  private pill = byId("notesPill") as HTMLButtonElement;
  private text = byId("general") as HTMLTextAreaElement;
  private linkedToggle = byId("linkedToggle");
  private linkedList = byId("linkedList");
  private kbShift = 0;
  private linked: Annotation[] = [];
  private filter: Tag | null = null;
  private peek: string | null = null;
  private active: string | null = null;
  private cardEls = new Map<string, HTMLElement>();
  private cardsBox = byId("cards");
  private chipsBox = byId("linkedChips");

  constructor(geom: PanelGeom, text: string, private linkedOpen: boolean, private hooks: NotesHooks) {
    this.geom = { ...geom };
    this.text.value = text;
    this.bind();
    this.renderLinked();
    this.layout();
  }

  /** The panel's screen rect, or null when minimized. */
  rect(): Rect | null {
    if (this.geom.min) return null;
    const r = this.el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  setText(t: string) { this.text.value = t; }
  get value() { return this.text.value; }

  setMinimized(min: boolean) {
    this.geom.min = min;
    this.layout();
    this.hooks.onGeometry(this.geom);
  }

  /** Pixel box from the stored fractions, clamped so the panel is always reachable. */
  private box() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = clamp(this.geom.fw * vw, Math.min(MIN_W, vw - 2 * MARGIN), vw - 2 * MARGIN);
    const h = clamp(this.geom.fh * vh, Math.min(MIN_H, vh - TOP_RESERVED - MARGIN), vh - TOP_RESERVED - MARGIN);
    const x = clamp(this.geom.fx * vw, MARGIN, vw - w - MARGIN);
    const y = clamp(this.geom.fy * vh, TOP_RESERVED, Math.max(TOP_RESERVED, vh - h - MARGIN));
    return { x, y, w, h };
  }

  layout() {
    const b = this.box();
    this.el.hidden = this.geom.min;
    this.pill.hidden = !this.geom.min;
    this.el.style.left = b.x + "px";
    this.el.style.top = b.y - this.kbShift + "px";
    this.el.style.width = b.w + "px";
    this.el.style.height = b.h + "px";
    this.pill.style.left = b.x + "px";
    this.pill.style.top = b.y + "px";
    byId("notesToggle").setAttribute("aria-pressed", String(!this.geom.min));
  }

  private setBox(b: { x: number; y: number; w: number; h: number }) {
    const vw = window.innerWidth, vh = window.innerHeight;
    this.geom = { ...this.geom, fx: b.x / vw, fy: b.y / vh, fw: b.w / vw, fh: b.h / vh };
    this.layout();
  }

  /** Annotations with notes, shown as cards under "Linked passages". */
  setLinked(all: Annotation[]) {
    this.linked = all.filter((a) => a.note !== null).sort((a, b) => a.page - b.page || a.start - b.start);
    if (this.peek && !this.linked.some((a) => a.id === this.peek)) this.peek = null;
    this.renderLinked();
  }

  /** Bring a linked note into view (opening the panel, or peeking at one card if the list is hidden). */
  focusCard(id: string, focusText = false) {
    if (this.geom.min) this.setMinimized(false);
    this.filter = null;
    if (!this.linkedOpen) this.peek = id;
    this.active = id;
    this.renderLinked();
    const el = this.cardEls.get(id);
    if (el) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      if (focusText) setTimeout(() => (el.querySelector("textarea") as HTMLTextAreaElement | null)?.focus(), 250);
    }
  }

  private renderLinked() {
    const open = this.linkedOpen;
    this.linkedToggle.setAttribute("aria-expanded", String(open));
    byId("linkedAct").textContent = open ? "Hide" : this.peek ? "Show all" : "Show";
    byId("linkedCount").textContent = String(this.linked.length);
    const box = byId("linked");
    box.classList.toggle("open", open);
    box.classList.toggle("peek", !open && !!this.peek);
    this.linkedList.hidden = !(open && this.linked.length === 0);

    // Filter chips
    this.chipsBox.hidden = !open || this.linked.length === 0;
    if (!this.chipsBox.hidden) {
      this.chipsBox.replaceChildren(...TAG_ORDER.map((t) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "chip";
        const on = this.filter === t;
        b.setAttribute("aria-pressed", String(on));
        if (on) { b.style.background = TAGS[t].chipBg; b.style.color = TAGS[t].chipInk; b.style.boxShadow = `inset 0 0 0 1.5px ${TAGS[t].dot}`; }
        b.innerHTML = `<i style="background:${TAGS[t].dot}"></i>${TAGS[t].label}<span class="n">${this.linked.filter((a) => a.tag === t).length}</span>`;
        b.onclick = () => { this.filter = on ? null : t; this.renderLinked(); };
        return b;
      }));
    }

    const shown = open ? this.linked.filter((a) => !this.filter || a.tag === this.filter)
      : this.peek ? this.linked.filter((a) => a.id === this.peek) : [];
    // Keyed update so typing in a card never loses focus.
    const keep = new Set(shown.map((a) => a.id));
    for (const [id, el] of this.cardEls) if (!keep.has(id)) { el.remove(); this.cardEls.delete(id); }
    shown.forEach((a, idx) => {
      let el = this.cardEls.get(a.id);
      if (!el) { el = this.makeCard(a.id); this.cardEls.set(a.id, el); }
      this.fillCard(el, a);
      if (this.cardsBox.children[idx] !== el) this.cardsBox.insertBefore(el, this.cardsBox.children[idx] ?? null);
    });
  }

  private makeCard(id: string) {
    const el = document.createElement("article");
    el.className = "card";
    el.dataset.card = id;
    el.innerHTML = `<div class="row"><span class="tagchip"><i></i><span class="tl"></span></span><span class="pg"></span>
      <button type="button" class="go" aria-label="Show passage on canvas"><svg class="icon"><use href="#i-go"/></svg></button></div>
      <button type="button" class="quote"></button>
      <textarea rows="2" aria-label="Note on this passage" placeholder="Add a thought…" spellcheck="true"></textarea>`;
    const go = () => { this.active = id; this.renderLinked(); this.hooks.onGo(id); };
    (el.querySelector(".go") as HTMLElement).onclick = go;
    (el.querySelector(".quote") as HTMLElement).onclick = go;
    const ta = el.querySelector("textarea")!;
    ta.addEventListener("input", () => this.hooks.onNoteText(id, ta.value));
    return el;
  }

  private fillCard(el: HTMLElement, a: Annotation) {
    const t = TAGS[a.tag];
    const chip = el.querySelector(".tagchip") as HTMLElement;
    chip.style.background = t.chipBg;
    chip.style.color = t.chipInk;
    (chip.querySelector("i") as HTMLElement).style.background = t.dot;
    chip.querySelector(".tl")!.textContent = t.label;
    el.querySelector(".pg")!.textContent = `p. ${a.page + 1}`;
    el.querySelector(".quote")!.textContent = `“${a.quote}”`;
    const ta = el.querySelector("textarea")!;
    if (document.activeElement !== ta && ta.value !== (a.note ?? "")) ta.value = a.note ?? "";
    el.classList.toggle("active", this.active === a.id);
  }

  private bind() {
    // Drag by the header.
    let drag: { px: number; py: number; b: ReturnType<NotesPanel["box"]> } | null = null;
    this.head.addEventListener("pointerdown", (e) => {
      if ((e.target as Element).closest("button") || (e.pointerType === "mouse" && e.button !== 0)) return;
      this.head.setPointerCapture(e.pointerId);
      drag = { px: e.clientX, py: e.clientY, b: this.box() };
      this.head.classList.add("dragging");
    });
    this.head.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const vw = window.innerWidth, vh = window.innerHeight;
      // Allow tucking most of the panel off-screen, but keep a handle visible.
      const x = clamp(drag.b.x + e.clientX - drag.px, -drag.b.w + 120, vw - 120);
      const y = clamp(drag.b.y + e.clientY - drag.py, TOP_RESERVED, vh - 64);
      this.el.style.left = x + "px";
      this.el.style.top = y + "px";
    });
    const endDrag = () => {
      if (!drag) return;
      drag = null;
      this.head.classList.remove("dragging");
      const r = this.el.getBoundingClientRect();
      this.setBox({ x: r.left, y: r.top, w: r.width, h: r.height });
      this.hooks.onGeometry(this.geom);
    };
    this.head.addEventListener("pointerup", endDrag);
    this.head.addEventListener("pointercancel", endDrag);

    // Resize from the corner handle (works with a finger, unlike the browser's built-in grip).
    const grip = byId("notesResize");
    let rs: { px: number; py: number; b: ReturnType<NotesPanel["box"]> } | null = null;
    grip.addEventListener("pointerdown", (e) => {
      grip.setPointerCapture(e.pointerId);
      const r = this.el.getBoundingClientRect();
      rs = { px: e.clientX, py: e.clientY, b: { x: r.left, y: r.top, w: r.width, h: r.height } };
      e.preventDefault();
    });
    grip.addEventListener("pointermove", (e) => {
      if (!rs) return;
      const vw = window.innerWidth, vh = window.innerHeight;
      const w = clamp(rs.b.w + e.clientX - rs.px, MIN_W, vw - rs.b.x - MARGIN);
      const h = clamp(rs.b.h + e.clientY - rs.py, MIN_H, vh - rs.b.y - MARGIN);
      this.el.style.width = w + "px";
      this.el.style.height = h + "px";
    });
    const endResize = () => {
      if (!rs) return;
      rs = null;
      const r = this.el.getBoundingClientRect();
      this.setBox({ x: r.left, y: r.top, w: r.width, h: r.height });
      this.hooks.onGeometry(this.geom);
    };
    grip.addEventListener("pointerup", endResize);
    grip.addEventListener("pointercancel", endResize);

    byId("notesMin").addEventListener("click", () => this.setMinimized(true));
    this.pill.addEventListener("click", () => this.setMinimized(false));
    this.text.addEventListener("input", () => this.hooks.onText(this.text.value));
    byId("exportBtn").addEventListener("click", () => this.hooks.onExport());
    this.linkedToggle.addEventListener("click", () => {
      this.linkedOpen = !this.linkedOpen;
      this.peek = null;
      this.renderLinked();
      this.hooks.onLinkedOpen(this.linkedOpen);
    });

    window.addEventListener("resize", () => this.layout());

    // Keep the line you are typing above the on-screen keyboard.
    const vv = window.visualViewport;
    if (vv) {
      const onVV = () => {
        const focused = this.el.contains(document.activeElement) && document.activeElement?.tagName === "TEXTAREA";
        const visibleBottom = vv.offsetTop + vv.height;
        const b = this.box();
        const overflow = b.y + b.h - (visibleBottom - MARGIN);
        const next = focused && overflow > 0 ? Math.min(overflow, b.y - MARGIN) : 0;
        if (next !== this.kbShift) { this.kbShift = next; this.layout(); }
      };
      vv.addEventListener("resize", onVV);
      vv.addEventListener("scroll", onVV);
      this.text.addEventListener("focus", () => setTimeout(onVV, 300));
      this.text.addEventListener("blur", () => setTimeout(onVV, 100));
    }
  }
}

function byId(id: string) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}
