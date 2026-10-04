/**
 * End-to-end reader checks, run in WebKit (the app's engine) by scripts/webkit-check.mjs.
 * Results go to `window.__result`.
 */
import "../../src/kit/polyfills";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { pdfEngine, DOCUMENT_OPTIONS } from "../../src/reader/pdf";
import { epubEngine } from "../../src/reader/epub";
import { imageEngine } from "../../src/reader/image";
import type { ReaderEngine, ReaderSource } from "../../src/reader/host";

const results: Record<string, unknown> = {};
const fixture = async (n: string) => (await fetch(`/tests/fixtures/library/${n}`)).arrayBuffer();
const stage = document.getElementById("stage")!;

async function inked(name: string, wasm: boolean): Promise<number> {
  const task = pdfjs.getDocument({ data: new Uint8Array(await fixture(name)), ...DOCUMENT_OPTIONS, wasmUrl: wasm ? DOCUMENT_OPTIONS.wasmUrl : "/pdfjs/missing/", verbosity: 0 });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const c = document.createElement("canvas");
  c.width = Math.ceil(vp.width);
  c.height = Math.ceil(vp.height);
  const ctx = c.getContext("2d")!;
  await page.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i]! < 250 || px[i + 1]! < 250 || px[i + 2]! < 250) n++;
  await task.destroy();
  return n;
}

async function open(engine: ReaderEngine, name: string, format: string, stored?: string) {
  stage.replaceChildren();
  let firstPaint = -1;
  let painted!: () => void;
  const paint = new Promise<void>((r) => (painted = r));
  const text = async () => (stored ? JSON.parse(new TextDecoder().decode(await fixture(stored))) : null);
  const src: ReaderSource = { id: name, format, title: name, bytes: () => fixture(name), text };
  const view = await engine.open(stage, src, { moved() {}, firstPaint: (ms) => ((firstPaint = ms), painted()) });
  await Promise.race([paint, new Promise((r) => setTimeout(r, 10_000))]);
  return { view, firstPaint };
}

/** Drags from one point to another (window coordinates), as a mouse would. */
async function drag(from: { x: number; y: number }, to: { x: number; y: number }) {
  await new Promise((r) => setTimeout(r, 50));
  const layer = document.querySelector(".region-layer")!;
  const at = (type: string, p: { x: number; y: number }, target: EventTarget) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: p.x, clientY: p.y, button: 0 }));
  at("mousedown", from, layer);
  at("mousemove", { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, window);
  at("mouseup", to, window);
}

/** A PNG data URL's size and how many of its pixels are not white. */
async function pngInfo(url: string): Promise<{ w: number; h: number; ink: number }> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  let ink = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i]! < 200) ink++;
  return { w: c.width, h: c.height, ink };
}

function step(name: string) {
  document.title = `step: ${name}`;
}

async function run() {
  // Scans render completely with the wasm decoders, and not at all without them.
  step("jpx");
  results.jpxWithWasm = await inked("gradient-jpx.pdf", true);
  results.jpxWithoutWasm = await inked("gradient-jpx.pdf", false);
  results.jbig2WithWasm = await inked("jbig2_symbol_offset.pdf", true);
  results.jbig2WithoutWasm = await inked("jbig2_symbol_offset.pdf", false);

  // The PDF viewer: first page, zoom, find.
  step("text content");
  {
    const task = pdfjs.getDocument({ data: new Uint8Array(await fixture("short.pdf")), ...DOCUMENT_OPTIONS, verbosity: 0 });
    const doc = await task.promise;
    try {
      const tc = await (await doc.getPage(1)).getTextContent();
      results.textContent = tc.items.length;
    } catch (e) {
      results.textContentError = `${(e as Error)?.message ?? e} | ${String((e as Error)?.stack ?? "").split("\n").slice(0, 3).join(" / ")}`;
    }
    await task.destroy();
  }
  step("pdf viewer");
  const pdf = await open(pdfEngine, "text-100.pdf", "pdf");
  results.pdfFirstPageMs = Math.round(pdf.firstPaint);
  results.pdfPosition = pdf.view.position();
  const before = (stage.querySelector(".page") as HTMLElement | null)?.getBoundingClientRect().width ?? 0;
  pdf.view.zoomIn();
  await new Promise((r) => setTimeout(r, 300));
  const after = (stage.querySelector(".page") as HTMLElement | null)?.getBoundingClientRect().width ?? 0;
  results.pdfZoomed = after > before;
  step("pdf place");
  results.pdfPlace = await pdf.view.showPlace?.([{ type: "FragmentSelector", value: "page=3", refinedBy: { type: "FragmentSelector", value: "xywh=percent:10,10,30,5" } }]);
  await new Promise((r) => setTimeout(r, 300));
  results.pdfPlaceMarked = !!stage.querySelector(".region-mark") && pdf.view.position().startsWith("Page 3");
  step("pdf find");
  results.pdfFind = await pdf.view.find("Line 7 of page 42");

  // Capturing: a region dragged on a page far down the document, and a selection's marks.
  step("pdf region");
  const scroller = stage.querySelector(".pdf-container") as HTMLElement;
  pdf.view.zoomReset();
  await pdf.view.showPlace?.([{ type: "FragmentSelector", value: "page=5" }]);
  await new Promise((r) => setTimeout(r, 500));
  const sb = scroller.getBoundingClientRect();
  const picking = pdf.view.pickRegion!();
  await drag({ x: sb.left + sb.width * 0.2, y: sb.top + 40 }, { x: sb.left + sb.width * 0.8, y: sb.top + 140 });
  const region = await picking;
  results.pdfRegionPage = region?.page ?? null;
  if (region) {
    const info = await pngInfo(region.png);
    const cssWidth = sb.width * 0.6;
    results.pdfRegionSharp = info.w >= cssWidth * 1.5;
    results.pdfRegionInk = info.ink;
  }
  results.pdfRegionLayerGone = !document.querySelector(".region-layer");
  // Escape cancels.
  const cancelled = pdf.view.pickRegion!();
  await new Promise((r) => setTimeout(r, 50));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  results.pdfRegionCancelled = (await cancelled) === null;
  step("pdf selection marks");
  const textSpan = [...stage.querySelectorAll('.page[data-page-number="5"] .textLayer span')].find((s) => s.textContent?.includes("Line")) as HTMLElement | undefined;
  results.pdfSelectionSpan = !!textSpan;
  if (textSpan) {
    const range = document.createRange();
    range.selectNodeContents(textSpan);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    const sel = pdf.view.selection?.();
    results.pdfSelectionBoxes = sel?.boxes?.length ?? 0;
    results.pdfSelectionEnd = !!sel?.end;
    pdf.view.setMarks?.([{ id: "m", boxes: sel?.boxes ?? [] }]);
    await new Promise((r) => setTimeout(r, 100));
    results.pdfMarks = stage.querySelectorAll(".pending-mark").length;
    pdf.view.setMarks?.([]);
    results.pdfMarksCleared = stage.querySelectorAll(".pending-mark").length === 0;
    // A saved capture: drawn softly, and a click on it is reported (text under it stays selectable).
    step("pdf saved mark");
    let clicked: string[] = [];
    const stopClicks = pdf.view.onMarkClick?.((ids) => (clicked = ids));
    pdf.view.setMarks?.([{ id: "cap#0", boxes: sel?.boxes ?? [], saved: true }]);
    await new Promise((r) => setTimeout(r, 100));
    const savedMark = stage.querySelector(".pending-mark.saved") as HTMLElement | null;
    results.pdfSavedMark = !!savedMark && getComputedStyle(savedMark).pointerEvents === "none";
    getSelection()!.removeAllRanges();
    if (savedMark) {
      const r = savedMark.getBoundingClientRect();
      const under = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)!;
      under.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 }));
    }
    results.pdfSavedMarkClicked = clicked.join();
    stopClicks?.();
    pdf.view.setMarks?.([]);
  }
  pdf.view.destroy();

  // EPUB: opens, finds, and its own scripts never run.
  step("epub");
  const epub = await open(epubEngine, "notebooks.epub", "epub");
  results.epubPainted = epub.firstPaint >= 0;
  await new Promise((r) => setTimeout(r, 500));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fv: any = stage.querySelector("foliate-view");
  const docs = (fv?.renderer?.getContents?.() ?? []).map((c: { doc: Document }) => c.doc);
  results.epubDocs = docs.length;
  results.epubScriptRan = docs.some((d: Document) => / ran$/.test(d.title));
  results.epubPolicy = docs.every((d: Document) => /script-src 'none'/.test(d.querySelector("meta[http-equiv=Content-Security-Policy]")?.getAttribute("content") ?? ""));
  // Reading on: the chapter bar, keys and scrolling past a chapter's end turn chapters.
  step("epub chapters");
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const bar = stage.querySelector(".epub-bar")!;
  const [prevCh, nextCh] = [...bar.querySelectorAll("button")] as HTMLButtonElement[];
  const contents = bar.querySelector("select") as HTMLSelectElement;
  results.epubContents = [...contents.options].map((o) => o.textContent).join("|");
  results.epubStartsAt = epub.view.position();
  results.epubPrevHidden = prevCh!.disabled;
  nextCh!.click();
  await wait(600);
  results.epubAfterNext = epub.view.position();
  results.epubContentsFollows = contents.selectedIndex;
  results.epubNextHiddenAtEnd = nextCh!.disabled;
  const frameDoc = () => fv.renderer.getContents()[0].doc as Document;
  frameDoc().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  await wait(600);
  results.epubAfterLeft = epub.view.position();
  // A deliberate scroll (after a pause) past the end of the (short) first chapter.
  await wait(300);
  frameDoc().dispatchEvent(new WheelEvent("wheel", { deltaY: 60, bubbles: true }));
  frameDoc().dispatchEvent(new WheelEvent("wheel", { deltaY: 60, bubbles: true }));
  await wait(600);
  results.epubAfterWheel = epub.view.position();
  results.epubScriptRanLater = / ran$/.test(frameDoc().title);
  step("epub find");
  results.epubFind = await epub.view.find("generosity");
  epub.view.zoomIn();
  epub.view.destroy();

  // Recognised text: findable and selectable, in an image and a scanned PDF.
  step("ocr image");
  const ocrImg = await open(imageEngine, "words.png", "image", "words.ocr.json");
  await new Promise((r) => setTimeout(r, 500));
  results.ocrImageLines = stage.querySelectorAll(".ocr-layer span").length;
  results.ocrImageFind = await ocrImg.view.find("generosity");
  const span = [...stage.querySelectorAll(".ocr-layer span")].find((s) => s.textContent?.includes("Gravity"));
  if (span) {
    const range = document.createRange();
    range.selectNodeContents(span);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  }
  results.ocrImageSelection = ocrImg.view.selection?.()?.text ?? null;
  ocrImg.view.destroy();
  step("ocr scan");
  const scan = await open(pdfEngine, "scan.pdf", "pdf", "scan.ocr.json");
  await new Promise((r) => setTimeout(r, 800));
  results.ocrScanLines = stage.querySelectorAll(".ocr-layer span").length;
  results.ocrScanFind = await scan.view.find("quote exactly");
  scan.view.destroy();

  // Image: opens and zooms.
  step("image");
  const img = await open(imageEngine, "gradient.png", "image");
  results.imagePainted = img.firstPaint >= 0;
  results.imagePosition = img.view.position();
  img.view.zoomIn();
  results.imageZoomed = (stage.querySelector("img") as HTMLImageElement).style.width !== "";
  step("image region");
  await new Promise((r) => setTimeout(r, 300));
  const ib = (stage.querySelector("img") as HTMLImageElement).getBoundingClientRect();
  const ip = img.view.pickRegion!();
  await drag({ x: ib.left + 10, y: ib.top + 10 }, { x: ib.left + 110, y: ib.top + 60 });
  const ir = await ip;
  results.imageRegion = ir ? (await pngInfo(ir.png)).w > 0 && ir.w > 0 : false;
  img.view.destroy();
}

run().then(
  () => ((window as unknown as { __result: unknown }).__result = { ok: true, ...results }),
  (e) => ((window as unknown as { __result: unknown }).__result = { ok: false, error: `${e?.message ?? e} | ${String(e?.stack ?? "").split("\n")[0]}`, ...results }),
);
