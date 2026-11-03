// The floating Notes panel: a fixed-size overlay you can drag, resize and minimize.
// Geometry is kept as fractions of the screen so it keeps its proportions on any screen.
import { clamp, type Rect } from "./geometry";
import type { PanelGeom } from "./store";

const MIN_W = 280;
const MIN_H = 240;
const MARGIN = 8;
const TOP_RESERVED = 72; // keep the header below the top bar

export interface NotesHooks {
  onGeometry(g: PanelGeom): void;
  onText(text: string): void;
  onLinkedOpen(open: boolean): void;
  onExport(): void;
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

  private renderLinked() {
    this.linkedToggle.setAttribute("aria-expanded", String(this.linkedOpen));
    byId("linkedAct").textContent = this.linkedOpen ? "Hide" : "Show";
    this.linkedList.hidden = !this.linkedOpen;
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
      this.renderLinked();
      this.hooks.onLinkedOpen(this.linkedOpen);
    });

    window.addEventListener("resize", () => this.layout());

    // Keep the line you are typing above the on-screen keyboard.
    const vv = window.visualViewport;
    if (vv) {
      const onVV = () => {
        const focused = document.activeElement === this.text;
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
