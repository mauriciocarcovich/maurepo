// Local-first storage in IndexedDB. Everything stays on this device.
import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export interface DocMeta {
  id: string; // SHA-256 of the file bytes, so re-importing the same PDF finds its data again
  name: string;
  bytes: number;
  pageSizes: { w: number; h: number }[];
  addedAt: number;
}

/** Notes panel geometry, stored as fractions of the screen so it survives rotation and browser chrome. */
export interface PanelGeom { fx: number; fy: number; fw: number; fh: number; min: boolean }

export interface Workspace {
  docId: string | null;
  /** Camera as the world point at the screen centre plus a scale, so it restores on any screen size. */
  view: { cx: number; cy: number; s: number } | null;
  panel: PanelGeom;
  general: string;
  linkedOpen: boolean;
  debug: boolean;
  /** Column count chosen for each document, so its spatial layout never shifts. */
  cols: Record<string, number>;
}

interface Schema extends DBSchema {
  docs: { key: string; value: DocMeta };
  files: { key: string; value: Blob };
  thumbs: { key: string; value: Blob };
  kv: { key: string; value: unknown };
}

export const DEFAULT_PANEL: PanelGeom = { fx: 0.02, fy: 0.18, fw: 0.3, fh: 0.63, min: false };

export const DEFAULT_WORKSPACE: Workspace = {
  docId: null,
  view: null,
  panel: DEFAULT_PANEL,
  general: "",
  linkedOpen: false,
  debug: false,
  cols: {},
};

let dbp: Promise<IDBPDatabase<Schema>> | null = null;
function db() {
  dbp ??= openDB<Schema>("birdseye", 1, {
    upgrade(d) {
      d.createObjectStore("docs");
      d.createObjectStore("files");
      d.createObjectStore("thumbs");
      d.createObjectStore("kv");
    },
  });
  return dbp;
}

export async function loadWorkspace(): Promise<Workspace> {
  try {
    const w = (await (await db()).get("kv", "workspace")) as Partial<Workspace> | undefined;
    return { ...DEFAULT_WORKSPACE, ...w, panel: { ...DEFAULT_PANEL, ...(w?.panel ?? {}) } };
  } catch {
    return { ...DEFAULT_WORKSPACE };
  }
}

let pending: Workspace | null = null;
let timer: number | undefined;
let lastError: unknown = null;
const listeners = new Set<(ok: boolean) => void>();

export function onSaveState(fn: (ok: boolean) => void) { listeners.add(fn); }

/** Debounced save; the latest workspace always wins. */
export function saveWorkspace(w: Workspace, delay = 300) {
  pending = w;
  clearTimeout(timer);
  timer = window.setTimeout(flushWorkspace, delay);
}

export async function flushWorkspace() {
  clearTimeout(timer);
  if (!pending) return;
  const w = pending;
  pending = null;
  try {
    await (await db()).put("kv", structuredClone(w), "workspace");
    lastError = null;
    listeners.forEach((f) => f(true));
  } catch (e) {
    lastError = e;
    listeners.forEach((f) => f(false));
  }
}

export const saveError = () => lastError;

export async function putDoc(meta: DocMeta, file: Blob) {
  const d = await db();
  const tx = d.transaction(["docs", "files"], "readwrite");
  await Promise.all([tx.objectStore("docs").put(meta, meta.id), tx.objectStore("files").put(file, meta.id), tx.done]);
}

export async function getDoc(id: string) {
  const d = await db();
  const [meta, file] = await Promise.all([d.get("docs", id), d.get("files", id)]);
  return meta && file ? { meta, file } : null;
}

export async function getThumb(docId: string, page: number) {
  try { return await (await db()).get("thumbs", `${docId}:${page}`); } catch { return undefined; }
}

export async function putThumb(docId: string, page: number, blob: Blob) {
  try { await (await db()).put("thumbs", blob, `${docId}:${page}`); } catch { /* cache only */ }
}

/** Ask the browser not to evict our data (Safari otherwise may after a period of no use). */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function sha256(buf: ArrayBuffer): Promise<string> {
  if (crypto?.subtle) {
    const h = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Insecure context fallback (e.g. plain http on a LAN while testing): a fast non-crypto hash.
  const a = new Uint8Array(buf);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < a.length; i++) {
    h1 = Math.imul(h1 ^ a[i], 16777619);
    h2 = Math.imul(h2 + a[i], 2246822519);
  }
  return `fnv-${(h1 >>> 0).toString(16)}-${(h2 >>> 0).toString(16)}-${a.length}`;
}
