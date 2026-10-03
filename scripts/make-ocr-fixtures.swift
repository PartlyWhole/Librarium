// Draws the text-recognition fixtures: an image of words, and a scanned PDF (the same page
// as an image only, with no text layer). Run: swift scripts/make-ocr-fixtures.swift
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "tests/fixtures/library")
let lines = [
    "Gravity and grace are two forces.",
    "Attention is the rarest form of generosity.",
    "We read slowly and quote exactly.",
]
let size = NSSize(width: 1400, height: 520)

func drawPage() -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width), pixelsHigh: Int(size.height), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSColor.white.setFill()
    NSRect(origin: .zero, size: size).fill()
    let attrs: [NSAttributedString.Key: Any] = [.font: NSFont(name: "Georgia", size: 56) ?? NSFont.systemFont(ofSize: 56), .foregroundColor: NSColor.black]
    for (i, l) in lines.enumerated() {
        (l as NSString).draw(at: NSPoint(x: 60, y: size.height - 140 - CGFloat(i) * 130), withAttributes: attrs)
    }
    NSGraphicsContext.restoreGraphicsState()
    return rep
}

let rep = drawPage()
try! rep.representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent("words.png"))

// An image-only PDF: the page is one picture, as a scanner makes it.
var box = CGRect(x: 0, y: 0, width: 612, height: 612 * size.height / size.width)
let pdfData = NSMutableData()
let consumer = CGDataConsumer(data: pdfData as CFMutableData)!
let ctx = CGContext(consumer: consumer, mediaBox: &box, nil)!
ctx.beginPDFPage(nil)
ctx.draw(rep.cgImage!, in: box)
ctx.endPDFPage()
ctx.closePDF()
try! (pdfData as Data).write(to: out.appendingPathComponent("scan.pdf"))
print("wrote words.png and scan.pdf")
