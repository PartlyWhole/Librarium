//! The page saver: WebKit, through a hidden window of the app (with no IPC permissions).
//!
//! One hidden window is made ahead of time (`warm`) and reused for every page: making a webview
//! brings the app to the front, which mustn't happen on every save. Its data store is in memory
//! and wiped after each page, so saves share nothing.
//!
//! The page is loaded, scrolled through (so lazy pictures load), read in an isolated JavaScript
//! world (clean text and metadata), and printed with `WKWebView.createPDF`. Very tall pages are
//! captured in slices and joined into one PDF with PDFKit. WebKit runs on the main thread; the
//! job thread waits for it a little at a time, so a cancelled save stops at once.

use crate::error::{Code, Error, Result};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{AnyThread, MainThreadMarker};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{NSData, NSDate, NSError, NSString};
use objc2_web_kit::{WKContentWorld, WKPDFConfiguration, WKWebView, WKWebsiteDataStore};
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// A page as saved: its PDF, clean text and metadata, and what the checks look at.
pub struct SavedPage {
    pub final_url: String,
    pub status: Option<u16>,
    pub title: String,
    pub author: Option<String>,
    pub publication: Option<String>,
    pub published: Option<String>,
    pub language: Option<String>,
    /// The main text.
    pub text: String,
    /// Everything shown on the page.
    pub visible_text: String,
    pub html: String,
    pub images: u32,
    /// The share of the page drawn on canvases.
    pub drawn: f64,
    /// It finished loading before it was saved.
    pub complete: bool,
    pub pdf: Vec<u8>,
}

/// One PDF page may be at most 200 inches; slices stay well under.
const SLICE: f64 = 10_000.0;
const WIDTH: f64 = 1024.0;

/// Runs in the page (an isolated world): scrolls, waits for pictures, reads text and metadata.
const EXTRACT: &str = include_str!("extract.js");

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

pub struct Saver {
    app: AppHandle,
    n: AtomicU64,
    /// The reusable window's label; holding the lock means one page at a time.
    window: Mutex<Option<String>>,
    /// Told when the page being saved finishes loading.
    loaded: Arc<Mutex<Option<mpsc::Sender<()>>>>,
    /// Set when the save in progress is cancelled: every wait checks it.
    stop: AtomicBool,
}

fn err(m: impl Into<String>) -> Error {
    Error::io(m)
}

/// Runs in every frame before the page's own scripts: `crypto.subtle` reads as missing, so no
/// page can make or keep a key (and WebKit never asks the keychain). `crypto.getRandomValues`
/// stays.
const HIDE_WEB_CRYPTO: &str = r#"(() => {
  try { Object.defineProperty(Crypto.prototype, "subtle", { get() { return undefined; }, configurable: false }); } catch (e) {}
  try { delete globalThis.SubtleCrypto; } catch (e) {}
})();"#;

impl Saver {
    pub fn new(app: AppHandle) -> Self {
        Saver {
            app,
            n: AtomicU64::new(0),
            window: Mutex::new(None),
            loaded: Arc::default(),
            stop: AtomicBool::new(false),
        }
    }

    /// Makes the hidden window now (at startup, while the app is in front anyway), so the first
    /// save doesn't bring the app forward.
    pub fn warm(&self) {
        let mut slot = self.window.lock().unwrap();
        let _ = self.ensure_window(&mut slot);
    }

    /// The reusable hidden window, made if it doesn't exist (or a page closed it).
    fn ensure_window(&self, slot: &mut Option<String>) -> Result<String> {
        if let Some(label) = slot.as_ref() {
            if self.app.get_webview_window(label).is_some() {
                return Ok(label.clone());
            }
        }
        let label = format!("pagesaver-{}", self.n.fetch_add(1, Ordering::SeqCst));
        let loaded = self.loaded.clone();
        WebviewWindowBuilder::new(&self.app, &label, WebviewUrl::External("about:blank".parse().unwrap()))
            .visible(false)
            .focused(false)
            // An in-memory data store: nothing is kept on disk. It is wiped after every page.
            .incognito(true)
            // Web Crypto is hidden from the pages being saved: a page keeping a key makes WebKit
            // ask the keychain for its "WebCrypto Master Key", and nothing a page keeps here
            // survives anyway.
            .initialization_script_for_all_frames(HIDE_WEB_CRYPTO)
            .inner_size(WIDTH, 900.0)
            .on_page_load(move |_w, p| {
                if p.event() == PageLoadEvent::Finished && p.url().scheme() != "about" {
                    if let Some(tx) = loaded.lock().unwrap().as_ref() {
                        let _ = tx.send(());
                    }
                }
            })
            .build()
            .map_err(|e| err(format!("the page couldn’t be opened: {e}")))?;
        *slot = Some(label.clone());
        Ok(label)
    }

    /// Leaves the page and forgets everything it stored (cookies, storage, caches).
    fn reset(&self, label: &str) {
        // Leaving the page always completes, cancelled or not.
        self.stop.store(false, Ordering::SeqCst);
        *self.loaded.lock().unwrap() = None;
        let Some(w) = self.app.get_webview_window(label) else { return };
        let _ = w.navigate("about:blank".parse().unwrap());
        // Wait until the blank page has really loaded: otherwise its late "finished" could be
        // taken for the next page's.
        let until = Instant::now() + Duration::from_secs(5);
        while Instant::now() < until {
            let settled = self.on_webview(label, Duration::from_secs(2), |wk, _mtm, tx| {
                // SAFETY: a live webview, on the main thread.
                let url =
                    unsafe { wk.URL() }.and_then(|u| u.absoluteString()).map(|s| s.to_string()).unwrap_or_default();
                let _ = tx.send(!unsafe { wk.isLoading() } && url.starts_with("about:"));
            });
            if settled.unwrap_or(true) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.on_webview(label, Duration::from_secs(10), |wk, mtm, tx| {
            // SAFETY: WebKit objects of a live webview, on the main thread.
            unsafe {
                let store = wk.configuration().websiteDataStore();
                let types = WKWebsiteDataStore::allWebsiteDataTypes(mtm);
                let done = block2::RcBlock::new(move || {
                    let _ = tx.send(());
                });
                store.removeDataOfTypes_modifiedSince_completionHandler(&types, &NSDate::distantPast(), &done);
            }
        });
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
        self.recv(&rx, timeout)?.ok_or_else(|| err("the page did not answer in time"))
    }

    /// Waits for an answer, a little at a time, so a cancelled save stops within a moment.
    /// `Ok(None)` when the time is up.
    fn recv<R>(&self, rx: &mpsc::Receiver<R>, timeout: Duration) -> Result<Option<R>> {
        let until = Instant::now() + timeout;
        loop {
            if self.stop.load(Ordering::SeqCst) {
                return Err(Error::new(Code::Cancelled, "Cancelled."));
            }
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Ok(None);
            }
            match rx.recv_timeout(left.min(Duration::from_millis(150))) {
                Ok(r) => return Ok(Some(r)),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(None),
            }
        }
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

    /// Removes popups once more (in the page's script world, where the watcher lives), right
    /// before printing.
    fn sweep(&self, label: &str) {
        let _ = self.on_webview(label, Duration::from_secs(10), |wk, mtm, tx| {
            let world = unsafe { WKContentWorld::defaultClientWorld(mtm) };
            let block = block2::RcBlock::new(move |_res: *mut AnyObject, _error: *mut NSError| {
                let _ = tx.send(());
            });
            unsafe {
                wk.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
                    &NSString::from_str("if (window.__librariumUnpopup) window.__librariumUnpopup(); return 1;"),
                    None,
                    None,
                    &world,
                    Some(&block),
                )
            };
        });
    }

    fn pdf_slice(&self, label: &str, y: f64, w: f64, h: f64, timeout: Duration) -> Result<Vec<u8>> {
        self.sweep(label);
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

impl Saver {
    /// Saves a page within `timeout`, stopping at once when `cancelled` is set.
    pub fn save(&self, url: &str, timeout: Duration, cancelled: &AtomicBool) -> Result<SavedPage> {
        // While saving, the job's cancellation is passed on to the saver's waits.
        let done = AtomicBool::new(false);
        std::thread::scope(|s| {
            s.spawn(|| {
                while !done.load(Ordering::SeqCst) {
                    if cancelled.load(Ordering::SeqCst) {
                        self.stop.store(true, Ordering::SeqCst);
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            });
            let r = self.save_page(url, timeout);
            done.store(true, Ordering::SeqCst);
            self.stop.store(false, Ordering::SeqCst);
            r
        })
    }

    fn save_page(&self, url: &str, timeout: Duration) -> Result<SavedPage> {
        let mut slot = self.window.lock().unwrap();
        let parsed: tauri::Url = url.parse().map_err(|_| Error::invalid(format!("not a web address: {url}")))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(Error::invalid("Only http and https pages can be saved."));
        }
        let label = self.ensure_window(&mut slot)?;
        let window = self.app.get_webview_window(&label).ok_or_else(|| err("the page's window closed"))?;
        let (tx, rx) = mpsc::channel();
        *self.loaded.lock().unwrap() = Some(tx);
        let started = Instant::now();
        window.navigate(parsed).map_err(|e| err(format!("the page couldn’t be opened: {e}")))?;
        let close = || self.reset(&label);
        // Wait for the load to finish, but not forever: some pages never stop loading (ads keep
        // coming). Then save what is there, and say so; most of the time goes to reading and
        // printing it.
        let complete = match self.recv(&rx, timeout.mul_f64(0.4)) {
            Ok(r) => r.is_some(),
            Err(e) => {
                close();
                return Err(e);
            }
        };
        let loaded = started.elapsed();
        let left = timeout.saturating_sub(loaded).max(Duration::from_secs(20));
        let result = self.extract(&label, left).and_then(|x| {
            let read = started.elapsed();
            if !complete && x.visible_text.split_whitespace().count() < 20 {
                return Err(err(format!("the page didn’t finish loading in {} s", timeout.as_secs())));
            }
            let pdf = self.pdf(
                &label,
                x.width.min(WIDTH * 2.0),
                x.height,
                timeout.saturating_sub(read).max(Duration::from_secs(20)),
            )?;
            log::info!(
                "saved {url}: loaded {} in {:.1} s, read in {:.1} s, printed {:.0} pt in {:.1} s",
                if complete { "fully" } else { "partly" },
                loaded.as_secs_f64(),
                (read - loaded).as_secs_f64(),
                x.height,
                (started.elapsed() - read).as_secs_f64()
            );
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
        if let Err(e) = &result {
            log::warn!(
                "couldn’t save {url} after {:.1} s (loaded {}: {:.1} s): {}",
                started.elapsed().as_secs_f64(),
                if complete { "fully" } else { "partly" },
                loaded.as_secs_f64(),
                e.message
            );
        }
        close();
        result
    }
}
