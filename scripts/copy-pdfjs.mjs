// Copies PDF.js's worker, wasm decoders (JBIG2, JPEG 2000, colour), cmaps, standard fonts and
// ICC profiles into public/pdfjs/, so the app serves them itself (no network).
import { cpSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const from = path.resolve("node_modules/pdfjs-dist");
const to = path.resolve("public/pdfjs");
mkdirSync(to, { recursive: true });
for (const dir of ["wasm", "cmaps", "standard_fonts", "iccs"]) {
  if (existsSync(path.join(from, dir))) cpSync(path.join(from, dir), path.join(to, dir), { recursive: true });
}
cpSync(path.join(from, "legacy/build/pdf.worker.min.mjs"), path.join(to, "pdf.worker.min.mjs"));
console.log("PDF.js assets copied to public/pdfjs");
