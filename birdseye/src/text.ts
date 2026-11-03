// Page text index: where every character sits on the page, in page-local world units.
// Built from PDF.js text content; used for selection, highlights and (next) search.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { PAGE_W, type Rect } from "./geometry";
import type { PDFPageProxy } from "./pdf";

export interface TextRun {
  start: number; // offset of the run's first character in PageText.text
  len: number;
  x: number; y: number; w: number; h: number; // box in page-local world units
  /** Cumulative position of each character boundary as a fraction of w (len + 1 entries). */
  cx: number[];
}

export interface PageText { text: string; runs: TextRun[] }

let measureCtx: CanvasRenderingContext2D | null = null;
function measure(str: string, family: string): number[] {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  const out = [0];
  if (!measureCtx) {
    for (let i = 1; i <= str.length; i++) out.push(i / str.length);
    return out;
  }
  measureCtx.font = `100px ${family || "sans-serif"}`;
  let acc = 0;
  const widths: number[] = [];
  for (const ch of str) {
    const w = Math.max(1, measureCtx.measureText(ch).width);
    // Surrogate pairs take two code units; keep one boundary per code unit.
    for (let k = 0; k < ch.length; k++) widths.push(k === 0 ? w : 0);
  }
  const total = widths.reduce((a, b) => a + b, 0) || 1;
  for (const w of widths) { acc += w; out.push(acc / total); }
  return out;
}

export async function buildPageText(page: PDFPageProxy): Promise<PageText> {
  const base = page.getViewport({ scale: 1 });
  const f = PAGE_W / base.width;
  const vp = page.getViewport({ scale: f });
  const content = await page.getTextContent();
  const styles = content.styles as Record<string, { fontFamily?: string; ascent?: number; descent?: number; vertical?: boolean }>;
  let text = "";
  const runs: TextRun[] = [];
  for (const it of content.items as Array<{ str?: string; transform?: number[]; width?: number; fontName?: string; hasEOL?: boolean }>) {
    if (typeof it.str !== "string" || !it.transform) continue;
    const str = it.str;
    if (str.length) {
      const t = pdfjs.Util.transform(vp.transform, it.transform) as number[];
      const fontH = Math.hypot(t[2], t[3]);
      const angle = Math.atan2(t[1], t[0]);
      const st = styles[it.fontName ?? ""] ?? {};
      if (Math.abs(angle) < 0.05 && fontH > 0 && !st.vertical) {
        const ascent = st.ascent && st.ascent > 0.3 ? st.ascent : 0.85;
        const descent = st.descent && st.descent < 0 ? -st.descent : 0.2;
        const w = (it.width ?? 0) * f;
        if (w > 0) {
          runs.push({ start: text.length, len: str.length, x: t[4], y: t[5] - fontH * ascent, w, h: fontH * (ascent + descent), cx: measure(str, st.fontFamily ?? "") });
        }
      }
      text += str;
    }
    if (it.hasEOL) text += "\n";
  }
  return { text, runs };
}

/** Caret offset nearest to a point (page-local world units). */
export function hitTest(pt: PageText, x: number, y: number): number | null {
  if (!pt.runs.length) return null;
  let best: TextRun | null = null;
  let bestD = Infinity;
  for (const r of pt.runs) {
    const dy = y < r.y ? r.y - y : y > r.y + r.h ? y - (r.y + r.h) : 0;
    const dx = x < r.x ? r.x - x : x > r.x + r.w ? x - (r.x + r.w) : 0;
    const d = dy * 4 + dx; // prefer the same line
    if (d < bestD) { bestD = d; best = r; }
  }
  if (!best) return null;
  const fx = (x - best.x) / best.w;
  if (fx <= 0) return best.start;
  if (fx >= 1) return best.start + best.len;
  for (let i = 0; i < best.len; i++) {
    const mid = (best.cx[i] + best.cx[i + 1]) / 2;
    if (fx < mid) return best.start + i;
  }
  return best.start + best.len;
}

/** Boxes covering the characters [a, b), merged per line. */
export function rangeRects(pt: PageText, a: number, b: number): Rect[] {
  if (b < a) [a, b] = [b, a];
  const out: Rect[] = [];
  for (const r of pt.runs) {
    const s = Math.max(a, r.start), e = Math.min(b, r.start + r.len);
    if (e <= s) continue;
    const x0 = r.x + r.w * r.cx[s - r.start];
    const x1 = r.x + r.w * r.cx[e - r.start];
    const rect = { x: x0, y: r.y, w: Math.max(0.5, x1 - x0), h: r.h };
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - rect.y) < rect.h * 0.35 && rect.x - (last.x + last.w) < rect.h * 1.2 && rect.x >= last.x - 0.5) {
      const y0 = Math.min(last.y, rect.y), y1 = Math.max(last.y + last.h, rect.y + rect.h);
      last.w = rect.x + rect.w - last.x;
      last.y = y0;
      last.h = y1 - y0;
    } else out.push(rect);
  }
  return out;
}

const WORD = /[\p{L}\p{N}'’\-_]/u;
/** The word around a caret offset, or null if the caret is not in a word. */
export function wordAt(pt: PageText, at: number): [number, number] | null {
  const t = pt.text;
  let a = at, b = at;
  if (!WORD.test(t[a] ?? "") && WORD.test(t[a - 1] ?? "")) a = b = at - 1;
  if (!WORD.test(t[a] ?? "")) return null;
  while (a > 0 && WORD.test(t[a - 1])) a--;
  while (b < t.length && WORD.test(t[b])) b++;
  return [a, b];
}

export function quoteOf(pt: PageText, a: number, b: number) {
  if (b < a) [a, b] = [b, a];
  const clean = (s: string) => s.replace(/\s+/g, " ");
  return {
    quote: clean(pt.text.slice(a, b)).trim(),
    prefix: clean(pt.text.slice(Math.max(0, a - 40), a)),
    suffix: clean(pt.text.slice(b, b + 40)),
  };
}
