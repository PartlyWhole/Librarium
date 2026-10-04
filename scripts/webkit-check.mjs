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
  ["PDF: the selectable text lies exactly over the drawn page", r.pdfTextOverPage === true],
  ["PDF: the selectable text is placed word by word", r.pdfTextInWords === true],
  ["PDF shows a captured region in place", r.pdfPlace === true && r.pdfPlaceMarked === true],
  ["a region dragged on a page far down a PDF is captured from that page", r.pdfRegionPage >= 4 && r.pdfRegionLayerGone === true],
  ["a captured PDF region is rendered sharp and not blank", r.pdfRegionSharp === true && r.pdfRegionInk > 50],
  ["Escape cancels picking a region", r.pdfRegionCancelled === true],
  ["a saved capture is highlighted in a PDF, and a click on it is recognised", r.pdfSavedMark === true && r.pdfSavedMarkClicked === "cap#0"],
  ["a PDF selection has boxes on its page, and they are highlighted", r.pdfSelectionBoxes >= 1 && r.pdfSelectionEnd === true && r.pdfMarks >= 1 && r.pdfMarksCleared === true],
  ["EPUB opens (Readium)", r.epubPainted === true && r.epubDocs >= 1],
  ["EPUB scripts, event handlers and javascript: links never run", r.epubScriptRan === false && r.epubScriptRanLater === false],
  ["every EPUB page carries the scripts-only-from-the-reader policy", r.epubPolicy === true],
  ["EPUB lists its contents", r.epubContents === "Chapter One|Chapter Two"],
  ["EPUB reads without chrome (Apple Books style)", r.epubImmersive === true],
  ["EPUB: the next-page arrow turns into the next chapter, and the contents mark where you are", /^Chapter One/.test(r.epubStartsAt) && /^Chapter Two/.test(r.epubAfterNext) && r.epubContentsFollows === 1],
  ["EPUB: ← turns back", /^Chapter One/.test(r.epubAfterLeft)],
  ["EPUB finds across chapters, goes to the match and highlights it", r.epubFind?.count === 1 && /^Chapter Two/.test(r.epubFindAt) && r.epubFindDrawn === 1],
  ["EPUB: a selection gives the same CFI as before (captures keep their places)", r.epubSelection === "rarest epubcfi(/6/2!/4/4,/1:17,/1:23)"],
  ["EPUB: a saved capture is highlighted", r.epubMarkDrawn === 1],
  ["EPUB: showing a capture goes to its chapter", r.epubShowPlace === true && /^Chapter One/.test(r.epubShownAt)],
  ["EPUB: the dark theme applies and the setting is kept", r.epubDark === "rgb(28, 28, 30)" && r.epubSettingsSaved === "night"],
  ["EPUB says how many pages are left in the chapter", /page/i.test(r.epubPagesLeft)],
  ["EPUB: the place in the book is remembered", /^Chapter Two/.test(r.epubReopenedAt)],
  ["EPUB: a fixed-layout book opens on its first page", /^Page 1 of 2/.test(r.epubFixedAt) && r.epubFixedFrames >= 1],
  ["EPUB: images and stylesheets load from the book; its script files never run", r.epubImage === true && r.epubStylesheet === true && r.epubBookFileRan === false],
  ["image opens and zooms", r.imagePainted === true && r.imageZoomed === true],
  ["a region of an image is captured", r.imageRegion === true],
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
