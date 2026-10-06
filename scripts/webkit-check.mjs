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
  ["PDF: showing a capture goes straight to where it was drawn and brings out its lines (no frame)", r.pdfPlaceByBoxes === true && r.pdfPlaceByBoxesAt?.page === "42" && r.pdfPlaceByBoxesAt?.visible === true && r.pdfPlaceByBoxesAt.lines === 2 && r.pdfPlaceByBoxesAt.framed === false],
  ["PDF: a capture saved with a box per word is drawn as one highlight per line", r.pdfSavedLines === 2],
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
  ["EPUB: larger text keeps the page's margins and columns (fewer words a line, as in Books)", Array.isArray(r.epubMargins) && r.epubMargins[0]?.pad === 56 && Math.abs(r.epubMargins[1]?.pad - 56) <= 2 && r.epubMargins[0].cols === r.epubMargins[1].cols && Math.abs(r.epubMargins[0].text - r.epubMargins[1].text) <= 24],
  ["EPUB: the dark theme applies and the setting is kept", r.epubDark === "rgb(28, 28, 30)" && r.epubSettingsSaved === "night"],
  ["EPUB says how many pages are left in the chapter", /page/i.test(r.epubPagesLeft)],
  ["EPUB: the place in the book is remembered", /^Chapter Two/.test(r.epubReopenedAt)],
  ["EPUB: find goes to the page each match is on (across chapters), and highlights it there", r.epubLongFind?.count === 5 && r.epubLongFind.visible.length === 5 && r.epubLongFind.visible.every((v) => v === true)],
  ["EPUB: at a larger text size, find still goes to the page each match is on", Array.isArray(r.epubZoomedFind) && r.epubZoomedFind.length === 5 && r.epubZoomedFind.every((v) => v === true)],
  ["EPUB: at a larger text size, showing a capture goes to its page", !!r.epubZoomedShow?.cfi && r.epubZoomedShow.onPage === true],
  ["EPUB: opened at a place with a saved text size, it shows that place", r.epubOpenedAtPlace?.onPage === true],
  ["EPUB: a click on the page doesn't turn it", r.epubClickTurned === false],
  ["EPUB: in a wide window the page is centred", Math.abs(r.epubCentred?.offset ?? 99) <= 2],
  ["EPUB: a fixed-layout book opens on its first page", /^Page 1 of 2/.test(r.epubFixedAt) && r.epubFixedFrames >= 1],
  ["EPUB: images and stylesheets load from the book; its script files never run", r.epubImage === true && r.epubStylesheet === true && r.epubBookFileRan === false],
  ["Show in a PDF with a different-sized first page stays on the place", r.pdfCoverShow?.page === "20" && r.pdfCoverShow.inView === true],
  ["a scan's recognised text lies on the words seen (each word within 1.5 pt)", r.pdfScanInk?.words > 50 && r.pdfScanInk.close === r.pdfScanInk.words],
  ["editing a saved article (PDF): handles at the passage's ends", r.editPdfHandles === true && /^Line 3 of/.test(r.editPdfSelected ?? "")],
  ["editing a saved article: dragging the end handle down a line takes in that line", !!r.editPdfEnd && r.editPdfEnd.boxes >= 2 && r.editPdfEnd.text.length > (r.editPdfSelected ?? "").length && /Line 4/.test(r.editPdfEnd.text)],
  ["editing a saved article: dragging the start handle forward drops the first word, snapping to words", !!r.editPdfStart && !/^Line 3/.test(r.editPdfStart) && /^\S+/.test(r.editPdfStart) && r.editPdfStopped === true],
  ["editing a saved article: dragged to the bottom edge, it scrolls and the passage carries on", (r.editPdfScroll?.scrolled ?? 0) > 100 && (r.editPdfScroll?.length ?? 0) > 300 && r.editPdfScroll.starts === "Line "],
  ["editing a region: resizing by its corner takes its picture again", r.editPdfRegion?.grew === true && r.editPdfRegion.png === true],
  ["editing a region: the place's old outline goes, and the region stays as resized when pages render again", r.editPdfRegion?.outlinedBefore >= 1 && r.editPdfRegion.outlinedWhileEditing === 0 && r.editPdfRegion.keptAfterRender === true],
  ["editing an EPUB passage: dragging its end takes in more text, with a new CFI", !!r.editEpub?.after && r.editEpub.after.length > r.editEpub.before.length && r.editEpub.cfiChanged === true],
  ["editing an EPUB passage at a larger text size works the same", !!r.editEpubZoomed?.after && r.editEpubZoomed.after.length > r.editEpubZoomed.before.length && r.editEpubZoomed.cfiChanged === true],
  ["editing an EPUB passage: held at the book's edge, the page turns and the passage carries on there", r.epubTurnArmed === true && r.epubDragTurn?.start === "Paragraph 2." && r.epubDragTurn.length > 1500 && r.epubDragTurn.after !== r.epubDragTurn.before && r.epubDragTurn.armedOff === true],
  ["the same across a page turn at a larger text size", r.epubTurnArmedZoomed === true && r.epubDragTurnZoomed?.start === "Paragraph 2." && r.epubDragTurnZoomed.length > 1000 && r.epubDragTurnZoomed.after !== r.epubDragTurnZoomed.before],
  ["EPUB: a trackpad swipe turns one page (its momentum doesn't turn more), with an animation", r.epubSwipe?.afterOne === r.epubSwipe?.start - 1 && r.epubSwipe.sawAnimation === true],
  ["EPUB: a new swipe within the last one's momentum turns again", r.epubSwipe?.afterTwo === r.epubSwipe?.start - 2],
  ["EPUB: a swipe whose momentum has bumps in it still turns one page", r.epubSwipe?.afterBumpy === r.epubSwipe?.start - 3],
  ["EPUB: a sideways swipe doesn't scroll the columns itself", r.epubSwipe?.prevented === r.epubSwipe?.events],
  ["a picture in a book, clicked, is selected to capture as an image", r.epubPicture?.image === true && r.epubPicture.text === "" && r.epubPicture.cfi === true],
  ["image opens and zooms", r.imagePainted === true && r.imageZoomed === true],
  ["a region of an image is captured", r.imageRegion === true],
  ["EPUB footnotes: clicked as a hand does (a real click, the pointer moving 3 pixels)", r.epubFootnotes?.native === true],
  ["EPUB footnotes: a drag starting on a note's number selects text, and doesn't follow the link", r.epubFootnotes?.dragStays === true],
  ["EPUB footnotes: a note's number shows the note in a popover (its link back left out), and the page stays", r.epubFootnotes?.start?.ref1 === true && r.epubFootnotes.start.note1 === false && r.epubFootnotes.pop1?.text?.trim() === "1. A note at the end of the chapter." && r.epubFootnotes.pop1.stays === true],
  ["EPUB footnotes: the popover's Go to note goes to it (several pages on); the note's link back returns", r.epubFootnotes?.goneTo1 === true && r.epubFootnotes.backShown === true],
  ["EPUB footnotes: a note in a separate notes file shows in the popover, which Escape closes", r.epubFootnotes?.pop2?.trim() === "2. The note in the notes file." && r.epubFootnotes.closed === true],
  ["EPUB footnotes: a note marked by an empty anchor, in a non-linear file with a space in its name, shows without its number", r.epubFootnotes?.pop3?.trim() === "The note in a file with a space in its name."],
  ["EPUB footnotes: a link that isn't a note's number goes to its place; the link back returns", r.epubFootnotes?.otherFile === true && r.epubFootnotes.backFromNotes === true],
  ["Board: a drawing loaded from disk is neither a change nor an undo step", r.board?.afterLoad?.changes === 0 && r.board.afterLoad.steps === 0 && r.board.afterLoad.elements === 1],
  ["Board: typing a text is a change and one undo step; the drawing saves in Excalidraw's format", r.board?.editor === true && r.board.typed.texts?.[0] === "Technique" && r.board.typed.steps === 1 && r.board.typed.changes > 0 && r.board.savedType === "excalidraw"],
  ["Board: ⌘Z undoes that step (not a new step), ⇧⌘Z redoes it", r.board?.undone?.texts === 0 && r.board.undone.steps === 1 && r.board.redone === 1],
  ["Board: the look follows the app (dark), and nothing goes to the network", r.board?.dark === true && r.board.external?.length === 0],
  ["Board: [[ typed in a text reaches the page (the text is finished, to be linked)", r.boardLinks?.started === true && r.boardLinks.editorClosed === true],
  ["Board: a capture put on the board is a card showing the app's own DOM, linked to the capture", r.boardCards?.card === "Card 0192f3a4-7c1e-7b2a-9f00-0000000000aa" && r.boardCards.cardLink === "librarium://record/0192f3a4-7c1e-7b2a-9f00-0000000000aa" && r.boardCards.cardEmbed === true],
  ["Board: a picture goes on by its library ID; the drawing saved keeps the ID, not the picture's data", r.boardCards?.pictureId === "0192f3a4-7c1e-7b2a-9f00-0000000000bb" && r.boardCards.pictureLink === "librarium://record/0192f3a4-7c1e-7b2a-9f00-0000000000bb" && r.boardCards.pictureDataSaved === false],
  ["Board: drawn as a picture (for notes and export), its cards' words and its pictures show; PNG too", r.boardExport?.svgText === true && r.boardExport.svgPicture === true && r.boardExport.png === true],
  ["Board: exported as an Excalidraw file that reads anywhere: cards written out, pictures inside", r.boardExport?.fileEmbeds === 0 && r.boardExport.fileCardText === true && r.boardExport.filePicture === true],
  [`Board, large (380 elements): opens in under 1 s (${r.boardLarge?.openMs} ms), its drawing is read for saving in under 100 ms (${r.boardLarge?.saveMs} ms), drawn as a picture in under 3 s (${r.boardLarge?.pictureMs} ms)`, r.boardLarge?.elements === 380 && r.boardLarge.openMs < 1000 && r.boardLarge.saveMs < 100 && r.boardLarge.pictureMs < 3000 && r.boardLarge.svg === true],
  ["Board: linking replaces [[ with the name, measures the text again, and the record's ID is saved with it", r.boardLinks?.linked === true && r.boardLinks.text === "See Jacques Ellul" && r.boardLinks.wider === true && r.boardLinks.link === "librarium://record/0192f3a4-7c1e-7b2a-9f00-000000000099" && r.boardLinks.kept?.includes("Jacques Ellul")],
  ["recognised words in an image can be found", r.ocrImageLines === 3 && r.ocrImageFind?.count === 1],
  ["recognised words in an image can be selected (and so captured)", r.ocrImageSelection === "Gravity and grace are two forces."],
  ["editing on an image: a recognised passage's start dragged forward; a region resized with its picture taken again", r.ocrImageHandles === true && !!r.ocrImageEdited?.text && r.ocrImageEdited.text !== "Gravity and grace are two forces." && r.ocrImageEdited.text.length < "Gravity and grace are two forces.".length && r.ocrImageEdited.region === true],
  ["recognised words on a scanned page can be found", r.ocrScanLines === 3 && r.ocrScanFind?.count >= 1],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
