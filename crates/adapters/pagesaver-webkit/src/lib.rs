//! PageSaver port: WebKit through the system webview. WebKit isolates page content in its own
//! processes, so saving runs through a hidden window of the app (with no IPC permissions).
//!
//! The page is loaded, scrolled through (so lazy images load), read in an isolated JavaScript
//! world (clean text and metadata), and printed with `WKWebView.createPDF` (macOS 11+). Very
//! tall pages are captured in slices and joined into one PDF with PDFKit.

use librarium_contracts::ports::{PageSaver, SavedPage};
use librarium_contracts::{BackendError, Result};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{AnyThread, MainThreadMarker};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{NSData, NSError, NSString};
use objc2_web_kit::{WKContentWorld, WKPDFConfiguration, WKWebView};
use serde::Deserialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// One PDF page may be at most 200 inches; slices stay well under.
const SLICE: f64 = 10_000.0;
const WIDTH: f64 = 1024.0;

/// Runs in the page (an isolated world): scrolls, waits for images, reads text and metadata.
const EXTRACT: &str = r#"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Hidden windows stretch timers to about a second, so pass the page through without them:
// a message-channel yield lets layout and lazy loaders run between scroll steps.
const yieldTask = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
const frame = () => new Promise((r) => { let done = false; requestAnimationFrame(() => { if (!done) { done = true; r(); } }); setTimeout(() => { if (!done) { done = true; r(); } }, 50); });
const H = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
const eager = () => document.querySelectorAll("img[loading=lazy], iframe[loading=lazy]").forEach((i) => { i.loading = "eager"; });
eager();
for (let y = 0; y < H() && y < 60000; y += Math.max(400, innerHeight * 2)) { scrollTo(0, y); for (let k = 0; k < 3; k++) await yieldTask(); }
scrollTo(0, H());
await frame();
eager();
scrollTo(0, 0);
await sleep(300);
await Promise.race([Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.addEventListener("load", r); i.addEventListener("error", r); }))), sleep(3000)]);
const meta = (sel) => document.querySelector(sel)?.getAttribute("content") || null;
const main = document.querySelector("article") || document.querySelector("main") || document.querySelector("[role=main]") || document.body;
// Soft hyphens and zero-width characters would split words in the stored text.
const tidy = (s) => s.replace(/[\u00AD\u200B\u200C\u200D\u2060\uFEFF]/g, "");
const clean = (el) => {
  if (!el) return "";
  const c = el.cloneNode(true);
  c.querySelectorAll("script,style,noscript,nav,footer,aside,form,iframe,svg,button,[aria-hidden=true]").forEach((n) => n.remove());
  return tidy(c.innerText || c.textContent || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
};
const nav = performance.getEntriesByType("navigation")[0];
const shown = (img) => { const r = img.getBoundingClientRect(); return img.naturalWidth > 32 && img.naturalHeight > 32 && r.width > 32 && r.height > 32 && getComputedStyle(img).visibility !== "hidden"; };
return JSON.stringify({
  final_url: location.href,
  status: nav && nav.responseStatus ? nav.responseStatus : null,
  title: document.title || "",
  author: meta('meta[name="author"]') || meta('meta[property="article:author"]'),
  publication: meta('meta[property="og:site_name"]') || meta('meta[name="application-name"]'),
  published: meta('meta[property="article:published_time"]') || meta('meta[name="date"]') || document.querySelector("time[datetime]")?.getAttribute("datetime") || null,
  language: document.documentElement.lang || null,
  text: clean(main),
  visible_text: tidy(document.body ? document.body.innerText : "").trim(),
  html: document.documentElement.outerHTML.slice(0, 2000000),
  images: [...document.images].filter(shown).length,
  drawn: Math.min(1, [...document.querySelectorAll("canvas")].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 100 && r.height > 100).reduce((a, r) => a + r.width * r.height, 0) / Math.max(1, Math.max(document.documentElement.scrollWidth, innerWidth) * Math.min(H(), Math.max(innerHeight, 1) * 3))),
  width: Math.max(document.documentElement.scrollWidth, innerWidth),
  height: H(),
});
"#;

#[derive(Deserialize)]
struct Extracted {
    final_url: String,
    status: Option<u16>,
    title: String,
    author: Option<String>,
    publication: Option<String>,
    published: Option<String>,
    language: Option<String>,
    text: String,
    visible_text: String,
    html: String,
    images: u32,
    drawn: f64,
    width: f64,
    height: f64,
}

pub struct WebKitPageSaver {
    app: AppHandle,
    n: AtomicU64,
    one_at_a_time: Mutex<()>,
}

fn err(m: impl Into<String>) -> BackendError {
    BackendError::io(m)
}

impl WebKitPageSaver {
    pub fn new(app: AppHandle) -> Self {
        WebKitPageSaver { app, n: AtomicU64::new(0), one_at_a_time: Mutex::new(()) }
    }

    fn on_webview<R: Send + 'static>(
        &self,
        label: &str,
        timeout: Duration,
        f: impl FnOnce(&WKWebView, MainThreadMarker, mpsc::Sender<R>) + Send + 'static,
    ) -> Result<R> {
        let w = self.app.get_webview_window(label).ok_or_else(|| err("the page's window closed"))?;
        let (tx, rx) = mpsc::channel();
        w.with_webview(move |pw| {
            let mtm = MainThreadMarker::new().expect("webview callbacks run on the main thread");
            // SAFETY: on macOS, `inner()` is the WKWebView, alive while the window is.
            let wk: &WKWebView = unsafe { &*(pw.inner() as *const WKWebView) };
            f(wk, mtm, tx);
        })
        .map_err(|e| err(e.to_string()))?;
        rx.recv_timeout(timeout).map_err(|_| err("the page did not answer in time"))
    }

    fn extract(&self, label: &str, timeout: Duration) -> Result<Extracted> {
        let json: std::result::Result<String, String> = self.on_webview(label, timeout, |wk, mtm, tx| {
            let world = unsafe { WKContentWorld::defaultClientWorld(mtm) };
            let block = block2::RcBlock::new(move |res: *mut AnyObject, error: *mut NSError| {
                let out = if !error.is_null() {
                    // SAFETY: a non-null NSError from WebKit.
                    Err(unsafe { &*error }.localizedDescription().to_string())
                } else if res.is_null() {
                    Err("the page returned nothing".into())
                } else {
                    // SAFETY: the script returns a string, bridged to NSString.
                    Ok(unsafe { &*(res as *const NSString) }.to_string())
                };
                let _ = tx.send(out);
            });
            unsafe {
                wk.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
                    &NSString::from_str(EXTRACT),
                    None,
                    None,
                    &world,
                    Some(&block),
                )
            };
        })?;
        let json = json.map_err(|e| err(format!("the page couldn’t be read: {e}")))?;
        serde_json::from_str(&json).map_err(|e| err(format!("the page couldn’t be read: {e}")))
    }

    fn pdf_slice(&self, label: &str, y: f64, w: f64, h: f64, timeout: Duration) -> Result<Vec<u8>> {
        let r: std::result::Result<Vec<u8>, String> = self.on_webview(label, timeout, move |wk, mtm, tx| {
            let config = unsafe { WKPDFConfiguration::new(mtm) };
            unsafe { config.setRect(CGRect { origin: CGPoint { x: 0.0, y }, size: CGSize { width: w, height: h } }) };
            let block = block2::RcBlock::new(move |data: *mut NSData, error: *mut NSError| {
                let out = if data.is_null() {
                    Err(if error.is_null() {
                        "no PDF".to_string()
                    } else {
                        unsafe { &*error }.localizedDescription().to_string()
                    })
                } else {
                    Ok(unsafe { &*data }.to_vec())
                };
                let _ = tx.send(out);
            });
            unsafe { wk.createPDFWithConfiguration_completionHandler(Some(&config), &block) };
        })?;
        r.map_err(|e| err(format!("the PDF couldn’t be made: {e}")))
    }

    fn pdf(&self, label: &str, width: f64, height: f64, timeout: Duration) -> Result<Vec<u8>> {
        let height = height.max(1.0);
        if height <= SLICE * 1.4 {
            return self.pdf_slice(label, 0.0, width, height, timeout);
        }
        let mut slices = vec![];
        let mut y = 0.0;
        while y < height {
            let h = (height - y).min(SLICE);
            slices.push(self.pdf_slice(label, y, width, h, timeout)?);
            y += h;
        }
        join_pdfs(&slices)
    }
}

/// Joins PDFs (one page each) into one, with PDFKit.
fn join_pdfs(parts: &[Vec<u8>]) -> Result<Vec<u8>> {
    use objc2_pdf_kit::PDFDocument;
    let doc = |b: &[u8]| -> Result<Retained<PDFDocument>> {
        unsafe { PDFDocument::initWithData(PDFDocument::alloc(), &NSData::with_bytes(b)) }
            .ok_or_else(|| err("a PDF slice couldn’t be read"))
    };
    let first = doc(&parts[0])?;
    for p in &parts[1..] {
        let d = doc(p)?;
        for i in 0..unsafe { d.pageCount() } {
            if let Some(page) = unsafe { d.pageAtIndex(i) } {
                unsafe { first.insertPage_atIndex(&page, first.pageCount()) };
            }
        }
    }
    unsafe { first.dataRepresentation() }.map(|d| d.to_vec()).ok_or_else(|| err("the joined PDF couldn’t be written"))
}

impl PageSaver for WebKitPageSaver {
    fn save(&self, url: &str, timeout: Duration) -> Result<SavedPage> {
        let _one = self.one_at_a_time.lock().unwrap();
        let parsed: tauri::Url = url.parse().map_err(|_| BackendError::invalid(format!("not a web address: {url}")))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(BackendError::invalid("only http and https pages can be saved"));
        }
        let label = format!("pagesaver-{}", self.n.fetch_add(1, Ordering::SeqCst));
        let (tx, rx) = mpsc::channel();
        let started = Instant::now();
        let window = WebviewWindowBuilder::new(&self.app, &label, WebviewUrl::External(parsed))
            .visible(false)
            // A fresh, in-memory data store for every page: no cookies or storage carried
            // between saves, and WebKit never asks the keychain for its WebCrypto key.
            .incognito(true)
            .inner_size(WIDTH, 900.0)
            .on_page_load(move |_w, p| {
                if p.event() == PageLoadEvent::Finished {
                    let _ = tx.send(());
                }
            })
            .build()
            .map_err(|e| err(format!("the page couldn’t be opened: {e}")))?;
        let close = || {
            let _ = window.destroy();
        };
        // Wait for the load to finish, but not forever: some pages never stop loading.
        // Then save what is there, and say so.
        let complete = rx.recv_timeout(timeout.mul_f64(0.6)).is_ok();
        let left = timeout.saturating_sub(started.elapsed()).max(Duration::from_secs(20));
        let result = self.extract(&label, left).and_then(|x| {
            if !complete && x.visible_text.split_whitespace().count() < 20 {
                return Err(err(format!("the page didn’t finish loading in {} s", timeout.as_secs())));
            }
            let pdf = self.pdf(&label, x.width.min(WIDTH * 2.0), x.height, left)?;
            Ok(SavedPage {
                final_url: x.final_url,
                status: x.status,
                title: x.title,
                author: x.author,
                publication: x.publication,
                published: x.published,
                language: x.language,
                text: x.text,
                visible_text: x.visible_text,
                html: x.html,
                images: x.images,
                drawn: x.drawn,
                complete,
                pdf,
            })
        });
        close();
        result
    }
}
