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

async function open(engine: ReaderEngine, name: string, format: string) {
  stage.replaceChildren();
  let firstPaint = -1;
  let painted!: () => void;
  const paint = new Promise<void>((r) => (painted = r));
  const src: ReaderSource = { id: name, format, title: name, bytes: () => fixture(name), text: async () => null };
  const view = await engine.open(stage, src, { moved() {}, firstPaint: (ms) => ((firstPaint = ms), painted()) });
  await Promise.race([paint, new Promise((r) => setTimeout(r, 10_000))]);
  return { view, firstPaint };
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
  results.epubScriptRan = docs.some((d: Document) => d.title === "script ran");
  step("epub find");
  results.epubFind = await epub.view.find("generosity");
  epub.view.zoomIn();
  epub.view.destroy();

  // Image: opens and zooms.
  step("image");
  const img = await open(imageEngine, "gradient.png", "image");
  results.imagePainted = img.firstPaint >= 0;
  results.imagePosition = img.view.position();
  img.view.zoomIn();
  results.imageZoomed = (stage.querySelector("img") as HTMLImageElement).style.width !== "";
  img.view.destroy();
}

run().then(
  () => ((window as unknown as { __result: unknown }).__result = { ok: true, ...results }),
  (e) => ((window as unknown as { __result: unknown }).__result = { ok: false, error: `${e?.message ?? e} | ${String(e?.stack ?? "").split("\n")[0]}`, ...results }),
);
