// Runs the reader's end-to-end checks in WebKit: starts Vite, loads tests/webkit/reader-check.html
// in an offscreen WKWebView (scripts/webkit-run.swift), and checks the results.
import { createServer } from "vite";
import { execFile, execSync } from "node:child_process";
import { promisify } from "node:util";

execSync("node scripts/copy-pdfjs.mjs", { stdio: "ignore" });
const server = await createServer({ server: { host: "127.0.0.1", port: 1422, strictPort: true }, logLevel: "error", clearScreen: false });
await server.listen();
let out;
try {
  // Asynchronously: the Vite server runs in this process and must keep answering.
  ({ stdout: out } = await promisify(execFile)("swift", ["scripts/webkit-run.swift", "http://127.0.0.1:1422/tests/webkit/reader-check.html", "90"], { encoding: "utf8", timeout: 180_000 }));
} finally {
  await server.close();
}
const r = JSON.parse(out.trim().split("\n").pop());
console.log(JSON.stringify(r, null, 2));
const checks = [
  ["it ran", r.ok === true],
  ["JPEG 2000 scan renders completely with wasm (480 × 300 image)", r.jpxWithWasm === 480 * 300],
  ["JPEG 2000 scan renders nothing without wasm", r.jpxWithoutWasm === 0],
  ["JBIG2 scan renders with wasm", r.jbig2WithWasm > 4000],
  ["JBIG2 scan renders nothing without wasm", r.jbig2WithoutWasm === 0],
  ["first page of a 100-page PDF in under 500 ms", r.pdfFirstPageMs >= 0 && r.pdfFirstPageMs < 500],
  ["PDF zooms", r.pdfZoomed === true],
  ["PDF finds", r.pdfFind?.count >= 1],
  ["PDF shows a captured region in place", r.pdfPlace === true && r.pdfPlaceMarked === true],
  ["EPUB opens", r.epubPainted === true && r.epubDocs >= 1],
  ["EPUB scripts never run", r.epubScriptRan === false],
  ["EPUB finds", r.epubFind?.count >= 1],
  ["image opens and zooms", r.imagePainted === true && r.imageZoomed === true],
  ["recognised words in an image can be found", r.ocrImageLines === 3 && r.ocrImageFind?.count === 1],
  ["recognised words in an image can be selected (and so captured)", r.ocrImageSelection === "Gravity and grace are two forces."],
  ["recognised words on a scanned page can be found", r.ocrScanLines === 3 && r.ocrScanFind?.count >= 1],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
