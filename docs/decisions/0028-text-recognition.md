# 0028. Text recognition with Apple Vision

- Status: accepted
- Date: 2026-10-03

## Context and problem

§4.4–§4.5 and §8: recognise text in images and scans with Apple Vision in the worker, store
the results so an index rebuild never re-runs recognition, and make the words findable and
quotable.

## Decision

- **Worker:** `ocr.image` reads an image with Vision (`VNRecognizeTextRequest`, accurate,
  language correction, automatic language). `ocr.pdf` renders the named pages with
  CoreGraphics (about 200 dpi, at most 4,000 px a side) and recognises each. Lines come back
  with their text, confidence and place (fractions of the page, origin top left), top to
  bottom.
- **Port:** a `TextRecognizer` port. The real adapter (`adapters/recognizer-vision`) makes one
  worker call per image or page, within the worker's timeout; the test adapter answers from
  stored results and counts its calls. One shared suite runs against both.
- **When:** the extraction job recognises images, and the pages of a PDF that have fewer than
  16 visible characters of their own text (scans). Results go into `extracted/text-v1.json`
  (lines included, pages marked `recognized`), stamped with the extractor (e.g.
  `pdf-extract 0.12 + apple-vision 1`). Views read only that file.
- **Quotable:** the image and PDF engines lay a transparent, selectable text layer of the
  recognised lines over the image or scanned page, stretched to each line's width. Selecting
  works as with real text, so captures anchor into the recognised text; find searches it too.

## Consequences

Recognition quality is Vision's. A different recogniser (Tesseract) slots in as another
adapter of the same port.
