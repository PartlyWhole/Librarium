// Copies the assets bundled libraries load at run time into public/, so the app serves them itself
// (no network):
// - PDF.js's worker, wasm decoders (JBIG2, JPEG 2000, colour), cmaps, standard fonts and ICC
//   profiles, into public/pdfjs/;
// - Excalidraw's fonts (boards), into public/excalidraw/fonts/.
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

const fonts = path.resolve("node_modules/@excalidraw/excalidraw/dist/prod/fonts");
if (existsSync(fonts)) {
  cpSync(fonts, path.resolve("public/excalidraw/fonts"), { recursive: true });
  console.log("Excalidraw fonts copied to public/excalidraw/fonts");
}
