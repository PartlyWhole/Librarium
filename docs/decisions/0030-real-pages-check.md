# 0030. What the real-pages check changed

- Status: accepted
- Date: 2026-10-03

## Context and problem

The milestone 7 acceptance check saves real pages and confirms that the text and images
visible in the webview appear in the PDF. The user supplied a list of 315 pages. For the
check we used 10 of them, chosen to cover the kinds in the list: a WordPress blog, a Substack
post, a Substack note, the New Yorker, Aeon, a very long essay, a plain static page, a Google
Doc, First Things and Scientific American. On the first run all 10 failed, although the local
fixture pages had passed.

## Findings and decisions

- **PDF text came from the wrong reader.** pdf-extract read nothing from many PDFs that
  WebKit makes, and it would fail the same way on imported PDFs: those would be sent to text
  recognition as if they were scans. The worker now reads PDF text with PDFKit (stamped
  `pdfkit`) and keeps pdf-extract only for files PDFKit can't open.
- **Images were miscounted.** WebKit puts images inside form XObjects. `pdf.info` now
  follows those and counts each image once.
- **Page saving used the browser's normal stored data.** That kept cookies between saves,
  and on pages that use WebCrypto it made WebKit ask the login keychain for a key. The user
  saw a password prompt, and the save stalled until it timed out. Every save now uses a
  fresh, in-memory data store (`incognito`).
- **Soft hyphens split words** in stored page text (for example "aban-don"), which would
  break search and quoting. The page script removes soft hyphens and zero-width characters.
- **Pages drawn on a canvas** (Google Docs) have no text to keep. The saver measures the
  share of the page drawn on canvases, and a new check, `drawn`, says so and suggests adding
  the exported file instead.
- **Some pages never finish loading** (ads and trackers keep going). After 60% of the time
  limit the saver keeps what is there and flags it `incomplete`. A page with almost no text
  still fails.
- **The checks raised false alarms on full articles.** A captcha script (for comment forms)
  or subscriber metadata alone no longer marks a page. They count only when the article
  itself is short, as a challenge page or a teaser is.

## Result

All 10 pass: 93–100% of the visible text is in each PDF, images are present, and the only
page flagged is the Google Doc (`drawn`). Fixture tests cover the canvas page, soft hyphens,
an incomplete load, and a full article with a captcha script and subscriber metadata.
