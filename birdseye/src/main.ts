import "./styles.css";
import { Board } from "./board";
import { bestLayout, freeRegion, layoutPages, type Camera, type Rect } from "./geometry";
import { NotesPanel } from "./notes";
import { closePdf, openPdf, pageSizes, type PDFDocumentProxy } from "./pdf";
import {
  flushWorkspace, getDoc, loadWorkspace, onSaveState, putDoc, requestPersistence, saveWorkspace, sha256,
  type DocMeta, type Workspace,
} from "./store";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const TOP = 76; // below the top bar
const BOTTOM = 16;

let ws: Workspace;
let notes: NotesPanel;
let board: Board;
let doc: PDFDocumentProxy | null = null;
let meta: DocMeta | null = null;

function region(): Rect {
  const view = { w: window.innerWidth, h: window.innerHeight };
  return freeRegion(view, notes?.rect() ?? null, TOP, BOTTOM);
}

function save(delay?: number) { saveWorkspace({ ...ws, general: notes.value }, delay); }

// ---------- feedback ----------

let toastTimer = 0;
function toast(msg: string, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
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
}

function setDocLabel() {
  $("docTitle").textContent = meta ? meta.name.replace(/\.pdf$/i, "") : "Bird’s-Eye";
  $("docSub").textContent = meta ? `${meta.pageSizes.length} pages · Bird’s-eye view` : "Open a PDF to begin";
  $("empty").hidden = !!meta;
  document.title = meta ? `${meta.name.replace(/\.pdf$/i, "")} — Bird’s-Eye` : "Bird’s-Eye";
}

// ---------- documents ----------

async function showDocument(m: DocMeta, file: Blob, restore: boolean) {
  const buf = await file.arrayBuffer();
  const old = doc;
  doc = await openPdf(buf);
  meta = m;
  const r = region();
  const cols = ws.cols[m.id];
  const layout = cols ? layoutPages(m.pageSizes, cols) : bestLayout(m.pageSizes, { w: r.w, h: r.h });
  ws.cols = { ...ws.cols, [m.id]: layout.cols };
  await board.setDocument(doc, m.id, layout);
  void closePdf(old);
  setDocLabel();
  if (restore && ws.view) board.restoreView(ws.view);
  else board.fit(false);
  updateChrome();
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
      const probe = await openPdf(buf);
      m = { id, name: file.name, bytes: file.size, pageSizes: await pageSizes(probe), addedAt: Date.now() };
      await closePdf(probe);
      await putDoc(m, new Blob([buf], { type: "application/pdf" }));
    }
    ws.docId = id;
    ws.view = null;
    await showDocument(m, new Blob([buf]), false);
    save(0);
    const persisted = await requestPersistence();
    toast(existing ? "Opened. Your notes and view are as you left them." : persisted ? "Saved on this device." : "Saved on this device. Install to the Home Screen so Safari keeps it.");
  } catch (e) {
    console.error(e);
    toast("Couldn’t open that PDF. It may be damaged or password-protected.", 5000);
  }
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
const baseName = () => (meta?.name ?? "Notes").replace(/\.pdf$/i, "");

function exportMarkdown() {
  const md = `# ${baseName()} — Notes\n\n_${stamp()}${meta ? ` · ${meta.pageSizes.length} pages` : ""}_\n\n${notes.value.trim()}\n`;
  download(`${baseName()} — Notes.md`, md, "text/markdown;charset=utf-8");
}

function exportBackup() {
  const data = { app: "birdseye", version: 1, exportedAt: new Date().toISOString(), document: meta, workspace: { ...ws, general: notes.value } };
  download(`${baseName()} — Bird’s-Eye backup ${stamp()}.json`, JSON.stringify(data, null, 2), "application/json");
}

async function restoreBackup(file: File) {
  try {
    const data = JSON.parse(await file.text());
    if (data?.app !== "birdseye" || !data.workspace) throw new Error("not a backup");
    const w = data.workspace as Workspace;
    if (notes.value.trim() && !confirm("Replace your current notes with the ones in this backup?")) return;
    ws.general = w.general ?? "";
    ws.linkedOpen = !!w.linkedOpen;
    if (w.panel) { ws.panel = w.panel; notes.geom = { ...w.panel }; notes.layout(); }
    notes.setText(ws.general);
    save(0);
    const same = meta && data.document?.id === meta.id;
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

  notes = new NotesPanel(ws.panel, ws.general, ws.linkedOpen, {
    onGeometry(g) { ws.panel = g; save(); updateChrome(); },
    onText() { $("saveText").textContent = "Saving…"; save(); },
    onLinkedOpen(open) { ws.linkedOpen = open; save(); },
    onExport: exportMarkdown,
  });

  onSaveState((ok) => {
    $("saveState").classList.toggle("err", !ok);
    $("saveText").textContent = ok ? "Saved on this device" : "Not saved — use Export";
    $("saveState").querySelector("use")?.setAttribute("href", ok ? "#i-check" : "#i-warn");
  });

  let saveViewTimer = 0;
  board = new Board($("viewport"), $("world"), {
    region,
    onCamera: (_c: Camera) => updateChrome(),
    onSettle: () => {
      clearTimeout(saveViewTimer);
      saveViewTimer = window.setTimeout(() => { if (meta) { ws.view = board.viewState; save(); } }, 400);
      renderDebug();
    },
    onFirstGesture: () => $("hint").classList.add("gone"),
  });

  // Toolbar
  $("zoomIn").onclick = () => board.zoomBy(1.4);
  $("zoomOut").onclick = () => board.zoomBy(1 / 1.4);
  $("fitAll").onclick = () => board.fit();
  $("notesToggle").onclick = () => notes.setMinimized(!notes.geom.min);
  $("docBar").onclick = () => $<HTMLInputElement>("filePick").click();
  $("emptyOpen").onclick = () => $<HTMLInputElement>("filePick").click();

  const menu = $("menu"), more = $("moreBtn");
  const setMenu = (open: boolean) => { menu.hidden = !open; more.setAttribute("aria-expanded", String(open)); };
  more.onclick = (e) => { e.stopPropagation(); setMenu(menu.hidden); };
  document.addEventListener("pointerdown", (e) => { if (!menu.hidden && !menu.contains(e.target as Node) && e.target !== more && !more.contains(e.target as Node)) setMenu(false); });
  menu.onclick = (e) => {
    const act = (e.target as HTMLElement).closest("button")?.dataset.act;
    setMenu(false);
    if (act === "open") $<HTMLInputElement>("filePick").click();
    else if (act === "exportMd") exportMarkdown();
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
  window.addEventListener("pagehide", () => { ws.general = notes.value; save(0); void flushWorkspace(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) { ws.general = notes.value; save(0); void flushWorkspace(); } });

  setDocLabel();
  updateChrome();
  renderDebug();
  setInterval(renderDebug, 1000);

  if (ws.docId) {
    const saved = await getDoc(ws.docId);
    if (saved) await showDocument(saved.meta, saved.file, true);
    else { ws.docId = null; setDocLabel(); }
  }
}

void boot();
