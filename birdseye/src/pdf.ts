// Thin wrapper over PDF.js. The legacy build is used for the widest Safari support on iPad.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { PAGE_W, type Rect, type Size } from "./geometry";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type { PDFDocumentProxy, PDFPageProxy, RenderTask };

const tasks = new WeakMap<PDFDocumentProxy, { destroy(): Promise<void> }>();

export async function openPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  // PDF.js transfers the buffer to its worker, so hand it a copy and keep ours for storage.
  const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) });
  const doc = await task.promise;
  tasks.set(doc, task);
  return doc;
}

export async function closePdf(doc: PDFDocumentProxy | null) {
  if (doc) await tasks.get(doc)?.destroy();
}

export async function pageSizes(doc: PDFDocumentProxy): Promise<Size[]> {
  const out: Size[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const v = p.getViewport({ scale: 1 });
    out.push({ w: v.width, h: v.height });
  }
  return out;
}

export interface Rendered { task: RenderTask; done: Promise<void> }

/**
 * Render the part `region` (world units, relative to the page's top-left) of a page into `canvas`
 * at `k` device pixels per world unit.
 */
export function renderRegion(page: PDFPageProxy, canvas: HTMLCanvasElement, k: number, region: Rect): Rendered {
  const base = page.getViewport({ scale: 1 });
  const f = PAGE_W / base.width; // world units per PDF point
  const viewport = page.getViewport({ scale: k * f });
  canvas.width = Math.max(1, Math.ceil(region.w * k));
  canvas.height = Math.max(1, Math.ceil(region.h * k));
  const task = page.render({
    canvas,
    viewport,
    transform: [1, 0, 0, 1, -region.x * k, -region.y * k],
    background: "#ffffff",
  });
  return { task, done: task.promise };
}

/** A small JPEG of the whole page for the bird's-eye view. */
export async function renderThumb(page: PDFPageProxy, widthPx: number): Promise<Blob> {
  const base = page.getViewport({ scale: 1 });
  const k = widthPx / PAGE_W;
  const canvas = document.createElement("canvas");
  const h = PAGE_W * (base.height / base.width);
  try {
    await renderRegion(page, canvas, k, { x: 0, y: 0, w: PAGE_W, h }).done;
    return await new Promise<Blob>((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/jpeg", 0.86),
    );
  } finally {
    releaseCanvas(canvas);
  }
}

/** iPad Safari only frees canvas memory when the backing store shrinks. */
export function releaseCanvas(c: HTMLCanvasElement) {
  c.width = 0;
  c.height = 0;
}
