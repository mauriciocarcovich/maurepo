// Find in the document (like Ctrl+F in a PDF reader) or in your notes.
import type { Annotation } from "./annotations";
import type { Board } from "./board";
import { rangeRects, type PageText } from "./text";

/** Case- and accent-insensitive folding that keeps string length, so offsets map 1:1. */
export function fold(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\n" || ch === "\t" || ch === " ") { out += " "; continue; }
    const code = ch.charCodeAt(0);
    if (code >= 0xd800 && code <= 0xdbff) { out += ch; continue; } // keep surrogate halves as-is
    const base = ch.normalize("NFD")[0] ?? ch;
    const low = base.toLowerCase();
    out += low.length === 1 ? low : base;
  }
  return out;
}

/** All occurrences of `q` in `text` as [start, end) offsets. Whitespace in the query matches any whitespace run of one. */
export function findAll(text: string, q: string): [number, number][] {
  const fq = fold(q).replace(/\s+/g, " ").trim();
  if (fq.length < 2) return [];
  const ft = fold(text);
  const out: [number, number][] = [];
  let i = ft.indexOf(fq);
  while (i >= 0) { out.push([i, i + fq.length]); i = ft.indexOf(fq, i + fq.length); }
  return out;
}

export type Hit =
  | { kind: "doc"; page: number; start: number; end: number }
  | { kind: "general"; start: number; end: number }
  | { kind: "note"; id: string };

export interface SearchHooks {
  pageText(i: number): Promise<PageText>;
  pageCount(): number;
  annotations(): Annotation[];
  general(): string;
  showGeneral(start: number, end: number): void;
  showNote(id: string): void;
  highlightNotes(ids: Set<string>): void;
  onOpenChange(open: boolean): void;
}

export class Search {
  open = false;
  private scope: "doc" | "notes" = "doc";
  private hits: Hit[] = [];
  private idx = -1;
  private gen = 0;
  private timer = 0;
  private indexed = 0;
  private bar = document.getElementById("searchBar")!;
  private input = document.getElementById("searchInput") as HTMLInputElement;
  private summary = document.getElementById("searchSummary")!;

  constructor(private board: Board, private hooks: SearchHooks) {
    this.input.addEventListener("input", () => { clearTimeout(this.timer); this.timer = window.setTimeout(() => void this.run(), 160); });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this.step(e.shiftKey ? -1 : 1); }
      else if (e.key === "Escape") { e.preventDefault(); this.close(); }
    });
    document.getElementById("searchPrev")!.onclick = () => this.step(-1);
    document.getElementById("searchNext")!.onclick = () => this.step(1);
    document.getElementById("searchDone")!.onclick = () => this.close();
    document.getElementById("scopeDoc")!.onclick = () => this.setScope("doc");
    document.getElementById("scopeNotes")!.onclick = () => this.setScope("notes");
    window.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") { e.preventDefault(); this.show(); }
      else if (this.open && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g") { e.preventDefault(); this.step(e.shiftKey ? -1 : 1); }
    });
  }

  show() {
    this.open = true;
    this.bar.hidden = false;
    document.getElementById("searchBtn")!.setAttribute("aria-pressed", "true");
    this.hooks.onOpenChange(true);
    this.input.focus();
    this.input.select();
    if (this.input.value.trim().length >= 2) void this.run();
  }

  close() {
    this.open = false;
    this.bar.hidden = true;
    document.getElementById("searchBtn")!.setAttribute("aria-pressed", "false");
    this.gen++;
    this.hits = [];
    this.idx = -1;
    this.paint();
    this.hooks.highlightNotes(new Set());
    this.input.blur();
    this.hooks.onOpenChange(false);
  }

  toggle() { if (this.open) this.close(); else this.show(); }

  /** Re-run after the document changes. */
  reset() { this.indexed = 0; if (this.open) void this.run(); else { this.hits = []; this.paint(); } }

  private setScope(s: "doc" | "notes") {
    this.scope = s;
    document.getElementById("scopeDoc")!.setAttribute("aria-pressed", String(s === "doc"));
    document.getElementById("scopeNotes")!.setAttribute("aria-pressed", String(s === "notes"));
    void this.run();
    this.input.focus();
  }

  private async run() {
    const gen = ++this.gen;
    const q = this.input.value;
    this.hits = [];
    this.idx = -1;
    if (fold(q).trim().length < 2) { this.paint(); this.setSummary("Type at least 2 letters"); return; }

    if (this.scope === "notes") {
      for (const [a, b] of findAll(this.hooks.general(), q)) this.hits.push({ kind: "general", start: a, end: b });
      const anns = [...this.hooks.annotations()].filter((x) => x.note !== null).sort((x, y) => x.page - y.page || x.start - y.start);
      for (const a of anns) if (findAll(a.note ?? "", q).length || findAll(a.quote, q).length) this.hits.push({ kind: "note", id: a.id });
      this.paint();
      return;
    }

    // Document: search page by page, showing results as they arrive.
    const n = this.hooks.pageCount();
    for (let p = 0; p < n; p++) {
      const t = await this.hooks.pageText(p);
      if (gen !== this.gen) return;
      for (const [a, b] of findAll(t.text, q)) this.hits.push({ kind: "doc", page: p, start: a, end: b });
      this.indexed = Math.max(this.indexed, p + 1);
      if (p % 8 === 7 || p === n - 1) this.paint(p < n - 1 ? `Searching… ${p + 1}/${n}` : undefined);
    }
  }

  step(dir: 1 | -1) {
    if (!this.hits.length) return;
    this.idx = this.idx < 0 ? (dir > 0 ? 0 : this.hits.length - 1) : (this.idx + dir + this.hits.length) % this.hits.length;
    this.paint();
    const h = this.hits[this.idx];
    if (h.kind === "doc") void this.goToDocHit(h);
    else if (h.kind === "general") this.hooks.showGeneral(h.start, h.end);
    else this.hooks.showNote(h.id);
  }

  private async goToDocHit(h: Extract<Hit, { kind: "doc" }>) {
    const t = await this.hooks.pageText(h.page);
    const r = rangeRects(t, h.start, h.end)[0];
    const page = this.board.layout?.pages[h.page];
    if (!r || !page) return;
    // Centre the match at the current zoom, but never so far out that it can't be read.
    const readable = (this.board.pageScale(h.page) ?? this.board.cam.s) * 0.55;
    this.board.flyTo(page.x + r.x + r.w / 2, page.y + r.y + r.h / 2, Math.max(this.board.cam.s, readable));
  }

  private setSummary(s: string) { this.summary.textContent = s; }

  /** Draw match boxes and per-page count badges; update the summary. */
  private paint(progress?: string) {
    const docHits = this.hits.filter((h): h is Extract<Hit, { kind: "doc" }> => h.kind === "doc");
    const perPage = new Map<number, typeof docHits>();
    for (const h of docHits) perPage.set(h.page, [...(perPage.get(h.page) ?? []), h]);
    const cur = this.hits[this.idx];
    const n = this.board.layout?.pages.length ?? 0;
    for (let p = 0; p < n; p++) {
      const el = this.board.pageEl(p);
      if (!el) continue;
      const list = perPage.get(p);
      let layer = el.querySelector(":scope > .hits") as HTMLElement | null;
      let badge = el.querySelector(":scope > .badge") as HTMLElement | null;
      if (!list) { layer?.remove(); badge?.remove(); continue; }
      if (!layer) { layer = document.createElement("div"); layer.className = "hits"; el.insertBefore(layer, el.querySelector(":scope > .pnum")); }
      if (!badge) { badge = document.createElement("span"); badge.className = "badge"; el.append(badge); }
      badge.textContent = String(list.length);
      void this.hooks.pageText(p).then((t) => {
        if (!layer!.isConnected) return;
        layer!.innerHTML = list.flatMap((h) => rangeRects(t, h.start, h.end).map((r) =>
          `<div class="${h === cur ? "cur" : ""}" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px"></div>`)).join("");
      });
    }
    this.hooks.highlightNotes(new Set(this.hits.filter((h) => h.kind === "note").map((h) => (h as { id: string }).id)));

    if (progress) { this.setSummary(progress); return; }
    const total = this.hits.length;
    const pre = this.idx >= 0 ? `${this.idx + 1} of ` : "";
    if (this.scope === "doc") {
      this.setSummary(total ? `${pre}${total} · ${perPage.size} page${perPage.size === 1 ? "" : "s"}` : fold(this.input.value).trim().length >= 2 ? "No matches" : "Type at least 2 letters");
    } else {
      this.setSummary(total ? `${pre}${total} in notes` : "No matches in notes");
    }
  }
}
