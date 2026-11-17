import "./styles.css";
import { Board } from "./board";
import { bestLayout, freeRegion, layoutPages, type Camera, type Rect } from "./geometry";
import { NotesPanel } from "./notes";
import { closePdf, meaninglessName, openPdf, pageSizes, pdfTitle, type PDFDocumentProxy } from "./pdf";
import { Annotator, type Annotation } from "./annotations";
import { buildBrief } from "./export";
import { Search } from "./search";
import { largestLine } from "./text";
import {
  countAnnotations, deleteDoc, flushAnnotations, flushDocNotes, flushWorkspace, getDoc, getThumb, listDocs, loadAnnotations,
  loadDocNote, loadWorkspace, onSaveState, putDoc, requestPersistence, saveAnnotations, saveDocNote, saveWorkspace, sha256,
  pruneOldThumbs, storageUsage, updateDocMeta, type DocMeta, type Workspace,
} from "./store";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const TOP = 76; // below the top bar
const TOP_SEARCH = 136; // below the top bar and the search bar
const BOTTOM = 16;

let ws: Workspace;
let notes: NotesPanel;
let board: Board;
let doc: PDFDocumentProxy | null = null;
let meta: DocMeta | null = null;
let title = "";
let annot: Annotator;
let search: Search;

function region(): Rect {
  const view = { w: window.innerWidth, h: window.innerHeight };
  return freeRegion(view, notes?.rect() ?? null, search?.open ? TOP_SEARCH : TOP, BOTTOM);
}

function save(delay?: number) { saveWorkspace({ ...ws, general: "" }, delay); }

/** Key the general notes are stored under: the open document, or a scratch pad when none is open. */
const noteKey = () => meta?.id ?? "_none";

const askPassword = (retry: boolean) =>
  prompt(retry ? "That password didn’t work. Try again:" : "This PDF is password-protected. Enter its password:");

function flushAll() {
  save(0);
  void flushWorkspace();
  void flushAnnotations();
  void flushDocNotes();
}

// ---------- feedback ----------

let toastTimer = 0;
function toast(msg: string, ms = 2600, action?: { label: string; run: () => void }) {
  const t = $("toast"), act = $<HTMLButtonElement>("toastAct");
  $("toastText").textContent = msg;
  act.hidden = !action;
  t.classList.toggle("has-act", !!action);
  if (action) {
    act.textContent = action.label;
    act.onclick = () => { t.hidden = true; action.run(); };
  }
  t.hidden = false;
  placeCentered(t);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}

function placeCentered(el: HTMLElement) {
  const r = region();
  el.style.left = r.x + r.w / 2 + "px";
}

function updateChrome() {
  const fit = board.fitCamera;
  $("zoomPct").textContent = fit ? Math.round((board.cam.s / fit.s) * 100) + "%" : "—";
  placeCentered($("hint"));
  placeCentered($("empty"));
  const r = region(), sb = $("searchBar");
  const w = Math.min(640, r.w - 16);
  sb.style.width = w + "px";
  sb.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.x + r.w / 2 - w / 2)) + "px";
}

function setDocLabel() {
  $("docTitle").textContent = meta ? title : "Bird’s-Eye";
  $("docSub").textContent = meta ? `${meta.pageSizes.length} pages · Bird’s-eye view` : "Open a PDF to begin";
  $("empty").hidden = !!meta;
  document.title = meta ? `${title} — Bird’s-Eye` : "Bird’s-Eye";
}

function setMode(m: "pan" | "select") {
  board.mode = m;
  $("modePan").setAttribute("aria-pressed", String(m === "pan"));
  $("modeSelect").setAttribute("aria-pressed", String(m === "select"));
  document.body.classList.toggle("select-mode", m === "select");
  $("hint").textContent = m === "select"
    ? "Drag across text to highlight · Tap a word · Two fingers still pan and zoom"
    : "Drag to pan · Pinch to zoom · Tap a page to read it · Double-tap to return";
  $("hint").classList.remove("gone");
  if (m === "select" && !board.zoomedIn && meta) toast("Zoom in on a page to select text comfortably.");
}

// ---------- documents ----------

async function showDocument(m: DocMeta, file: Blob, restore: boolean) {
  const buf = await file.arrayBuffer();
  const old = doc;
  const opened = await openPdf(buf, askPassword);
  await flushDocNotes(); // keep the previous document's notes
  if (search.open) search.close();
  annot.hidePopover();
  doc = opened;
  meta = m;
  m.openedAt = Date.now();
  void updateDocMeta(m);
  ws.docId = m.id;
  const r = region();
  const cols = ws.cols[m.id];
  const layout = cols ? layoutPages(m.pageSizes, cols) : bestLayout(m.pageSizes, { w: r.w, h: r.h });
  ws.cols = { ...ws.cols, [m.id]: layout.cols };
  await board.setDocument(doc, m.id, layout);
  void closePdf(old);
  const list = await loadAnnotations<Annotation>(m.id);
  annot.setDocument(doc, list);
  notes.setLinked(list);
  notes.setText((await loadDocNote(m.id)) ?? "");
  title = m.title || m.autoTitle || m.name.replace(/\.pdf$/i, "");
  setDocLabel();
  search.reset();
  if (!m.title && !m.autoTitle && meaninglessName(m.name)) {
    // The file name says nothing: use the PDF's stored title, else the biggest heading on page 1.
    const t = (await pdfTitle(doc)) ?? largestLine(await annot.pageText(0));
    if (t && meta?.id === m.id) { title = t; m.autoTitle = t; void updateDocMeta(m); setDocLabel(); }
  }
  const v = ws.views[m.id];
  if (restore && v) board.restoreView(v);
  else board.fit(false);
  updateChrome();
  save();
}

async function importFile(file: File) {
  if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { toast("That file is not a PDF."); return; }
  toast(`Opening “${file.name}”…`, 8000);
  try {
    const buf = await file.arrayBuffer();
    const id = await sha256(buf);
    const existing = await getDoc(id);
    let m: DocMeta;
    if (existing) m = existing.meta;
    else {
      const probe = await openPdf(buf, askPassword);
      m = { id, name: file.name, bytes: file.size, pageSizes: await pageSizes(probe), addedAt: Date.now() };
      await closePdf(probe);
      await putDoc(m, new Blob([buf], { type: "application/pdf" }));
    }
    await showDocument(m, new Blob([buf]), !!existing);
    save(0);
    const persisted = await requestPersistence();
    toast(existing ? "Opened. Your notes and view are as you left them." : persisted ? "Saved on this device." : "Saved on this device. Install to the Home Screen so Safari keeps it.");
  } catch (e) {
    console.error(e);
    const pw = (e as { name?: string })?.name === "PasswordException";
    toast(pw ? "Couldn’t open that PDF without its password." : "Couldn’t open that PDF. It may be damaged.", 5000);
  }
}

async function openFromLibrary(id: string) {
  closeSheets();
  if (meta?.id === id) return;
  const saved = await getDoc(id);
  if (!saved) { toast("That document is no longer on this device."); return; }
  try { await showDocument(saved.meta, saved.file, true); }
  catch { toast("Couldn’t open that PDF."); }
}

// ---------- sheets: library and export ----------

function openSheet(id: "library" | "exportSheet") {
  closeSheets();
  $("backdrop").hidden = false;
  $(id).hidden = false;
}
function closeSheets() {
  $("backdrop").hidden = true;
  $("library").hidden = true;
  $("exportSheet").hidden = true;
}

const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);
function ago(t?: number) {
  if (!t) return "";
  const d = Math.floor((Date.now() - t) / 86400000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : d < 30 ? `${d} days ago` : new Date(t).toLocaleDateString();
}

const libUrls: string[] = [];
async function renderLibrary() {
  const box = $("libList");
  libUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  const docs = (await listDocs()).sort((a, b) => (b.openedAt ?? b.addedAt) - (a.openedAt ?? a.addedAt));
  if (!docs.length) {
    box.innerHTML = `<p class="lib-empty">No documents yet. Open a PDF to start.</p>`;
  } else {
    const rows = await Promise.all(docs.map(async (d) => {
      const [c, thumb] = await Promise.all([countAnnotations(d.id), getThumb(d.id, 0)]);
      const row = document.createElement("div");
      row.className = "doc-row" + (d.id === meta?.id ? " current" : "");
      const name = d.title || d.autoTitle || d.name.replace(/\.pdf$/i, "");
      const bits = [`${d.pageSizes.length} pages`, c.notes ? `${c.notes} note${c.notes === 1 ? "" : "s"}` : "", c.highlights ? `${c.highlights} highlight${c.highlights === 1 ? "" : "s"}` : "", d.id === meta?.id ? "open now" : ago(d.openedAt ?? d.addedAt)].filter(Boolean);
      const open = document.createElement("button");
      open.type = "button";
      open.className = "open";
      if (thumb) { const u = URL.createObjectURL(thumb); libUrls.push(u); open.innerHTML = `<img alt="" src="${u}">`; }
      else open.innerHTML = `<span class="ph"></span>`;
      const txt = document.createElement("span");
      txt.className = "txt";
      txt.innerHTML = `<span class="t"></span><span class="m"></span>`;
      txt.querySelector(".t")!.textContent = name;
      txt.querySelector(".m")!.textContent = bits.join(" · ");
      open.append(txt);
      open.onclick = () => void openFromLibrary(d.id);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "del";
      del.setAttribute("aria-label", `Delete ${name}`);
      del.innerHTML = `<svg class="icon" style="width:18px;height:18px"><use href="#i-trash"/></svg>`;
      del.onclick = async () => {
        if (!confirm(`Delete “${name}” and all its notes and highlights from this device?`)) return;
        await deleteDoc(d.id);
        const views = { ...ws.views }; delete views[d.id];
        ws.views = views;
        if (d.id === meta?.id) { ws.docId = null; flushAll(); location.reload(); return; }
        save();
        void renderLibrary();
      };
      row.append(open, del);
      return row;
    }));
    box.replaceChildren(...rows);
  }
  const u = await storageUsage();
  $("libFoot").textContent = `${docs.length} document${docs.length === 1 ? "" : "s"}` + (u ? ` · ${fmtBytes(u.used)} used on this device` : "") + " · Stored only on this device";
}

async function showLibrary() {
  openSheet("library");
  await renderLibrary();
}

// ---------- export / backup ----------

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const stamp = () => new Date().toISOString().slice(0, 10);
const baseName = () => (meta ? title : "Notes").replace(/[\\/:*?"<>|]/g, "-");

function brief() {
  return buildBrief({
    title: meta ? title : "Notes",
    pages: meta?.pageSizes.length ?? 0,
    date: stamp(),
    general: notes.value,
    annotations: annot.list,
    groupBy: ws.exportGroup ?? "page",
    includeHighlights: ws.exportHighlights ?? true,
    includeGeneral: ws.exportGeneral ?? true,
  });
}

function renderExport() {
  document.querySelectorAll<HTMLButtonElement>("#exportSheet [data-group]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.group === (ws.exportGroup ?? "page"))));
  $<HTMLInputElement>("exHl").checked = ws.exportHighlights ?? true;
  $<HTMLInputElement>("exGen").checked = ws.exportGeneral ?? true;
  $("exPreview").textContent = brief();
}

function exportMarkdown() {
  openSheet("exportSheet");
  renderExport();
}

function exportBackup() {
  const data = { app: "birdseye", version: 3, exportedAt: new Date().toISOString(), document: meta, workspace: { ...ws, general: notes.value }, annotations: annot.list };
  download(`${baseName()} - Birds-Eye backup ${stamp()}.json`, JSON.stringify(data, null, 2), "application/json");
}

async function restoreBackup(file: File) {
  try {
    const data = JSON.parse(await file.text());
    if (data?.app !== "birdseye" || !data.workspace) throw new Error("not a backup");
    const w = data.workspace as Workspace;
    if (notes.value.trim() && !confirm("Replace your current notes with the ones in this backup?")) return;
    const same = meta && data.document?.id === meta.id;
    ws.linkedOpen = !!w.linkedOpen;
    if (w.panel) { ws.panel = w.panel; notes.geom = { ...w.panel }; notes.layout(); }
    if (data.document?.id) saveDocNote(data.document.id, w.general ?? "", 0);
    if (same || !data.document) { notes.setText(w.general ?? ""); saveDocNote(noteKey(), w.general ?? "", 0); }
    save(0);
    if (Array.isArray(data.annotations) && data.document?.id) {
      saveAnnotations(data.document.id, data.annotations, 0);
      if (same) { annot.setDocument(doc!, data.annotations); notes.setLinked(data.annotations); }
    }
    toast(same || !data.document ? "Notes restored." : `Notes restored. Open “${data.document.name}” to see its pages.`, 4500);
  } catch {
    toast("That file isn’t a Bird’s-Eye backup.");
  }
}

// ---------- debug ----------

function renderDebug() {
  const d = $("debug");
  if (!ws.debug) { d.hidden = true; return; }
  d.hidden = false;
  const s = board.stats;
  d.textContent =
    `scale   ${board.cam.s.toFixed(3)}  dpr ${window.devicePixelRatio}\n` +
    `thumbs  ${s.thumbs}/${s.pages}\n` +
    `tiles   ${s.tiles}  ${s.tileMP} MP\n` +
    `render  ${s.lastRenderMs} ms  (#${s.renders})\n` +
    `screen  ${window.innerWidth}×${window.innerHeight}`;
}

// ---------- boot ----------

async function boot() {
  ws = await loadWorkspace();
  // Older versions kept one set of general notes and one view for everything: move them to the open document.
  if (ws.docId && (ws.general || ws.view)) {
    if (ws.general && (await loadDocNote(ws.docId)) == null) saveDocNote(ws.docId, ws.general, 0);
    if (ws.view && !ws.views[ws.docId]) ws.views = { ...ws.views, [ws.docId]: ws.view };
    ws.general = "";
    ws.view = null;
    save(0);
  }

  notes = new NotesPanel(ws.panel, "", ws.linkedOpen, {
    onGeometry(g) { ws.panel = g; save(); updateChrome(); },
    onText(text) { $("saveText").textContent = "Saving…"; saveDocNote(noteKey(), text); },
    onLinkedOpen(open) { ws.linkedOpen = open; save(); },
    onExport: exportMarkdown,
    onGo(id) {
      const c = annot.center(id);
      if (!c) return;
      board.flyTo(c.x, c.y, Math.max(board.cam.s, board.pageScale(c.page) ?? board.cam.s));
      setTimeout(() => annot.flash(id), 560);
    },
    onNoteText(id, text) { annot.update(id, { note: text }); },
  });

  onSaveState((ok) => {
    $("saveState").classList.toggle("err", !ok);
    $("saveText").textContent = ok ? "Saved on this device" : "Not saved — use Export";
    $("saveState").querySelector("use")?.setAttribute("href", ok ? "#i-check" : "#i-warn");
  });

  let saveViewTimer = 0;
  board = new Board($("viewport"), $("world"), {
    region,
    onCamera: (_c: Camera) => { updateChrome(); if (annot?.popoverOpen) annot.placePopover(); },
    onSettle: () => {
      if (board.zoomedIn) annot.preload(board.visiblePages());
      clearTimeout(saveViewTimer);
      saveViewTimer = window.setTimeout(() => { if (meta) { ws.views = { ...ws.views, [meta.id]: board.viewState }; save(); } }, 400);
      renderDebug();
    },
    onFirstGesture: () => $("hint").classList.add("gone"),
  });

  annot = new Annotator(board, {
    onChange(list) { if (meta) saveAnnotations(meta.id, list); notes.setLinked(list); },
    onNoteRequested(id) { notes.focusCard(id, true); },
    onPinTapped(id) { notes.focusCard(id); },
    onRemoved(a) { toast("Highlight removed.", 6000, { label: "Undo", run: () => annot.restore(a) }); },
  });
  board.selection = {
    start: (p, pt) => annot.selectStart(p, pt),
    move: (pt) => annot.selectMove(pt),
    end: () => annot.selectEnd(),
    cancel: () => annot.selectCancel(),
    tap: (t, p, pt, sel, z) => annot.tap(t, p, pt, sel, z),
  };
  search = new Search(board, {
    pageText: (i) => annot.pageText(i),
    pageCount: () => board.layout?.pages.length ?? 0,
    annotations: () => annot.list,
    general: () => notes.value,
    showGeneral: (a, b) => notes.showGeneral(a, b),
    showNote(id) {
      notes.focusCard(id);
      const c = annot.center(id);
      if (c) { board.flyTo(c.x, c.y, Math.max(board.cam.s, board.pageScale(c.page) ?? board.cam.s)); setTimeout(() => annot.flash(id), 560); }
    },
    highlightNotes: (ids) => notes.setMatches(ids),
    onOpenChange: () => { updateChrome(); if (meta && !board.zoomedIn) board.fit(); },
  });
  $("searchBtn").onclick = () => search.toggle();
  $("modePan").onclick = () => setMode("pan");
  $("modeSelect").onclick = () => setMode("select");

  // Toolbar
  $("zoomIn").onclick = () => board.zoomBy(1.4);
  $("zoomOut").onclick = () => board.zoomBy(1 / 1.4);
  $("fitAll").onclick = () => board.fit();
  $("notesToggle").onclick = () => notes.setMinimized(!notes.geom.min);
  $("docBar").onclick = () => void showLibrary();
  $("libOpen").onclick = () => { closeSheets(); $<HTMLInputElement>("filePick").click(); };
  $("backdrop").onclick = closeSheets;
  document.querySelectorAll<HTMLElement>("[data-close]").forEach((b) => (b.onclick = closeSheets));
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("backdrop").hidden) { e.stopPropagation(); closeSheets(); } }, true);
  document.querySelectorAll<HTMLButtonElement>("#exportSheet [data-group]").forEach((b) => (b.onclick = () => { ws.exportGroup = b.dataset.group as "page" | "tag"; save(); renderExport(); }));
  $("exHl").onchange = () => { ws.exportHighlights = $<HTMLInputElement>("exHl").checked; save(); renderExport(); };
  $("exGen").onchange = () => { ws.exportGeneral = $<HTMLInputElement>("exGen").checked; save(); renderExport(); };
  $("exDownload").onclick = () => download(`${baseName()} - Notes.md`, brief(), "text/markdown;charset=utf-8");
  $("exCopy").onclick = async () => {
    try { await navigator.clipboard.writeText(brief()); toast("Copied. Paste it into any document."); }
    catch { toast("Couldn’t copy here. Use Download instead."); }
  };
  $("emptyOpen").onclick = () => $<HTMLInputElement>("filePick").click();

  const menu = $("menu"), more = $("moreBtn");
  const setMenu = (open: boolean) => { menu.hidden = !open; more.setAttribute("aria-expanded", String(open)); };
  more.onclick = (e) => { e.stopPropagation(); setMenu(menu.hidden); };
  document.addEventListener("pointerdown", (e) => { if (!menu.hidden && !menu.contains(e.target as Node) && e.target !== more && !more.contains(e.target as Node)) setMenu(false); });
  menu.onclick = (e) => {
    const act = (e.target as HTMLElement).closest("button")?.dataset.act;
    setMenu(false);
    if (act === "open") $<HTMLInputElement>("filePick").click();
    else if (act === "library") void showLibrary();
    else if (act === "exportMd") exportMarkdown();
    else if (act === "rename" && meta) {
      const t = prompt("Document name", title)?.trim();
      if (t) { title = t; meta.title = t; void updateDocMeta(meta); setDocLabel(); }
    }
    else if (act === "backup") exportBackup();
    else if (act === "restore") $<HTMLInputElement>("backupPick").click();
    else if (act === "debug") { ws.debug = !ws.debug; save(); renderDebug(); syncDebugLabel(); }
  };
  const syncDebugLabel = () => { menu.querySelector('[data-act="debug"]')!.textContent = ws.debug ? "Hide debug overlay" : "Show debug overlay"; };
  syncDebugLabel();

  $<HTMLInputElement>("filePick").onchange = (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = "";
    if (f) void importFile(f);
  };
  $<HTMLInputElement>("backupPick").onchange = (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = "";
    if (f) void restoreBackup(f);
  };

  // Drag and drop (Mac, and iPad with Split View / Slide Over).
  let dragDepth = 0;
  const hasFile = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  window.addEventListener("dragenter", (e) => { if (hasFile(e)) { dragDepth++; $("drop").hidden = false; } });
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("drop").hidden = true; } });
  window.addEventListener("dragover", (e) => { if (hasFile(e)) e.preventDefault(); });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    $("drop").hidden = true;
    const f = [...(e.dataTransfer?.files ?? [])].find((x) => /pdf$/i.test(x.type) || /\.pdf$/i.test(x.name));
    if (f) void importFile(f);
    else if (e.dataTransfer?.files.length) toast("Drop a PDF file.");
  });

  window.addEventListener("resize", () => { updateChrome(); });
  window.addEventListener("pagehide", flushAll);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushAll(); });

  setDocLabel();
  updateChrome();
  renderDebug();
  setInterval(renderDebug, 1000);

  if (ws.docId) {
    const saved = await getDoc(ws.docId);
    if (saved) {
      try { await showDocument(saved.meta, saved.file, true); }
      catch { ws.docId = null; setDocLabel(); }
    } else { ws.docId = null; setDocLabel(); }
  }
  if (!meta) {
    notes.setText((await loadDocNote("_none")) ?? "");
    if ((await listDocs()).length) void showLibrary();
  }

  void pruneOldThumbs();

  // Offline support: the app keeps working without a connection once it has been opened.
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

void boot();
