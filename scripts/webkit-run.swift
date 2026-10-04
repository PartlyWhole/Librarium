// Loads a page in an offscreen WKWebView (the engine the app uses) and prints
// `window.__result` as JSON once the page sets it. Usage: swift webkit-run.swift URL SECONDS
// (with SNAPSHOT=file.png in the environment, it also saves a picture of the page then)
import AppKit
import WebKit

let args = CommandLine.arguments
guard args.count >= 3, let url = URL(string: args[1]), let timeout = Double(args[2]) else {
    FileHandle.standardError.write("usage: webkit-run URL SECONDS\n".data(using: .utf8)!)
    exit(2)
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
// On screen but almost transparent: WebKit pauses animation frames for hidden windows, and
// PDF.js paces rendering with them.
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 1100), styleMask: [.borderless], backing: .buffered, defer: false)
window.alphaValue = 0.02
window.ignoresMouseEvents = true
final class Nav: NSObject, WKNavigationDelegate {
    func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { FileHandle.standardError.write("navigation failed: \(e)\n".data(using: .utf8)!) }
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { FileHandle.standardError.write("load failed: \(e)\n".data(using: .utf8)!) }
}
let nav = Nav()
let web = WKWebView(frame: window.contentView!.bounds, configuration: WKWebViewConfiguration())
web.navigationDelegate = nav
window.contentView!.addSubview(web)
window.orderFrontRegardless()
web.load(URLRequest(url: url))

let start = Date()
Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in
    web.evaluateJavaScript("window.__result ? JSON.stringify(window.__result) : ('pending:' + document.readyState + ':' + document.title)") { value, error in
        if let s = value as? String, !s.hasPrefix("pending:") {
            print(s)
            // With SNAPSHOT=path, saves what the page shows (for looking at a layout by eye).
            if let path = ProcessInfo.processInfo.environment["SNAPSHOT"] {
                web.takeSnapshot(with: nil) { image, _ in
                    if let image = image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
                        try? png.write(to: URL(fileURLWithPath: path))
                    }
                    exit(0)
                }
                return
            }
            exit(0)
        }
        if Date().timeIntervalSince(start) > timeout {
            let state = (value as? String) ?? "no value (\(String(describing: error)))"
            print("{\"ok\":false,\"error\":\"timed out; page \(state)\"}")
            exit(1)
        }
    }
}
app.run()
