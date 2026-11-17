// Copies PDF.js's runtime resources into public/pdfjs so they ship with the app:
// wasm decoders (JPEG 2000, JBIG2 — common in scanned PDFs), standard fonts, CMaps, ICC profiles.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pdfjs-dist");
const dest = join(root, "public", "pdfjs");
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const dir of ["wasm", "standard_fonts", "cmaps", "iccs"]) cpSync(join(src, dir), join(dest, dir), { recursive: true });
console.log("PDF.js resources copied to public/pdfjs");
