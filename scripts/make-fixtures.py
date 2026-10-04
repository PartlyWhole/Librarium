#!/usr/bin/env python3
"""Generates the library test fixtures in tests/fixtures/library (deterministic)."""
import struct, zlib, zipfile, os, pathlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "library"
OUT.mkdir(parents=True, exist_ok=True)

WORDS = ("technique society attention grace gravity freedom city reading work propaganda "
         "silence labour nature time image").split()

def pdf(pages, path):
    """A minimal PDF with Helvetica text, one content stream per page."""
    objs = []
    def add(b):
        objs.append(b)
        return len(objs)
    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    pages_id = len(objs) + 1 + 2 * len(pages)  # placeholder index, fixed below
    page_ids = []
    kids = []
    content_ids = []
    for lines in pages:
        ops = ["BT", "/F1 12 Tf", "72 760 Td", "14 TL"]
        for l in lines:
            esc = l.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            ops.append(f"({esc}) Tj T*")
        ops.append("ET")
        data = "\n".join(ops).encode("latin-1")
        content_ids.append(add(b"<< /Length %d >>\nstream\n" % len(data) + data + b"\nendstream"))
    pages_id = len(objs) + len(pages) + 1
    for c in content_ids:
        page_ids.append(add(b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>" % (pages_id, font, c)))
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
