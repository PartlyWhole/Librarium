#!/usr/bin/env python3
"""Generates the library test fixtures in tests/fixtures/library (deterministic)."""
import struct, zlib, zipfile, os, pathlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "library"
OUT.mkdir(parents=True, exist_ok=True)

WORDS = ("technique society attention grace gravity freedom city reading work propaganda "
         "silence labour nature time image").split()

def pdf(pages, path, height=792, first=None):
    """A minimal PDF with Helvetica text, one content stream per page (pages `height` tall; the
    first page `first` tall if given)."""
    objs = []
    def add(b):
        objs.append(b)
        return len(objs)
    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    pages_id = len(objs) + 1 + 2 * len(pages)  # placeholder index, fixed below
    page_ids = []
    kids = []
    content_ids = []
    heights = [first or height] + [height] * (len(pages) - 1)
    for lines, ht in zip(pages, heights):
        ops = ["BT", "/F1 12 Tf", f"72 {ht - 32} Td", "14 TL"]
        for l in lines:
            esc = l.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            ops.append(f"({esc}) Tj T*")
        ops.append("ET")
        data = "\n".join(ops).encode("latin-1")
        content_ids.append(add(b"<< /Length %d >>\nstream\n" % len(data) + data + b"\nendstream"))
    pages_id = len(objs) + len(pages) + 1
    for c, ht in zip(content_ids, heights):
        page_ids.append(add(b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 612 %d] /Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>" % (pages_id, ht, font, c)))
    kids = b" ".join(b"%d 0 R" % p for p in page_ids)
    assert add(b"<< /Type /Pages /Kids [%s] /Count %d >>" % (kids, len(page_ids))) == pages_id
    catalog = add(b"<< /Type /Catalog /Pages %d 0 R >>" % pages_id)
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, catalog, xref)
    path.write_bytes(bytes(out))

def page_lines(n):
    lines = [f"Page {n}: on {WORDS[n % len(WORDS)]}", ""]
    for k in range(30):
        w = [WORDS[(n * 7 + k * 3 + j) % len(WORDS)] for j in range(9)]
        lines.append(f"Line {k + 1} of page {n} speaks of " + " ".join(w) + ".")
    return lines

pdf([page_lines(n) for n in range(1, 101)], OUT / "text-100.pdf")
pdf([["The Technological Society", "", "Technique integrates everything.", "It avoids shock and sensational events."], ["Second page", "", "Attention is the rarest form of generosity."]], OUT / "short.pdf")
def ocr_pdf(path, truth):
    """Like a scan with recognised text (as JSTOR's): the "printed" words are dark blocks at
    known places (justified lines); over them, each line's recognised text is one invisible
    string (render mode 3) in a face whose widths don't match, about 8% shorter than the print,
    with nothing to say where each word is. Where each printed word is goes to `truth`."""
    import json
    lines = [" ".join(WORDS[(k * 3 + j) % len(WORDS)] for j in range(7 + k % 3)) for k in range(12)]
    ink = ["0 g"]
    text = ["BT", "3 Tr", "/F1 9 Tf"]
    placed = []
    for k, line in enumerate(lines):
        words = line.split()
        y = 700 - k * 16
        widths = [len(w) * 5.1 + (3 if w[0] in "gw" else 0) for w in words]  # a proportional face
        gap = (440 - sum(widths)) / (len(words) - 1)  # justified to 440 pt
        x = 80.0
        for w, wd in zip(words, widths):
            ink.append(f"{x:.3f} {y - 2} {wd:.3f} 8 re f")
            placed.append({"word": w, "line": k, "x": round(x, 3), "w": round(wd, 3), "y": y})
            x += wd + gap
        # The recognised line runs about 8% short of the print (as JSTOR's do), in a face with
        # the wrong proportions (monospaced).
        tz = 0.92 * 440 / (len(line) * 0.6 * 9) * 100
        text.append(f"{tz:.3f} Tz 1 0 0 1 80 {y} Tm ({line}) Tj")
    text.append("ET")
    data = "\n".join(ink + text).encode("latin-1")
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
        b"<< /Length %d >>\nstream\n" % len(data) + data + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offs = []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for o in offs:
        out += b"%010d 00000 n \n" % o
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    path.write_bytes(bytes(out))
    truth.write_text(json.dumps(placed, indent=1))

ocr_pdf(OUT / "ocr-words.pdf", OUT / "ocr-words.json")

# A saved web article: one very tall page, as the page saver prints them.
pdf([["An Article", ""] + [f"Line {k + 1} of the article: " + " ".join(WORDS[(k * 5 + j) % len(WORDS)] for j in range(8)) + "." for k in range(400)]], OUT / "article.pdf", height=6000)

# A journal article as JSTOR saves it: a short cover page before taller pages.
pdf([["Cover page", "", "Downloaded from the archive."]] + [page_lines(n) for n in range(2, 31)], OUT / "cover.pdf", first=300)

def png(path, w, h):
    raw = b"".join(b"\x00" + bytes(((x * 255) // w, (y * 255) // h, 160) for x in range(w) for _ in [0]).replace(b"", b"") if False else b"\x00" + b"".join(bytes(((x * 255) // w, (y * 255) // h, 160)) for x in range(w)) for y in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))

png(OUT / "gradient.png", 320, 200)

def epub(path):
    chapters = [("Chapter One", ["Attention is the rarest and purest form of generosity.", "We read slowly, and quote exactly."]),
                ("Chapter Two", ["Gravity and grace are two forces in the world.", "Technique integrates everything."])]
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
        items = "".join(f'<item id="c{i}" href="text/c{i}.xhtml" media-type="application/xhtml+xml"/>' for i in range(len(chapters)))
        spine = "".join(f'<itemref idref="c{i}"/>' for i in range(len(chapters)))
        z.writestr("OEBPS/content.opf", f'<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:12345678-1234-4234-8234-123456789abc</dc:identifier><dc:title>Notebooks</dc:title><dc:creator>A. Thinker</dc:creator><dc:language>en</dc:language><meta property="dcterms:modified">2026-10-02T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>{items}</manifest><spine>{spine}</spine></package>')
        nav = "".join(f'<li><a href="text/c{i}.xhtml">{t}</a></li>' for i, (t, _) in enumerate(chapters))
        z.writestr("OEBPS/nav.xhtml", f'<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>{nav}</ol></nav></body></html>')
        for i, (t, ps) in enumerate(chapters):
            body = "".join(f"<p>{p}</p>" for p in ps)
            z.writestr(f"OEBPS/text/c{i}.xhtml", f'<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>{t}</title></head><body><h1>{t}</h1>{body}<script>document.title="script ran"</script><img src="missing.png" alt="" onerror="document.title=&quot;handler ran&quot;"/><a href="javascript:void(document.title=&quot;link ran&quot;)">x</a></body></html>')

epub(OUT / "notebooks.epub")

def styled_epub(path):
    """An EPUB 3 with a stylesheet, a font, an image, nested contents, links between chapters,
    a non-linear item and itemref ids (for the Readium streamer)."""
    png_bytes = b"\x89PNG\r\n\x1a\n" + bytes.fromhex("0000000d49484452000000010000000108020000009077" "53de0000000c4944415408d763f8cfc0000003010100c9fe92ef0000000049454e44ae426082")
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
        z.writestr("EPUB/package.opf", '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:22345678-1234-4234-8234-123456789abc</dc:identifier><dc:title>Styled Book</dc:title><dc:creator>A. Writer</dc:creator><dc:language>en</dc:language><meta property="dcterms:modified">2026-10-04T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="css/style.css" media-type="text/css"/><item id="font" href="fonts/f.woff2" media-type="font/woff2"/><item id="pic" href="images/pic.png" media-type="image/png"/><item id="js" href="js/app.js" media-type="text/javascript"/><item id="notes" href="text/notes.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="text/one.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref id="r1" idref="c1"/><itemref id="r-notes" idref="notes" linear="no"/><itemref id="r2" idref="c2"/></spine></package>')
        z.writestr("EPUB/nav.xhtml", '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="landmarks"><ol><li><a href="text/one.xhtml">Start</a></li></ol></nav><nav epub:type="toc"><ol><li><a href="text/one.xhtml">Part One</a><ol><li><a href="text/one.xhtml#s2">A Section</a></li></ol></li><li><a href="text/two.xhtml">Part Two</a></li></ol></nav></body></html>')
        z.writestr("EPUB/css/style.css", '@font-face { font-family: "Book"; src: url("../fonts/f.woff2") format("woff2"); } body { font-family: "Book", serif; } .pic { background: url(../images/pic.png); }')
        z.writestr("EPUB/fonts/f.woff2", b"wOF2-not-really")
        z.writestr("EPUB/images/pic.png", png_bytes)
        z.writestr("EPUB/js/app.js", 'document.title = "book file ran"')
        head = '<head><title>{t}</title><link rel="stylesheet" type="text/css" href="../css/style.css"/><script src="../js/app.js"></script></head>'
        z.writestr("EPUB/text/one.xhtml", '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml">' + head.format(t="Part One") + '<body><h1>Part One</h1><p>Attention is the rarest and purest form of generosity.</p><p><img src="../images/pic.png" alt="A picture"/></p><p class="pic" style="background-image: url(\'../images/pic.png\')">Styled</p><p><a href="two.xhtml#end">On to part two</a></p><h2 id="s2">A Section</h2><p>We read slowly, and quote exactly.</p></body></html>')
        z.writestr("EPUB/text/notes.xhtml", '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Notes</title></head><body><p>A note.</p></body></html>')
        z.writestr("EPUB/text/two.xhtml", '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml">' + head.format(t="Part Two") + '<body><h1>Part Two</h1><p>Gravity and grace are two forces in the world.</p><p id="end">Technique integrates everything.</p></body></html>')

def ncx_epub(path):
    """An EPUB 2: contents in an NCX file, no navigation document."""
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
        z.writestr("content.opf", '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">old-book</dc:identifier><dc:title>Old Book</dc:title><dc:language>en</dc:language></metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="a" href="a.html" media-type="application/xhtml+xml"/></manifest><spine toc="ncx"><itemref idref="a"/></spine></package>')
        z.writestr("toc.ncx", '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap><navPoint id="p1" playOrder="1"><navLabel><text>The Only Chapter</text></navLabel><content src="a.html"/><navPoint id="p2" playOrder="2"><navLabel><text>Within</text></navLabel><content src="a.html#in"/></navPoint></navPoint></navMap></ncx>')
        # Not well-formed XHTML (an unclosed <br>), as old books often are.
        z.writestr("a.html", '<html><head><title>A</title></head><body><p>Old text<br><span id="in">within</span></p></body></html>')

def fixed_epub(path):
    """A fixed-layout EPUB of two pages (600 × 800)."""
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
        z.writestr("OPS/book.opf", '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">fixed-book</dc:identifier><dc:title>Picture Book</dc:title><dc:language>en</dc:language><meta property="rendition:layout">pre-paginated</meta><meta property="dcterms:modified">2026-10-04T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="p1" href="p1.xhtml" media-type="application/xhtml+xml"/><item id="p2" href="p2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="p1" properties="page-spread-right"/><itemref idref="p2" properties="page-spread-left"/></spine></package>')
        z.writestr("OPS/nav.xhtml", '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="p1.xhtml">One</a></li><li><a href="p2.xhtml">Two</a></li></ol></nav></body></html>')
        for i in (1, 2):
            z.writestr(f"OPS/p{i}.xhtml", f'<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Page {i}</title><meta name="viewport" content="width=600, height=800"/></head><body style="margin:0;width:600px;height:800px;background:#eee"><p style="font-size:48px;margin:40px">Page {i} of the picture book.</p></body></html>')

def long_epub(path):
    """Two long chapters (many pages each), with a rare word on several pages (for find)."""
    def chapter(title, marks):
        paras = []
        for i in range(1, 121):
            extra = " The zephyrine light returned." if i in marks else ""
            paras.append(f"<p>Paragraph {i}. " + " ".join(WORDS[(i * 3 + j) % len(WORDS)] for j in range(60)) + f".{extra}</p>")
        return f'<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>{title}</title></head><body><h1>{title}</h1>' + "".join(paras) + '</body></html>'
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
        z.writestr("book.opf", '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">long-book</dc:identifier><dc:title>Long Book</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-10-04T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/><item id="d" href="d.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/><itemref idref="d"/></spine></package>')
        z.writestr("nav.xhtml", '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="c.xhtml">The Long Chapter</a></li><li><a href="d.xhtml">The Second Chapter</a></li></ol></nav></body></html>')
        z.writestr("c.xhtml", chapter("The Long Chapter", (8, 60, 112)))
        z.writestr("d.xhtml", chapter("The Second Chapter", (30, 95)))

def footnotes_epub(path):
    """Footnotes as books mark them (R-065): a note at the end of the same chapter, several pages
    on (`#footnote-1`, with a link back), a note in a separate notes file (`notes.xhtml#n2`, with
    a link back), and one in a non-linear file whose name has a space (`Notes%20B.xhtml#n3`)."""
    def paras(n, tag):
        return "".join(f"<p>{tag} paragraph {i}. " + " ".join(WORDS[(i * 7 + j) % len(WORDS)] for j in range(50)) + ".</p>" for i in range(1, n + 1))
    ch1 = ('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Chapter One</title></head><body><h1>Chapter One</h1>'
           # The number inside the link, as many books have it (a click lands on the <sup>).
           '<p>The first claim<a class="footnote" epub:type="noteref" href="#footnote-1" id="return-footnote-1"><sup class="footnote">[1]</sup></a>, the second<a href="notes.xhtml#n2" id="ref2"><sup>2</sup></a>, and the third<a href="Notes%20B.xhtml#n3" id="ref3">3</a>. See <a href="notes.xhtml#n2" id="see-notes">the notes on this chapter</a>.</p>'
           + paras(60, "Body") +
           '<div class="footnotes"><aside epub:type="footnote" id="footnote-1"><p>1. A note at the end of the chapter. <a href="#return-footnote-1">Back</a></p></aside></div></body></html>')
    notes = ('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Notes</title></head><body><h1>Notes</h1>'
             + paras(40, "Notes") + '<p id="n2">2. The note in the notes file. <a href="ch1.xhtml#ref2">Back</a></p></body></html>')
    # As Either/Or marks its notes: an empty anchor, then the number linking back.
    notes_b = ('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>More notes</title></head><body><h1>More notes</h1>'
               + paras(30, "More") + '<p class="footnote"><a id="n3"/><a href="ch1.xhtml#ref3">3</a>. The note in a file with a space in its name.</p></body></html>')
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
        z.writestr("OEBPS/content.opf", '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">footnotes-book</dc:identifier><dc:title>Footnotes</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-10-05T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="notes" href="Text/notes.xhtml" media-type="application/xhtml+xml"/><item id="notesb" href="Text/Notes%20B.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch1"/><itemref idref="notes"/><itemref idref="notesb" linear="no"/></spine></package>')
        z.writestr("OEBPS/nav.xhtml", '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="Text/ch1.xhtml">Chapter One</a></li><li><a href="Text/notes.xhtml">Notes</a></li><li><a href="Text/Notes%20B.xhtml">More notes</a></li></ol></nav></body></html>')
        z.writestr("OEBPS/Text/ch1.xhtml", ch1)
        z.writestr("OEBPS/Text/notes.xhtml", notes)
        z.writestr("OEBPS/Text/Notes B.xhtml", notes_b)

footnotes_epub(OUT / "footnotes.epub")
styled_epub(OUT / "styled.epub")
fixed_epub(OUT / "fixed.epub")
long_epub(OUT / "long.epub")
ncx_epub(OUT / "old.epub")
print("fixtures written to", OUT)

def jpx_pdf(png_path, path):
    """A PDF holding one JPEG 2000 image (made from a PNG with macOS's sips)."""
    import subprocess, tempfile
    with tempfile.TemporaryDirectory() as d:
        jp2 = pathlib.Path(d) / "img.jp2"
        subprocess.run(["sips", "-s", "format", "jp2", str(png_path), "--out", str(jp2)], check=True, capture_output=True)
        data = jp2.read_bytes()
    w, h = 320, 200
    content = b"q 480 0 0 300 66 300 cm /Im1 Do Q"
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /Filter /JPXDecode /Length %d >>\nstream\n" % (w, h, len(data)) + data + b"\nendstream",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.5\n%\xe2\xe3\xcf\xd3\n")
    offs = []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    x = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offs)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, x)
    path.write_bytes(bytes(out))

if __import__("shutil").which("sips"):
    jpx_pdf(OUT / "gradient.png", OUT / "gradient-jpx.pdf")
