/**
 * End-to-end reader checks, run in WebKit (the app's engine) by scripts/webkit-check.mjs.
 * Results go to `window.__result`.
 */
import "../../src/kit/polyfills";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { pdfEngine, DOCUMENT_OPTIONS } from "../../src/reader/pdf";
import { epubEngine } from "../../src/reader/epub";
import { imageEngine } from "../../src/reader/image";
import type { ReaderEngine, ReaderSource, ReaderStore } from "../../src/reader/host";

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

async function open(engine: ReaderEngine, name: string, format: string, stored?: string, store?: ReaderStore) {
  stage.replaceChildren();
  let firstPaint = -1;
  let painted!: () => void;
  const paint = new Promise<void>((r) => (painted = r));
  const text = async () => (stored ? JSON.parse(new TextDecoder().decode(await fixture(stored))) : null);
  const src: ReaderSource = { id: name, format, title: name, bytes: () => fixture(name), text, store };
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

/** Drags an element (a handle, a frame) from its centre by (dx, dy), as a pointer would. */
async function dragBy(el: Element, dx: number, dy: number, steps = 6) {
  const b = el.getBoundingClientRect();
  const x0 = b.left + b.width / 2;
  const y0 = b.top + b.height / 2;
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: x0, clientY: y0, pointerId: 1, button: 0, isPrimary: true }));
  for (let i = 1; i <= steps; i++) {
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x0 + (dx * i) / steps, clientY: y0 + (dy * i) / steps, pointerId: 1, isPrimary: true }));
    await new Promise((r) => setTimeout(r, 16));
  }
  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x0 + dx, clientY: y0 + dy, pointerId: 1, isPrimary: true }));
  await new Promise((r) => setTimeout(r, 60));
}

/** Drags an element's centre to a point (window coordinates). */
async function dragTo(el: Element, x: number, y: number) {
  const b = el.getBoundingClientRect();
  await dragBy(el, x - (b.left + b.width / 2), y - (b.top + b.height / 2));
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
  // A capture's passage by where it was drawn: straight to its page, its lines brought out
  // (no frame around it).
  step("pdf place by boxes");
  stage.querySelectorAll(".region-mark").forEach((n) => n.remove());
  results.pdfPlaceByBoxes = await pdf.view.showPlace?.([{ type: "TextQuoteSelector", exact: "not in the text at all" }, { type: "librarium:boxes", boxes: [{ page: 42, x: 10, y: 30, w: 60, h: 2 }, { page: 42, x: 10, y: 33, w: 40, h: 2 }] }]);
  await new Promise((r) => setTimeout(r, 400));
  const mark42 = stage.querySelector(".place-mark") as HTMLElement | null;
  results.pdfPlaceByBoxesAt = { position: pdf.view.position(), page: mark42?.closest(".page")?.getAttribute("data-page-number") ?? null, lines: stage.querySelectorAll(".place-mark").length, framed: !!stage.querySelector(".region-mark"), visible: (() => {
    if (!mark42) return false;
    const m = mark42.getBoundingClientRect();
    const c = stage.getBoundingClientRect();
    return m.top >= c.top && m.bottom <= c.bottom;
  })() };
  // A capture saved with a box per word is drawn as one highlight per line.
  pdf.view.setMarks?.([{ id: "w", saved: true, boxes: [10, 22, 34, 46].map((x) => ({ page: 42, x, y: 40, w: 10, h: 1.6 })).concat([{ page: 42, x: 10, y: 42, w: 20, h: 1.6 }]) }]);
  await new Promise((r) => setTimeout(r, 50));
  results.pdfSavedLines = [...stage.querySelectorAll('.pending-mark[data-mark="w"]')].length;
  pdf.view.setMarks?.([]);
  step("pdf find");
  results.pdfFind = await pdf.view.find("Line 7 of page 42");
  // The selectable text lies exactly over the drawn page (no border between them), in words.
  await new Promise((r) => setTimeout(r, 500));
  const shown = [...stage.querySelectorAll(".page")].find((p) => p.querySelector(".textLayer span"));
  const tl = shown?.querySelector(".textLayer")?.getBoundingClientRect();
  const cv = shown?.querySelector("canvas")?.getBoundingClientRect();
  results.pdfTextOverPage = !!tl && !!cv && Math.abs(tl.left - cv.left) < 1 && Math.abs(tl.top - cv.top) < 1 && Math.abs(tl.width - cv.width) < 1.5 && Math.abs(tl.height - cv.height) < 1.5;
  results.pdfTextInWords = [...(shown?.querySelectorAll(".textLayer span") ?? [])].some((s) => /^Line$|^Line\s$/.test(s.textContent ?? ""));

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

  // EPUB, read with Readium (0045).
  step("epub");
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (ok: () => boolean, ms = 5000) => {
    const t0 = performance.now();
    while (!ok() && performance.now() - t0 < ms) await pause(50);
    return ok();
  };
  const savedPrefs = new Map<string, unknown>();
  const epubStore: ReaderStore = { get: (k) => savedPrefs.get(k), set: (k, v) => savedPrefs.set(k, v) };
  const epub = await open(epubEngine, "notebooks.epub", "epub", undefined, epubStore);
  results.epubPainted = epub.firstPaint >= 0;
  const frameDocs = () => [...stage.querySelectorAll("iframe")].map((f) => (f as HTMLIFrameElement).contentDocument).filter((d): d is Document => !!d && !!d.body?.textContent?.trim());
  await waitFor(() => frameDocs().length > 0);
  results.epubDocs = frameDocs().length;
  results.epubScriptRan = frameDocs().some((d) => / ran$/.test(d.title));
  results.epubPolicy = frameDocs().every((d) => [...d.querySelectorAll("meta[http-equiv=Content-Security-Policy]")].some((m) => (m.getAttribute("content") ?? "").startsWith("script-src blob:")));
  // The book's toolbar controls (the library page puts them in its toolbar).
  const controls = document.createElement("div");
  controls.append(...(epub.view.controls?.start ?? []), ...(epub.view.controls?.end ?? []));
  stage.appendChild(controls);
  results.epubImmersive = epub.view.immersive === true;
  const nextPage = () => (stage.querySelector('[aria-label="Next page"]') as HTMLButtonElement).click();
  const openContents = () => (controls.querySelector('[aria-label="Contents"]') as HTMLButtonElement).click();
  const tocItems = () => [...document.querySelectorAll<HTMLButtonElement>(".epub-toc-item")];
  openContents();
  results.epubContents = tocItems().map((b) => b.textContent).join("|");
  openContents();
  results.epubStartsAt = epub.view.position();

  step("epub turn");
  nextPage();
  await waitFor(() => /^Chapter Two/.test(epub.view.position()));
  results.epubAfterNext = epub.view.position();
  openContents();
  results.epubContentsFollows = tocItems().findIndex((b) => b.getAttribute("aria-current") === "true");
  openContents();
  frameDocs()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  await waitFor(() => /^Chapter One/.test(epub.view.position()));
  results.epubAfterLeft = epub.view.position();
  results.epubScriptRanLater = frameDocs().some((d) => / ran$/.test(d.title));

  step("epub find");
  results.epubFind = await epub.view.find("gravity and grace");
  await pause(400);
  const highlights = (name: string) => frameDocs().reduce((n, d) => n + (((d.defaultView as unknown as { CSS: { highlights?: Map<string, Set<Range>> } }).CSS.highlights?.get(name)?.size) ?? 0), 0);
  results.epubFindAt = epub.view.position();
  results.epubFindDrawn = highlights("lib-find-now");
  epub.view.findClear();

  step("epub selection");
  openContents();
  tocItems()[0]?.click();
  await waitFor(() => /^Chapter One/.test(epub.view.position()));
  await pause(300);
  const chapterOneDoc = frameDocs().find((d) => d.title === "Chapter One");
  const firstPara = chapterOneDoc?.querySelector("p");
  if (firstPara?.firstChild) {
    const r = chapterOneDoc!.createRange();
    r.setStart(firstPara.firstChild, 17);
    r.setEnd(firstPara.firstChild, 23);
    chapterOneDoc!.getSelection()!.removeAllRanges();
    chapterOneDoc!.getSelection()!.addRange(r);
  }
  const epubSel = epub.view.selection?.();
  results.epubSelection = epubSel ? `${epubSel.text} ${epubSel.cfi}` : null;
  epub.view.clearSelection?.();
  if (epubSel?.cfi) epub.view.setMarks?.([{ id: "cap#0", boxes: [], cfi: epubSel.cfi, saved: true }]);
  await pause(200);
  results.epubMarkDrawn = highlights("lib-saved");
  // Showing a capture from elsewhere in the book goes to its chapter.
  nextPage();
  await waitFor(() => /^Chapter Two/.test(epub.view.position()));
  results.epubShowPlace = await epub.view.showPlace?.([{ type: "TextQuoteSelector", exact: "rarest" }, { type: "FragmentSelector", value: epubSel?.cfi ?? "" }]);
  await waitFor(() => /^Chapter One/.test(epub.view.position()));
  results.epubShownAt = epub.view.position();

  // Larger text keeps the page's margins (fewer words a line, as in Books).
  step("epub margins");
  // The page's margin and text width as shown: Readium sizes text with CSS zoom on the body,
  // so what is on screen is the body's CSS size times its zoom.
  const marginOf = () => {
    const d = frameDocs().find((x) => x.title === "Chapter One" || x.title === "Chapter Two");
    if (!d) return null;
    const cs = getComputedStyle(d.body);
    const z = Number.parseFloat(cs.zoom) || 1;
    const pad = Number.parseFloat(cs.paddingLeft) * z;
    const text = (Number.parseFloat(cs.maxWidth) - 2 * Number.parseFloat(cs.paddingLeft)) * z;
    return { pad: Math.round(pad), text: Math.round(text), cols: getComputedStyle(d.documentElement).columnCount };
  };
  // In a wide window, where the column (not the window) sets the margins.
  stage.style.width = "1500px";
  await pause(600);
  const marginBefore = marginOf();
  epub.view.zoomIn();
  epub.view.zoomIn();
  epub.view.zoomIn();
  await pause(900);
  results.epubMargins = [marginBefore, marginOf()];
  epub.view.zoomReset();
  stage.style.width = "";
  await pause(600);
  step("epub settings");
  (controls.querySelector(".epub-aa") as HTMLButtonElement).click();
  const epubPanel = document.querySelector(".epub-settings");
  (epubPanel?.querySelector('[role=radio][data-value="night"]') as HTMLButtonElement | null)?.click();
  await pause(800);
  const bookBg = frameDocs()[0] ? getComputedStyle(frameDocs()[0]!.documentElement).backgroundColor : "";
  results.epubDark = bookBg;
  results.epubSettingsSaved = (savedPrefs.get("reader.epub") as { theme?: string; matchApp?: boolean } | undefined)?.theme ?? null;
  results.epubPagesLeft = stage.querySelector(".epub-left")?.textContent ?? "";
  (controls.querySelector(".epub-aa") as HTMLButtonElement).click();
  // The place is remembered: back to Chapter Two, close, and open reopened.
  nextPage();
  await waitFor(() => /^Chapter Two/.test(epub.view.position()));
  epub.view.destroy();
  const reopened = await open(epubEngine, "notebooks.epub", "epub", undefined, epubStore);
  await waitFor(() => /^Chapter/.test(reopened.view.position()));
  results.epubReopenedAt = reopened.view.position();
  reopened.view.destroy();

  step("epub resources");
  const styledBook = await open(epubEngine, "styled.epub", "epub");
  await waitFor(() => frameDocs().length > 0);
  await pause(500);
  const styledDoc = frameDocs()[0];
  const bookImg = styledDoc?.querySelector("img") as HTMLImageElement | null;
  results.epubImage = !!bookImg && bookImg.complete && bookImg.naturalWidth > 0;
  results.epubStylesheet = styledDoc ? /blob:/.test(getComputedStyle(styledDoc.querySelector("p.pic")!).backgroundImage) : false;
  results.epubBookFileRan = frameDocs().some((d) => / ran$/.test(d.title));
  styledBook.view.destroy();

  // A long chapter: find goes to the page each match is on; a click on the page doesn't turn it;
  // in a wide window the page is centred.
  step("epub long");
  let longBook = await open(epubEngine, "long.epub", "epub");
  await waitFor(() => frameDocs().length > 0);
  await pause(400);
  // Whether a range is on the page shown. Inside a zoomed page (another text size), WebKit
  // measures in unzoomed units with the scroll added unscaled: on screen = (x + scroll) × zoom −
  // scroll (checked against a screenshot).
  const rangeOnPage = (f: HTMLIFrameElement, r: Range) => {
    const d = f.contentDocument!;
    const el = d.scrollingElement ?? d.documentElement;
    const z0 = Number.parseFloat(getComputedStyle(d.body).zoom) || 1;
    const bw = d.body.getBoundingClientRect().width || 1;
    const z = z0 === 1 || Math.abs(el.scrollWidth / bw - z0) > Math.abs(el.scrollWidth / bw - 1) ? 1 : z0;
    const b = r.getBoundingClientRect();
    const left = (b.left + el.scrollLeft) * z - el.scrollLeft;
    const right = (b.right + el.scrollLeft) * z - el.scrollLeft;
    return b.width > 0 && left >= -1 && right <= f.clientWidth + 1;
  };
  const shownFrame = () => [...stage.querySelectorAll("iframe")].find((f) => (f as HTMLIFrameElement).style.visibility !== "hidden" && (f as HTMLIFrameElement).contentDocument?.querySelector("p")) as HTMLIFrameElement | undefined;
  const nowOnPage = () => {
    const f = shownFrame();
    const reg = (f?.contentWindow as unknown as { CSS: { highlights?: Map<string, Set<Range>> } } | null)?.CSS.highlights;
    const r = reg?.get("lib-find-now") ? [...reg.get("lib-find-now")!][0] : undefined;
    if (!f || !r) return false;
    return rangeOnPage(f, r);
  };
  const findVisible: boolean[] = [];
  const first = await longBook.view.find("zephyrine");
  await pause(500);
  findVisible.push(nowOnPage());
  for (let i = 0; i < 4; i++) {
    await longBook.view.find("zephyrine", { again: true });
    await pause(500);
    findVisible.push(nowOnPage());
  }
  results.epubLongFind = { count: first.count, visible: findVisible };
  // At another text size (Readium zooms the page), find and showing a place still land right,
  // in a wide window (two columns a page).
  longBook.view.findClear();
  stage.style.width = "1800px";
  await pause(700);
  longBook.view.zoomIn();
  longBook.view.zoomIn();
  longBook.view.zoomIn();
  await pause(900);
  const zoomedVisible: boolean[] = [];
  await longBook.view.find("zephyrine");
  await pause(600);
  zoomedVisible.push(nowOnPage());
  for (let i = 0; i < 4; i++) {
    await longBook.view.find("zephyrine", { again: true });
    await pause(600);
    zoomedVisible.push(nowOnPage());
  }
  results.epubZoomedFind = zoomedVisible;
  longBook.view.findClear();
  // Showing a capture at this size: select the last "zephyrine", take its place as a capture
  // does, go back to the start, then show it.
  const pendingOnPage = () => {
    const f = shownFrame();
    const reg = (f?.contentWindow as unknown as { CSS: { highlights?: Map<string, Set<Range>> } } | null)?.CSS.highlights;
    const r = reg?.get("lib-pending") ? [...reg.get("lib-pending")!][0] : undefined;
    if (!f || !r) return false;
    return rangeOnPage(f, r);
  };
  const zdoc = shownFrame()?.contentDocument;
  let zcfi: string | undefined;
  if (zdoc) {
    const w = zdoc.createTreeWalker(zdoc.body, NodeFilter.SHOW_TEXT);
    let last: Range | null = null;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = (n as Text).data.indexOf("zephyrine");
      if (i >= 0) {
        last = zdoc.createRange();
        last.setStart(n, i);
        last.setEnd(n, i + 9);
      }
    }
    if (last) {
      zdoc.getSelection()!.removeAllRanges();
      zdoc.getSelection()!.addRange(last);
      zcfi = longBook.view.selection?.()?.cfi;
      longBook.view.clearSelection?.();
    }
  }
  await longBook.view.find("Paragraph 1.");
  longBook.view.findClear();
  await pause(500);
  longBook.view.setMarks?.(zcfi ? [{ id: "z", boxes: [], cfi: zcfi }] : []);
  await longBook.view.showPlace?.([{ type: "TextQuoteSelector", exact: "zephyrine" }, { type: "FragmentSelector", value: zcfi ?? "" }]);
  await pause(700);
  results.epubZoomedShow = { cfi: zcfi ?? null, onPage: pendingOnPage(), at: longBook.view.position(), zoom: getComputedStyle(shownFrame()!.contentDocument!.body).zoom };
  longBook.view.setMarks?.([]);
  // Opened with a place at a saved text size (Show from a note or another tab): the place is
  // asked for as soon as the book opens.
  longBook.view.destroy();
  // With a remembered reading place elsewhere in the book (Readium goes there first).
  const sized = new Map<string, unknown>([["reader.epub", { fontSize: 1.3 }], ["reader.place.long.epub", { href: "c.xhtml", type: "application/xhtml+xml", locations: { progression: 0.6, position: 40 } }]]);
  const reopenedLong = await open(epubEngine, "long.epub", "epub", undefined, { get: (k) => sized.get(k), set: (k, v) => sized.set(k, v) });
  reopenedLong.view.setMarks?.(zcfi ? [{ id: "z", boxes: [], cfi: zcfi }] : []);
  await reopenedLong.view.showPlace?.([{ type: "TextQuoteSelector", exact: "zephyrine" }, { type: "FragmentSelector", value: zcfi ?? "" }]);
  await pause(1200);
  results.epubOpenedAtPlaceCols = getComputedStyle(shownFrame()!.contentDocument!.documentElement).columnCount;
  results.epubOpenedAtPlace = { onPage: pendingOnPage(), at: reopenedLong.view.position(), zoom: getComputedStyle(shownFrame()!.contentDocument!.body).zoom };
  reopenedLong.view.destroy();
  stage.style.width = "";
  const longAgain = await open(epubEngine, "long.epub", "epub");
  await waitFor(() => frameDocs().length > 0);
  await pause(400);
  longBook = longAgain;
  longBook.view.zoomReset();
  await pause(600);
  const atBefore = longBook.view.position();
  const fdoc = shownFrame()?.contentDocument;
  const fw = shownFrame()?.clientWidth ?? 0;
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) fdoc?.body.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: fw - 20, clientY: 200, button: 0 }));
  await pause(700);
  results.epubClickTurned = longBook.view.position() !== atBefore;
  stage.style.width = "1800px";
  await pause(800);
  const es = stage.querySelector(".epub-stage")!.getBoundingClientRect();
  const ec = stage.querySelector(".epub-container")!.getBoundingClientRect();
  results.epubCentred = { stage: Math.round(es.width), offset: Math.round((es.left + es.width / 2) - (ec.left + ec.width / 2)) };
  stage.style.width = "";
  longBook.view.destroy();

  step("epub fixed layout");
  const fixedBook = await open(epubEngine, "fixed.epub", "epub");
  await waitFor(() => /^Page 1 of 2/.test(fixedBook.view.position()));
  results.epubFixedAt = fixedBook.view.position();
  results.epubFixedFrames = stage.querySelectorAll("iframe.readium-navigator-iframe").length;
  fixedBook.view.destroy();

  // Recognised text: findable and selectable, in an image and a scanned PDF.
  // A scan with recognised text: the invisible text is put on the words seen.
  step("pdf scan text on its ink");
  const scanned = await open(pdfEngine, "ocr-words.pdf", "pdf");
  await new Promise((r) => setTimeout(r, 1200));
  {
    const truth = (await (await fetch("/tests/fixtures/library/ocr-words.json")).json()) as { word: string; line: number; x: number; w: number }[];
    const pageEl = stage.querySelector(".page") as HTMLElement;
    const pr = pageEl.getBoundingClientRect();
    const k = pr.width / 612;
    const spans = [...pageEl.querySelectorAll(".textLayer span")].filter((x) => !x.children.length && (x.textContent ?? "").trim()) as HTMLElement[];
    let close = 0;
    let worst = 0;
    truth.forEach((t, i) => {
      const sp = spans[i];
      if (!sp || sp.textContent!.trim() !== t.word) return;
      const at = (sp.getBoundingClientRect().left - pr.left) / k;
      const off = Math.abs(at - t.x);
      worst = Math.max(worst, off);
      if (off <= 1.5) close++;
    });
    results.pdfScanInk = { words: truth.length, spans: spans.length, close, worst: Math.round(worst * 10) / 10 };
  }
  scanned.view.destroy();

  // Showing a place in a PDF whose first page is a different size (a JSTOR cover page): the
  // place stays in view as the other pages' real sizes arrive.
  step("pdf cover page show");
  const cover = await open(pdfEngine, "cover.pdf", "pdf");
  await cover.view.showPlace?.([{ type: "FragmentSelector", value: "page=20" }, { type: "librarium:boxes", boxes: [{ page: 20, x: 10, y: 50, w: 60, h: 2 }] } as never]);
  await new Promise((r) => setTimeout(r, 1500));
  {
    const mark = stage.querySelector(".place-mark");
    const box = stage.querySelector(".pdf-container")!.getBoundingClientRect();
    const m = mark?.getBoundingClientRect();
    results.pdfCoverShow = { page: mark?.closest(".page")?.getAttribute("data-page-number") ?? null, inView: !!m && m.top >= box.top && m.bottom <= box.bottom };
  }
  cover.view.destroy();

  // Editing a capture's parts: handles at a passage's ends, a frame on a region.
  step("edit pdf article");
  const article = await open(pdfEngine, "article.pdf", "pdf");
  await new Promise((r) => setTimeout(r, 900));
  const spanOf = (root: ParentNode, re: RegExp) => [...root.querySelectorAll(".textLayer span")].find((s) => re.test(s.textContent ?? "")) as HTMLElement | undefined;
  const a1 = spanOf(stage, /^grace\s/) ;
  const lineSpans = (word: string) => [...stage.querySelectorAll(".textLayer span")].filter((s) => (s.textContent ?? "").startsWith(word));
  // Select "Line 3 of the article: ..." through its end.
  const l3 = spanOf(stage, /^3\s/);
  const l3start = l3?.previousElementSibling as HTMLElement | null;
  void a1;
  void lineSpans;
  const edits: { done: boolean; text?: { text: string; boxes?: unknown[] }; region?: { w: number; h: number; png?: string } }[] = [];
  let articleEditor: { stop(): void } | undefined;
  if (l3start && l3) {
    const r = document.createRange();
    r.setStart(l3start.firstChild!, 0);
    r.setEnd(l3.nextElementSibling!.firstChild!, (l3.nextElementSibling!.textContent ?? "").trimEnd().length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(r);
    const sel = article.view.selection?.();
    getSelection()!.removeAllRanges();
    results.editPdfSelected = sel?.text ?? null;
    articleEditor = article.view.editParts?.([{ key: "a", boxes: sel?.boxes ?? [], page: sel?.page, quote: sel?.text }], (e) => edits.push(e as never));
    await new Promise((r2) => setTimeout(r2, 100));
    const endH = stage.querySelector(".range-handle.end") as HTMLElement | null;
    const startH = stage.querySelector(".range-handle.start") as HTMLElement | null;
    results.editPdfHandles = !!endH && !!startH && !endH.hidden && !startH.hidden;
    // Drag the end down a line (to the end of line 3's next line), then the start forward.
    if (endH) {
      const eb = endH.getBoundingClientRect();
      await dragTo(endH, eb.left + 300, eb.top + eb.height / 2 + 14 * (stage.querySelector(".page")!.getBoundingClientRect().height / 6000));
    }
    const afterEnd = edits.filter((e) => e.done).at(-1);
    results.editPdfEnd = afterEnd?.text ? { text: afterEnd.text.text, boxes: afterEnd.text.boxes?.length ?? 0 } : null;
    if (startH) {
      const sb = startH.getBoundingClientRect();
      await dragTo(startH, sb.left + 40, sb.top + sb.height / 2);
    }
    const afterStart = edits.filter((e) => e.done).at(-1);
    results.editPdfStart = afterStart?.text?.text ?? null;
    articleEditor?.stop();
    results.editPdfStopped = !stage.querySelector(".range-handle");
  }
  // A region: shown first (outlined), then edited: no outline under it. Resize it by its corner;
  // its picture is taken again; after the pages render again (zoom), it stays as resized.
  await article.view.showPlace?.([{ type: "FragmentSelector", value: "page=1", refinedBy: { type: "FragmentSelector", value: "xywh=percent:10,1,20,1" } }]);
  await new Promise((r) => setTimeout(r, 200));
  const outlinedBefore = stage.querySelectorAll(".region-mark").length;
  const regionEdits: typeof edits = [];
  const rEditor = article.view.editParts?.([{ key: "r", region: { page: 1, x: 10, y: 1, w: 20, h: 1 } }], (e) => regionEdits.push(e as never));
  await new Promise((r) => setTimeout(r, 100));
  const outlinedWhileEditing = stage.querySelectorAll(".region-mark").length;
  const se = stage.querySelector(".region-edit .rh.se");
  if (se) await dragBy(se, 120, 40);
  await new Promise((r) => setTimeout(r, 400));
  const lastRegion = regionEdits.filter((e) => e.done).at(-1)?.region;
  article.view.zoomIn();
  await new Promise((r) => setTimeout(r, 900));
  const frameNow = stage.querySelector(".region-edit") as HTMLElement | null;
  results.editPdfRegion = lastRegion
    ? { grew: lastRegion.w > 20 && lastRegion.h > 1, png: (lastRegion.png ?? "").startsWith("data:image/png") && (lastRegion.png ?? "").length > 200, outlinedBefore, outlinedWhileEditing, keptAfterRender: !!frameNow && Math.abs(Number.parseFloat(frameNow.style.width) - lastRegion.w) < 0.05 && stage.querySelectorAll(".region-edit").length === 1 }
    : null;
  rEditor?.stop();
  article.view.zoomReset();
  await new Promise((r) => setTimeout(r, 500));
  // Dragged to the bottom edge, the document scrolls and the passage carries on.
  {
    const pc = stage.querySelector(".pdf-container") as HTMLElement;
    const first = [...stage.querySelectorAll(".textLayer span")].find((x) => /^Line\s$/.test(x.textContent ?? "") && x.getBoundingClientRect().top > pc.getBoundingClientRect().top + 40) as HTMLElement | undefined;
    const scrollEdits: { done: boolean; text?: { text: string } }[] = [];
    if (first?.firstChild) {
      const r = document.createRange();
      r.setStart(first.firstChild, 0);
      r.setEnd(first.firstChild, 4);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
      const sel = article.view.selection?.();
      getSelection()!.removeAllRanges();
      const ed = article.view.editParts?.([{ key: "s", boxes: sel?.boxes ?? [], page: sel?.page }], (e) => scrollEdits.push(e as never));
      await new Promise((r2) => setTimeout(r2, 100));
      const endH = stage.querySelector(".range-handle.end") as HTMLElement | null;
      const top0 = pc.scrollTop;
      if (endH) {
        const b = endH.getBoundingClientRect();
        const cb = pc.getBoundingClientRect();
        const pt = (type: string, x: number, y: number, target: EventTarget = window) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, isPrimary: true }));
        pt("pointerdown", b.left + 1, b.top + b.height / 2, endH);
        pt("pointermove", b.left + 100, cb.bottom - 6);
        await new Promise((r2) => setTimeout(r2, 600));
        pt("pointerup", b.left + 100, cb.bottom - 6);
        await new Promise((r2) => setTimeout(r2, 200));
      }
      const last = scrollEdits.filter((e) => e.done).at(-1)?.text?.text ?? "";
      results.editPdfScroll = { scrolled: pc.scrollTop - top0, length: last.length, starts: last.slice(0, 5) };
      ed?.stop();
    }
  }
  article.view.destroy();

  step("edit epub");
  for (const size of [1, 1.3]) {
    const sizedStore = new Map<string, unknown>([["reader.epub", { fontSize: size }]]);
    const book = await open(epubEngine, "long.epub", "epub", undefined, { get: (k) => sizedStore.get(k), set: (k, v) => sizedStore.set(k, v) });
    await new Promise((r) => setTimeout(r, 1200));
    const fr = [...stage.querySelectorAll("iframe")].find((f) => (f as HTMLIFrameElement).style.visibility !== "hidden" && (f as HTMLIFrameElement).contentDocument?.querySelector("p")) as HTMLIFrameElement | undefined;
    const d = fr?.contentDocument;
    const p2 = d?.querySelectorAll("p")[1];
    const t = p2?.firstChild as Text | undefined;
    const bookEdits: typeof edits = [];
    if (t && d) {
      const r = d.createRange();
      r.setStart(t, 0);
      r.setEnd(t, 12);
      d.getSelection()!.removeAllRanges();
      d.getSelection()!.addRange(r);
      const sel = book.view.selection?.();
      book.view.clearSelection?.();
      const ed = book.view.editParts?.([{ key: "e", cfi: sel?.cfi ?? null, quote: sel?.text }], (e) => bookEdits.push(e as never));
      await new Promise((r2) => setTimeout(r2, 100));
      const endH = stage.querySelector(".range-handle.end") as HTMLElement | null;
      const startH = stage.querySelector(".range-handle.start") as HTMLElement | null;
      // The handles sit at the passage's ends on screen.
      const eb = endH?.getBoundingClientRect();
      const sb = startH?.getBoundingClientRect();
      const words = sel?.text ?? "";
      if (endH && eb) await dragTo(endH, eb.left + 200, eb.top + eb.height * 1.6);
      const last = bookEdits.filter((e) => e.done).at(-1)?.text;
      results[`editEpub${size === 1 ? "" : "Zoomed"}`] = { before: words, after: last?.text ?? null, handles: !!eb && !!sb && sb.left < (eb?.left ?? 0) + 1000, cfiChanged: !!(last as { cfi?: string } | undefined)?.cfi && (last as { cfi?: string }).cfi !== sel?.cfi };
      ed?.stop();
    }
    book.view.destroy();
  }

  // Dragging a passage's end into the edge turns the page, and the passage carries on there.
  step("edit epub across pages");
  for (const size of [1, 1.3]) {
    const sizedStore = new Map<string, unknown>([["reader.epub", { fontSize: size }]]);
    const book = await open(epubEngine, "long.epub", "epub", undefined, { get: (k) => sizedStore.get(k), set: (k, v) => sizedStore.set(k, v) });
    await new Promise((r) => setTimeout(r, 1200));
    const fr = [...stage.querySelectorAll("iframe")].find((f) => (f as HTMLIFrameElement).style.visibility !== "hidden" && (f as HTMLIFrameElement).contentDocument?.querySelector("p")) as HTMLIFrameElement | undefined;
    const d = fr?.contentDocument;
    const t = d?.querySelectorAll("p")[1]?.firstChild as Text | undefined;
    const turnEdits: { done: boolean; text?: { text: string; cfi?: string } }[] = [];
    const before = book.view.position();
    if (t && d) {
      const r = d.createRange();
      r.setStart(t, 0);
      r.setEnd(t, 12);
      d.getSelection()!.removeAllRanges();
      d.getSelection()!.addRange(r);
      const sel = book.view.selection?.();
      book.view.clearSelection?.();
      const ed = book.view.editParts?.([{ key: "e", cfi: sel?.cfi ?? null }], (e) => turnEdits.push(e as never));
      await new Promise((r2) => setTimeout(r2, 100));
      const endH = stage.querySelector(".range-handle.end") as HTMLElement | null;
      if (endH) {
        const b = endH.getBoundingClientRect();
        const sb = stage.querySelector(".epub-stage")!.getBoundingClientRect();
        const x0 = b.left + b.width / 2;
        const y0 = b.top + b.height / 2;
        const pt = (type: string, x: number, y: number, target: EventTarget = window) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, isPrimary: true }));
        pt("pointerdown", x0, y0, endH);
        pt("pointermove", (x0 + sb.right) / 2, y0);
        pt("pointermove", sb.right - 8, y0);
        results[`epubTurnArmed${size === 1 ? "" : "Zoomed"}`] = stage.querySelector(".epub-container")?.classList.contains("armed-next") ?? false;
        await new Promise((r2) => setTimeout(r2, 1000));
        pt("pointermove", sb.left + sb.width / 2, sb.top + sb.height / 2);
        await new Promise((r2) => setTimeout(r2, 50));
        pt("pointerup", sb.left + sb.width / 2, sb.top + sb.height / 2);
        await new Promise((r2) => setTimeout(r2, 300));
      }
      const last = turnEdits.filter((e) => e.done).at(-1)?.text;
      results[`epubDragTurn${size === 1 ? "" : "Zoomed"}`] = { before, after: book.view.position(), start: last?.text.slice(0, 12) ?? null, length: last?.text.length ?? 0, armedOff: !stage.querySelector(".epub-container.armed-next") };
      ed?.stop();
    }
    book.view.destroy();
  }

  // Trackpad swipes: one swipe (with its fading momentum) turns one page; a new swipe within
  // the momentum turns again; the sideways scroll doesn't move the columns itself; it animates.
  step("epub swipe");
  {
    const book = await open(epubEngine, "long.epub", "epub");
    await new Promise((r) => setTimeout(r, 1200));
    const left = () => Number((stage.querySelector(".epub-left")?.textContent ?? "").match(/\d+/)?.[0] ?? (/(Last)/.test(stage.querySelector(".epub-left")?.textContent ?? "") ? 0 : NaN));
    const fdoc = () => ([...stage.querySelectorAll("iframe")].find((f) => (f as HTMLIFrameElement).style.visibility !== "hidden" && (f as HTMLIFrameElement).contentDocument?.querySelector("p")) as HTMLIFrameElement | undefined)?.contentDocument;
    let sawAnimation = false;
    const moving = () => {
      const t = getComputedStyle(stage.querySelector(".epub-stage")!).transform;
      if (t && t !== "none" && t !== "matrix(1, 0, 0, 1, 0, 0)") sawAnimation = true;
    };
    const swipeOnce = async (deltas: number[]) => {
      let prevented = 0;
      for (const d of deltas) {
        const ev = new WheelEvent("wheel", { deltaX: d, deltaY: 0, bubbles: true, cancelable: true });
        fdoc()?.body.dispatchEvent(ev);
        if (ev.defaultPrevented) prevented++;
        moving();
        await new Promise((r) => setTimeout(r, 16));
      }
      return prevented;
    };
    const start = left();
    const momentum = [4, 10, 18, 24, 18, 13, 9, 7, 5, 4, 3, 2, 2, 1, 1];
    const prevented = await swipeOnce(momentum);
    for (let i = 0; i < 12; i++) {
      moving();
      await new Promise((r) => setTimeout(r, 30));
    }
    await new Promise((r) => setTimeout(r, 500));
    const afterOne = left();
    // Another swipe begins while the first one's momentum is still arriving.
    await swipeOnce([2, 1, 1, 6, 16, 26, 20, 14, 9, 6, 4, 2, 1]);
    await new Promise((r) => setTimeout(r, 900));
    const afterTwo = left();
    // A long momentum tail with bumps in it (as trackpads send) turns one page, not several.
    await swipeOnce([5, 14, 26, 30, 22, 15, 9, 6, 4, 9, 6, 4, 3, 8, 5, 3, 2, 7, 4, 2, 1, 3, 1, 1]);
    await new Promise((r) => setTimeout(r, 900));
    const afterBumpy = left();
    results.epubSwipe = { start, afterOne, afterTwo, afterBumpy, prevented, events: momentum.length, sawAnimation };
    book.view.destroy();
  }

  // Footnotes (R-065): a click on a note's number shows the note (several pages on, or in another
  // file), and its link back returns to the reference.
  step("epub footnotes");
  {
    const notesBook = await open(epubEngine, "footnotes.epub", "epub");
    await waitFor(() => frameDocs().length > 0);
    await pause(600);
    /** Whether the element with this ID is on the page shown (in any frame shown). */
    const shownId = (id: string) =>
      [...stage.querySelectorAll("iframe")].some((f) => {
        const fr = f as HTMLIFrameElement;
        const el = fr.style.visibility !== "hidden" ? fr.contentDocument?.getElementById(id) : null;
        if (!el) return false;
        const r = fr.contentDocument!.createRange();
        r.selectNodeContents(el);
        return rangeOnPage(fr, r);
      });
    /**
     * Clicks the link with this ID in the book, as a reader would: on what is under the pointer
     * (a <sup> inside it, often), the hand moving a few pixels between press and release (as a
     * real click does).
     */
    const clickLink = async (id: string) => {
      const fr = [...stage.querySelectorAll("iframe")].find((f) => (f as HTMLIFrameElement).contentDocument?.getElementById(id)) as HTMLIFrameElement | undefined;
      const a = fr?.contentDocument?.getElementById(id);
      if (!a) return false;
      const target = (a.firstElementChild as HTMLElement | null) ?? a;
      const r = target.getBoundingClientRect();
      const fb = fr!.getBoundingClientRect();
      // A real click from the runner (trusted, as a hand's), moving 3 pixels between press and
      // release; else (another runner) one made here.
      const native = (window as unknown as { webkit?: { messageHandlers?: { nativeClick?: { postMessage(m: unknown): Promise<unknown> } } } }).webkit?.messageHandlers?.nativeClick;
      if (native) await native.postMessage({ x: fb.left + r.left + r.width / 2, y: fb.top + r.top + r.height / 2, dx: 3 });
      else target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 }));
      await pause(1500);
      return true;
    };
    const start = { ref1: shownId("return-footnote-1"), note1: shownId("footnote-1") };
    // A drag that starts on a note's number selects text; it doesn't follow the link.
    const native0 = (window as unknown as { webkit?: { messageHandlers?: { nativeClick?: { postMessage(m: unknown): Promise<unknown> } } } }).webkit?.messageHandlers?.nativeClick;
    let dragStays: boolean | null = null;
    if (native0) {
      const fr0 = [...stage.querySelectorAll("iframe")].find((f) => (f as HTMLIFrameElement).contentDocument?.getElementById("return-footnote-1")) as HTMLIFrameElement;
      const sup0 = fr0.contentDocument!.getElementById("return-footnote-1")!.firstElementChild as HTMLElement;
      const b0 = fr0.getBoundingClientRect(), r0 = sup0.getBoundingClientRect();
      const before0 = notesBook.view.position();
      await native0.postMessage({ x: b0.left + r0.left + r0.width / 2, y: b0.top + r0.top + r0.height / 2, dx: 60 });
      await pause(1200);
      dragStays = notesBook.view.position() === before0 && shownId("return-footnote-1");
      fr0.contentDocument!.getSelection()?.removeAllRanges();
    }
    const sameFile = (await clickLink("return-footnote-1")) && shownId("footnote-1");
    const back = sameFile && (await clickLink("footnote-1") ? true : false);
    // The link back is inside the note: find it there.
    const backLink = [...stage.querySelectorAll("iframe")].map((f) => (f as HTMLIFrameElement).contentDocument?.querySelector('#footnote-1 a[href="#return-footnote-1"]') as HTMLElement | null).find(Boolean);
    if (backLink) {
      backLink.id = "lib-back-1";
      await clickLink("lib-back-1");
    }
    const backShown = shownId("return-footnote-1");
    const otherFile = (await clickLink("ref2")) && shownId("n2");
    const fromNotes = [...stage.querySelectorAll("iframe")].map((f) => (f as HTMLIFrameElement).contentDocument?.querySelector('#n2 a') as HTMLElement | null).find(Boolean);
    if (fromNotes) fromNotes.id = "lib-back-2";
    const backFromNotes = fromNotes ? (await clickLink("lib-back-2")) && shownId("ref2") : false;
    const spaced = (await clickLink("ref3")) && shownId("n3");
    results.epubFootnotes = { dragStays, native: !!(window as unknown as { webkit?: { messageHandlers?: { nativeClick?: unknown } } }).webkit?.messageHandlers?.nativeClick, start, sameFile, back, backShown, otherFile, backFromNotes, spaced, position: notesBook.view.position() };
    notesBook.view.destroy();
  }

  step("epub picture");
  const pictured = await open(epubEngine, "styled.epub", "epub");
  await new Promise((r) => setTimeout(r, 900));
  const pdoc = [...stage.querySelectorAll("iframe")].map((f) => (f as HTMLIFrameElement).contentDocument).find((x) => x?.querySelector("img"));
  const pimg = pdoc?.querySelector("img");
  pimg?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 100));
  const psel = pictured.view.selection?.();
  results.epubPicture = { image: (psel?.image ?? "").startsWith("data:image/png"), text: psel?.text ?? null, cfi: (psel?.cfi ?? "").startsWith("epubcfi(") };
  pictured.view.destroy();

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
  // Editing on an image: a recognised passage's end dragged; a region resized.
  const imgSel = ocrImg.view.selection?.();
  getSelection()!.removeAllRanges();
  const imgEdits: { done: boolean; text?: { text: string }; region?: { w: number; png?: string } }[] = [];
  const imgEditor = ocrImg.view.editParts?.([{ key: "t", boxes: imgSel?.boxes ?? [] }, { key: "r", region: { x: 10, y: 10, w: 20, h: 20 } }], (e) => imgEdits.push(e as never));
  await new Promise((r) => setTimeout(r, 100));
  results.ocrImageHandles = !!stage.querySelector(".range-handle.end") && !!stage.querySelector(".region-edit");
  const imgStart = stage.querySelector(".range-handle.start");
  // Past the first word (a start snaps to the start of the word under it, as in Books).
  if (imgStart) await dragBy(imgStart, 150, 0);
  const imgCorner = stage.querySelector(".region-edit .rh.se");
  if (imgCorner) await dragBy(imgCorner, 40, 30);
  const tEdit = imgEdits.filter((e) => e.done && e.text).at(-1)?.text?.text;
  const rEdit = imgEdits.filter((e) => e.done && e.region).at(-1)?.region;
  results.ocrImageEdited = { text: tEdit ?? null, region: rEdit ? rEdit.w > 20 && (rEdit.png ?? "").startsWith("data:image/png") : false };
  imgEditor?.stop();
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

  // Boards: the real Excalidraw (features/boards/engine.ts), offline, with its fonts served here.
  step("board");
  {
    const before = performance.getEntriesByType("resource").length;
    (window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = "/excalidraw/";
    const { mountBoard, boardPicture, portableFile } = await import("../../src/features/boards/engine");
    stage.replaceChildren();
    let changes = 0;
    let steps = 0;
    const initial = JSON.stringify({ type: "excalidraw", version: 2, source: "test", elements: [], appState: {}, files: {} });
    const linkStarts: string[] = [];
    // A small red picture (a library item's data, as the page gives it).
    const pc = Object.assign(document.createElement("canvas"), { width: 40, height: 20 });
    const pctx = pc.getContext("2d")!;
    pctx.fillStyle = "#c00";
    pctx.fillRect(0, 0, 40, 20);
    const picture = { dataURL: pc.toDataURL("image/png"), mimeType: "image/png", width: 40, height: 20 };
    const board = await mountBoard(stage, { scene: initial, theme: "light", readOnly: false, onChange: () => changes++, onStep: () => steps++, onFiles() {}, renderCard: (rid, host) => (host.append(Object.assign(document.createElement("div"), { className: "probe-card", textContent: `Card ${rid}` })), () => host.replaceChildren()), imageOf: async () => picture, onLinkStart: (el) => void linkStarts.push(el), onOpenLink() {} });
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await pause(600);
    const live = () => board.current().elements.filter((e) => !e.isDeleted);
    // Loading a drawing (changed outside) is neither a change to save nor a step.
    board.load(JSON.stringify({ type: "excalidraw", version: 2, source: "test", elements: [{ id: "r1", type: "rectangle", x: 0, y: 0, width: 50, height: 40, version: 1, versionNonce: 1, isDeleted: false, seed: 1 }], appState: {}, files: {} }));
    await pause(300);
    const afterLoad = { changes, steps, elements: live().length };
    // Typing a text: double-click opens Excalidraw's text editor.
    const canvas = stage.querySelector(".excalidraw canvas.interactive") as HTMLCanvasElement;
    const cr = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent("dblclick", { clientX: cr.left + 400, clientY: cr.top + 300, bubbles: true, cancelable: true }));
    await pause(300);
    const ta = stage.querySelector("textarea.excalidraw-wysiwyg") as HTMLTextAreaElement | null;
    if (ta) {
      ta.value = "Technique";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    }
    await pause(400);
    const typed = { changes, steps, texts: live().filter((e) => e.type === "text").map((e) => e.text) };
    // ⌘Z, sent the way the board page sends it: one step undone, saved as a change, not a new step.
    board.undo();
    await pause(400);
    const undone = { texts: live().filter((e) => e.type === "text").length, steps };
    board.redo();
    await pause(400);
    const redone = live().filter((e) => e.type === "text").length;
    board.setTheme("dark");
    await pause(200);
    const dark = !!stage.querySelector(".excalidraw.theme--dark");
    const saved = JSON.parse(board.current().scene) as { type: string; elements: unknown[] };
    // Links: `[[` typed in a new text reaches the page; linking replaces it with the name, keeps
    // the record's ID on the element, and measures the text again.
    canvas.dispatchEvent(new MouseEvent("dblclick", { clientX: cr.left + 200, clientY: cr.top + 500, bubbles: true, cancelable: true }));
    await pause(300);
    const ta2 = stage.querySelector("textarea.excalidraw-wysiwyg") as HTMLTextAreaElement | null;
    if (ta2) {
      ta2.value = "See [[";
      ta2.setSelectionRange(6, 6);
      ta2.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await pause(400);
    const NOTE = "0192f3a4-7c1e-7b2a-9f00-000000000099";
    const started = linkStarts[0] ?? "";
    const widthBefore = (live().find((e) => e.id === started) as { width?: number } | undefined)?.width ?? 0;
    const linked = started ? board.link([started], { id: NOTE, label: "Jacques Ellul" }, { replaceTyped: true }) : false;
    await pause(300);
    const el = live().find((e) => e.id === started) as { text?: string; width?: number } | undefined;
    const reloaded = (JSON.parse(board.current().scene) as { elements: { id: string; link?: string; customData?: unknown }[] }).elements.find((e) => e.id === started);
    results.boardLinks = {
      started: !!started,
      editorClosed: !stage.querySelector("textarea.excalidraw-wysiwyg"),
      linked,
      text: el?.text ?? null,
      link: reloaded?.link ?? null,
      kept: JSON.stringify(reloaded?.customData ?? null),
      wider: (el?.width ?? 0) > widthBefore,
    };
    // Cards and pictures: a capture's card shows our own DOM; a picture goes in by its record ID,
    // and the drawing saved keeps the ID, not the picture's data.
    const CAP = "0192f3a4-7c1e-7b2a-9f00-0000000000aa";
    const PIC = "0192f3a4-7c1e-7b2a-9f00-0000000000bb";
    await board.insert([
      { id: CAP, label: "Technique integrates everything", picture: false, embed: true },
      { id: PIC, label: "Red", picture: true, embed: true },
    ]);
    await pause(900);
    const savedNow = JSON.parse(board.current().scene) as { files: Record<string, unknown>; elements: { type: string; fileId?: string; link?: string; customData?: { librarium?: { embed?: boolean } } }[] };
    const cardEl = savedNow.elements.find((e) => e.type === "embeddable");
    const picEl = savedNow.elements.find((e) => e.type === "image");
    results.boardCards = {
      card: stage.querySelector(".excalidraw .probe-card")?.textContent ?? null,
      cardLink: cardEl?.link ?? null,
      cardEmbed: cardEl?.customData?.librarium?.embed ?? false,
      pictureId: picEl?.fileId ?? null,
      pictureLink: picEl?.link ?? null,
      pictureDataSaved: PIC in (savedNow.files ?? {}),
    };
    // The board elsewhere: a picture (SVG, PNG) and a file that reads anywhere, cards written out.
    const sceneNow = board.current().scene;
    const p = { cardText: (rid: string) => (rid === CAP ? "Technique integrates everything.\n— The Technological Society, p. 1" : "A note"), imageOf: async () => picture };
    const svg = await boardPicture(sceneNow, p, "svg");
    const png = await boardPicture(sceneNow, p, "png");
    const file = JSON.parse(await portableFile(sceneNow, p)) as { elements: { type: string; text?: string; isDeleted?: boolean }[]; files: Record<string, { dataURL?: string }> };
    results.boardExport = {
      svgText: svg.outerHTML.includes("Technique integrates everything.") && svg.outerHTML.includes("The Technological Society"),
      svgPicture: svg.outerHTML.includes("<image"),
      png: png.type === "image/png" && png.size > 1000,
      fileEmbeds: file.elements.filter((e) => e.type === "embeddable" && !e.isDeleted).length,
      fileCardText: file.elements.some((e) => e.type === "text" && e.text?.includes("Technique integrates everything.")),
      filePicture: (file.files[PIC]?.dataURL ?? "").startsWith("data:image/png"),
    };
    const external = performance.getEntriesByType("resource").slice(before).map((e) => e.name).filter((n) => !n.startsWith(location.origin) && !n.startsWith("data:") && !n.startsWith("blob:"));
    results.board = { afterLoad, typed, undone, redone, dark, savedType: saved.type, external, editor: !!ta };
    board.destroy();

    // A large board: 300 shapes, 40 texts, 30 cards, 10 pictures. Opening, saving and drawing it
    // as a picture stay quick.
    step("board, large");
    const big: unknown[] = [];
    const base = { version: 1, versionNonce: 1, isDeleted: false, seed: 1, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, boundElements: null, updated: 1, link: null, locked: false };
    for (let i = 0; i < 300; i++) big.push({ ...base, id: `r${i}`, type: i % 3 ? "rectangle" : "ellipse", x: (i % 20) * 120, y: Math.floor(i / 20) * 100, width: 90, height: 60 });
    for (let i = 0; i < 40; i++) big.push({ ...base, id: `t${i}`, type: "text", x: (i % 8) * 300, y: 1600 + Math.floor(i / 8) * 60, width: 200, height: 25, text: `Text number ${i}`, originalText: `Text number ${i}`, fontSize: 20, fontFamily: 5, textAlign: "left", verticalAlign: "top", containerId: null, lineHeight: 1.25, autoResize: true });
    for (let i = 0; i < 30; i++) big.push({ ...base, id: `c${i}`, type: "embeddable", x: (i % 6) * 420, y: 2000 + Math.floor(i / 6) * 200, width: 400, height: 180, link: `librarium://record/0192f3a4-7c1e-7b2a-9f00-${String(i).padStart(12, "0")}`, customData: { librarium: { links: [{ id: "x", label: "x" }], embed: true } } });
    for (let i = 0; i < 10; i++) big.push({ ...base, id: `p${i}`, type: "image", x: i * 300, y: 3200, width: 240, height: 120, fileId: `0192f3a4-7c1e-7b2a-9f00-${String(100 + i).padStart(12, "0")}`, status: "saved", scale: [1, 1] });
    const bigScene = JSON.stringify({ type: "excalidraw", version: 2, source: "test", elements: big, appState: {}, files: {} });
    stage.replaceChildren();
    let cards = 0;
    const t0 = performance.now();
    const large = await mountBoard(stage, { scene: bigScene, theme: "light", readOnly: false, onChange() {}, onStep() {}, onFiles() {}, renderCard: (_rid, host) => (cards++, host.append("card"), () => host.replaceChildren()), imageOf: async () => picture, onLinkStart() {}, onOpenLink() {} });
    const openMs = performance.now() - t0;
    await pause(800);
    const t1 = performance.now();
    const current = large.current();
    const saveMs = performance.now() - t1;
    const t2 = performance.now();
    const bigSvg = await boardPicture(current.scene, { cardText: () => "A card", imageOf: async () => picture }, "svg");
    const pictureMs = performance.now() - t2;
    results.boardLarge = { openMs: Math.round(openMs), saveMs: Math.round(saveMs), pictureMs: Math.round(pictureMs), elements: current.elements.length, cardsDrawn: cards, svg: bigSvg.outerHTML.length > 10000 };
    large.destroy();
  }
}

run().then(
  () => ((window as unknown as { __result: unknown }).__result = { ok: true, ...results }),
  (e) => ((window as unknown as { __result: unknown }).__result = { ok: false, error: `${e?.message ?? e} | ${String(e?.stack ?? "").split("\n")[0]}`, ...results }),
);
