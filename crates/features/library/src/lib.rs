//! Library: saved web pages, PDFs, images and EPUBs, each a folder with `record.json`.
//!
//! - Importing stages the untouched original (and its record) in Application Support, then
//!   moves the folder in with one rename. `record.json` holds the original's sha256 and its
//!   provenance.
//! - Text is extracted in the worker (`library.extract`, a resumable job) and stored in
//!   `extracted/text-v1.json`, stamped with the extractor's version, so rebuilding the index
//!   never re-runs extraction (or, later, recognition).

pub mod checks;
pub mod snapshots;

use librarium_contracts::api::Written;
use librarium_contracts::{BackendError, ErrorCode, Id, Result};
use librarium_kernel::frontmatter::FmValue;
use librarium_kernel::jobs::{JobCtx, JobKind};
use librarium_kernel::kinds::{Format, Kinds, RecordKindDef};
use librarium_kernel::methods::{ApiMethod, MethodCtx};
use librarium_kernel::registry::{DuplicateId, Registry};
use librarium_kernel::store::{Entry, Store};
use librarium_kernel::writer::Lane;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub const ID: &str = "library";
pub const KIND: &str = "item";
pub const FORMAT: &str = "library.format";
pub const ORIGINAL: &str = "library.original";
pub const TEXT: &str = "library.text";
pub const PAGES: &str = "library.pages";
pub const TEXT_FILE: &str = "extracted/text-v1.json";
/// The latest snapshot of a saved web page (its folder name under `snapshots/`).
pub const SNAPSHOT: &str = "library.snapshot";
/// Every snapshot: `[{at, sha256, final-url, status, checks}]`.
pub const SNAPSHOTS: &str = "library.snapshots";
pub const PAGE_EXTRACTOR: &str = "webkit-page 1";

pub fn contribute_kinds(k: &mut Kinds) -> Result<(), DuplicateId> {
    k.add(
        ID,
        RecordKindDef {
            kind: KIND.into(),
            version: 1,
            format: Format::JsonDir,
            folder: "items".into(),
            slugged: true,
            subfolder_field: None,
        },
    )?;
    k.add_text_source(ID, KIND, Arc::new(|s: &Store, e: &Entry, part: Option<&str>| item_text(s, e, part)))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Pdf,
    Epub,
    Image,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Pdf => "pdf",
            Kind::Epub => "epub",
            Kind::Image => "image",
        }
    }
}

/// Recognises a file by its first bytes (and, for images, its extension).
pub fn detect(bytes: &[u8], name: &str) -> Option<(Kind, String)> {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_lowercase()).unwrap_or_default();
    if bytes.starts_with(b"%PDF-") || (bytes.len() > 1024 && bytes[..1024].windows(5).any(|w| w == b"%PDF-")) {
        return Some((Kind::Pdf, "pdf".into()));
    }
    if bytes.starts_with(b"PK\x03\x04") && bytes.get(30..58) == Some(b"mimetypeapplication/epub+zip") {
        return Some((Kind::Epub, "epub".into()));
    }
    if bytes.starts_with(b"PK\x03\x04") && ext == "epub" {
        return Some((Kind::Epub, "epub".into()));
    }
    let image = if bytes.starts_with(b"\x89PNG") {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.starts_with(b"GIF8") {
        Some("gif")
    } else if bytes.get(8..12) == Some(b"WEBP") {
        Some("webp")
    } else if bytes.get(4..12).is_some_and(|b| {
        b.starts_with(b"ftyp") && (b.ends_with(b"heic") || b.ends_with(b"heix") || b.ends_with(b"mif1"))
    }) {
        Some("heic")
    } else if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        Some("tiff")
    } else {
        None
    };
    image.map(|e| (Kind::Image, e.to_string()))
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn stem(path: &Path) -> String {
    path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Untitled".into())
}

/// Imports one file: the original is kept byte for byte.
pub fn import(ctx: &MethodCtx, path: &Path) -> Result<Written> {
    let lib = ctx.library;
    let store = &lib.store;
    let bytes =
        store.fs.read(path).map_err(|e| BackendError::io(format!("“{}” can’t be read: {e}", path.display())))?;
    let name = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let (kind, ext) = detect(&bytes, &name)
        .ok_or_else(|| BackendError::invalid(format!("“{name}” isn’t a PDF, an image or an EPUB.")))?;
    let id = store.ids.next_id();
    let title = stem(path);
    let now = librarium_kernel::time::iso_utc(store.clock.now_ms());
    let original = format!("original.{ext}");
    let record = json!({
        "id": id,
        "kind": KIND,
        "kind-version": 1,
        "created": now,
        "title": title,
        "sha256": sha256(&bytes),
        "provenance": { "source": Value::Null, "original-name": name, "saved-at": now, "saved-with": format!("Librarium {} (import)", env!("CARGO_PKG_VERSION")) },
        FORMAT: kind.name(),
        ORIGINAL: original,
    });
    let stage = store.stage_dir(id);
    store.stage_file(&stage, &original, &bytes)?;
    let mut rj = serde_json::to_vec_pretty(&record).unwrap();
    rj.push(b'\n');
    store.stage_file(&stage, "record.json", &rj)?;
    let t2 = title.clone();
    let (e, seq) = lib.write(Lane::Interactive, move |tx| tx.import_staged(KIND, &stage, &t2))?;
    if let Some(jobs) = ctx.jobs {
        jobs.enqueue("library.extract", &id.to_string(), json!({ "id": id }))?;
    }
    Ok(Written { info: e.info(), seq })
}

/// An item's original file (or another file inside its folder), validated to stay inside.
pub fn file_path(store: &Store, id: Id, name: Option<&str>) -> Result<PathBuf> {
    let e = store.get(id).filter(|e| e.kind == KIND).ok_or_else(|| BackendError::not_found("no such library item"))?;
    let name = match name {
        Some(n) => n.to_string(),
        None => e.field_str(ORIGINAL).ok_or_else(|| BackendError::not_found("the item has no original"))?.to_string(),
    };
    if name.split('/').any(|p| p.is_empty() || p == ".." || p.starts_with('.')) {
        return Err(BackendError::invalid("not a file of this item"));
    }
    Ok(store.record_dir(&e).join(name))
}

/// The stored extracted text of an item, as JSON.
pub fn stored_text(store: &Store, e: &Entry) -> Option<Value> {
    let rel = e.field_str(TEXT)?;
    let bytes = store.fs.read(&store.record_dir(e).join(rel)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Text for derived views and anchors: pages (or chapters) joined by blank lines, from stored
/// files only, with a segment for each.
pub fn item_text(store: &Store, e: &Entry, part: Option<&str>) -> Option<librarium_contracts::api::StoredText> {
    if e.field_str(FORMAT) == Some("web") {
        return snapshot_text(store, e, part);
    }
    let v = stored_text(store, e)?;
    let (parts, pages) = match v["pages"].as_array() {
        Some(p) => (p, true),
        None => (v["chapters"].as_array()?, false),
    };
    let mut text = String::new();
    let mut segments = vec![];
    let mut at = 0u64;
    for (i, p) in parts.iter().enumerate() {
        if i > 0 {
            text.push_str("\n\n");
            at += 2;
        }
        let t = p["text"].as_str().unwrap_or("");
        let n = t.chars().count() as u64;
        let label = if pages {
            format!("p. {}", p["page"].as_u64().unwrap_or(i as u64 + 1))
        } else {
            p["title"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("chapter {}", i + 1))
        };
        segments.push(librarium_contracts::api::TextSegment { label, start: at, end: at + n });
        text.push_str(t);
        at += n;
    }
    let origin = serde_json::json!({ "file": e.field_str(TEXT).unwrap_or(TEXT_FILE), "extractor": v["extractor"], "version": v["version"] });
    Some(librarium_contracts::api::StoredText { text, segments, origin: Some(origin) })
}

#[derive(Deserialize)]
struct ImportParams {
    paths: Vec<String>,
}

#[derive(Deserialize)]
struct FileParams {
    id: Id,
}

pub fn contribute_methods(r: &mut Registry<ApiMethod>) -> Result<(), DuplicateId> {
    r.add(
        ID,
        "library.removeSnapshots.prepare",
        Arc::new(|ctx: &MethodCtx, p: Value| {
            let reqs: Vec<snapshots::Request> =
                serde_json::from_value(p["items"].clone()).map_err(|e| BackendError::invalid(e.to_string()))?;
            snapshots::prepare(ctx, &reqs)
        }),
    )?;
    r.add(
        ID,
        "library.removeSnapshots",
        Arc::new(|ctx: &MethodCtx, p: Value| {
            let token = p["token"].as_str().ok_or_else(|| BackendError::invalid("no confirmation"))?;
            snapshots::remove(ctx, token)
        }),
    )?;
    r.add(
        ID,
        "library.import",
        Arc::new(|ctx: &MethodCtx, p: Value| {
            let p: ImportParams = serde_json::from_value(p).map_err(|e| BackendError::invalid(e.to_string()))?;
            let mut done = vec![];
            let mut failed = vec![];
            for path in p.paths {
                match import(ctx, Path::new(&path)) {
                    Ok(w) => done.push(w),
                    Err(e) => failed.push(json!({ "path": path, "error": e.message })),
                }
            }
            Ok(json!({ "imported": done, "failed": failed }))
        }),
    )?;
    r.add(
        ID,
        "library.text",
        Arc::new(|ctx: &MethodCtx, p: Value| {
            let p: FileParams = serde_json::from_value(p).map_err(|e| BackendError::invalid(e.to_string()))?;
            let e = ctx.library.store.get(p.id).ok_or_else(|| BackendError::not_found("no such item"))?;
            Ok(stored_text(&ctx.library.store, &e).unwrap_or(Value::Null))
        }),
    )?;
    Ok(())
}

/// A page with fewer visible characters than this is treated as a scan and recognised.
const SCAN_CHARS: usize = 16;

/// Extracts text in the worker (recognising images and scanned pages) and stores it beside the
/// original. Idempotent: an existing extraction is kept, so recognition never runs twice.
fn extract(recognizer: &dyn librarium_contracts::ports::TextRecognizer, ctx: &JobCtx, p: &Value) -> Result<()> {
    let id: Id = p["id"].as_str().and_then(|s| s.parse().ok()).ok_or_else(|| BackendError::invalid("no id"))?;
    let store = &ctx.library.store;
    let Some(e) = store.get(id) else { return Ok(()) };
    if stored_text(store, &e).is_some() {
        return Ok(());
    }
    let path = file_path(store, id, None)?;
    let format = e.field_str(FORMAT).unwrap_or("").to_string();
    ctx.progress(None, Some("Reading the text"));
    let (method, timeout) = match format.as_str() {
        "pdf" => ("pdf.text", Duration::from_secs(30)),
        "epub" => ("epub.parse", Duration::from_secs(30)),
        "image" => ("image.info", Duration::from_secs(30)),
        _ => return Ok(()),
    };
    let out = ctx.worker.call(method, json!({ "path": path }), timeout)?;
    ctx.check_cancelled()?;
    let stored = match format.as_str() {
        "image" => {
            ctx.progress(None, Some("Recognising text"));
            let r = recognizer.recognize_image(&path)?;
            json!({ "extractor": format!("{} {}", r.extractor, r.version), "version": 1, "pages": r.pages, "image": out })
        }
        "pdf" => {
            let mut v = out.clone();
            let scans: Vec<u32> = v["pages"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter(|pg| {
                            pg["text"].as_str().unwrap_or("").chars().filter(|c| !c.is_whitespace()).count()
                                < SCAN_CHARS
                        })
                        .filter_map(|pg| pg["page"].as_u64().map(|n| n as u32))
                        .collect()
                })
                .unwrap_or_default();
            if !scans.is_empty() {
                ctx.progress(
                    None,
                    Some(&format!(
                        "Recognising text on {} scanned page{}",
                        scans.len(),
                        if scans.len() == 1 { "" } else { "s" }
                    )),
                );
                let r = recognizer.recognize_pdf_pages(&path, &scans)?;
                if let Some(pages) = v["pages"].as_array_mut() {
                    for rp in &r.pages {
                        if let Some(pg) = pages.iter_mut().find(|pg| pg["page"].as_u64() == Some(rp.page as u64)) {
                            pg["text"] = json!(rp.text);
                            pg["lines"] = json!(rp.lines);
                            pg["recognized"] = json!(true);
                        }
                    }
                }
                v["extractor"] =
                    json!(format!("{} + {} {}", out["extractor"].as_str().unwrap_or(""), r.extractor, r.version));
            }
            v
        }
        _ => out.clone(),
    };
    let pages = stored["pages"].as_array().or_else(|| stored["chapters"].as_array()).map(|a| a.len());
    let bytes = serde_json::to_vec_pretty(&stored).unwrap();
    let version = e.hash.clone();
    let mut fields: Vec<(String, Option<FmValue>)> = vec![(TEXT.into(), Some(FmValue::Str(TEXT_FILE.into())))];
    if let Some(n) = pages {
        fields.push((PAGES.into(), Some(FmValue::Int(n as i64))));
    }
    // An EPUB's own title replaces the file name, unless the user renamed the item already.
    let book_title = out["title"].as_str().filter(|t| !t.trim().is_empty()).map(str::to_string);
    let original_name =
        e.fields.get("provenance").and_then(|p| p["original-name"].as_str()).map(|n| stem(Path::new(n)));
    ctx.library
        .write(Lane::Background, move |tx| -> Result<()> {
            tx.write_record_file(id, TEXT_FILE, &bytes)?;
            // record.json is the commit point.
            tx.set_fields(id, Some(&version), &fields)?;
            if let (Some(t), Some(orig)) = (book_title, original_name) {
                if tx.store.get(id).is_some_and(|e| e.title == orig) {
                    tx.relocate(id, Some(&t), None)?;
                }
            }
            Ok(())
        })
        .or_else(|e| if e.code == ErrorCode::Conflict { Ok(()) } else { Err(e) })
}

pub fn contribute_jobs(
    r: &mut Registry<JobKind>,
    recognizer: Arc<dyn librarium_contracts::ports::TextRecognizer>,
) -> Result<(), DuplicateId> {
    r.add(
        ID,
        "library.extract",
        JobKind {
            kind: "library.extract".into(),
            title: "Reading an item’s text".into(),
            noun: "text recognitions".into(),
            resumable: true,
            one_at_a_time: true,
            run: Arc::new(move |ctx: &JobCtx, p: &Value| extract(&*recognizer, ctx, p)),
            trigger: None,
        },
    )
}

// ---- saved web pages -----------------------------------------------------------------------

/// A snapshot's text (`snapshots/<at>/text.json`): the latest one, or the one named.
pub fn snapshot_text(store: &Store, e: &Entry, part: Option<&str>) -> Option<librarium_contracts::api::StoredText> {
    let at = part.map(str::to_string).or_else(|| e.field_str(SNAPSHOT).map(str::to_string))?;
    if at.contains(['/', '.']) {
        return None;
    }
    let v: Value = serde_json::from_slice(
        &store.fs.read(&store.record_dir(e).join("snapshots").join(&at).join("text.json")).ok()?,
    )
    .ok()?;
    let text = v["text"].as_str().unwrap_or("").to_string();
    let end = text.chars().count() as u64;
    Some(librarium_contracts::api::StoredText {
        text,
        segments: vec![librarium_contracts::api::TextSegment { label: String::new(), start: 0, end }],
        origin: Some(
            json!({ "file": format!("snapshots/{at}/text.json"), "extractor": v["extractor"], "version": v["version"], "snapshot": at }),
        ),
    })
}

/// An http(s) address with a host: the only kind a saved page can come from.
pub fn is_web_address(u: &str) -> bool {
    let lower = u.to_ascii_lowercase();
    let rest = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://"));
    rest.and_then(|r| r.split(['/', '?', '#']).next()).is_some_and(|host| !host.is_empty())
}

/// The item already saved from this address, if any (saving again adds a snapshot to it).
pub fn item_for_url(store: &Store, url: &str) -> Option<Entry> {
    item_for_url_visible(store, url, &[])
}

/// Like [`item_for_url`], passing over items with any of the `hide` fields set (e.g. archived
/// ones): a page saved again while its item is hidden becomes a new item.
pub fn item_for_url_visible(store: &Store, url: &str, hide: &[String]) -> Option<Entry> {
    // As the interface compares: no #fragment, then no trailing slash.
    let norm = |u: &str| u.split('#').next().unwrap_or("").trim_end_matches('/').to_string();
    if !is_web_address(url) {
        return None;
    }
    let want = norm(url);
    store.list(Some(KIND)).into_iter().find(|e| {
        if hide.iter().any(|f| e.fields.get(f).is_some_and(|v| !v.is_null())) {
            return false;
        }
        let p = e.fields.get("provenance");
        [p.and_then(|p| p["source"].as_str()), p.and_then(|p| p["final-url"].as_str())]
            .iter()
            .flatten()
            .any(|u| norm(u) == want)
    })
}

/// Saves a web page: a faithful PDF and its clean text, as a new item or a new snapshot.
fn save_page(saver: &dyn librarium_contracts::ports::PageSaver, ctx: &JobCtx, p: &Value) -> Result<()> {
    let url = p["url"].as_str().ok_or_else(|| BackendError::invalid("no address"))?.to_string();
    let store = &ctx.library.store;
    ctx.progress(None, Some("Loading the page"));
    let page = saver.save(&url, Duration::from_secs(90))?;
    ctx.check_cancelled()?;
    // A page that ends anywhere but on the web (about:blank, an error page of the browser…)
    // wasn't loaded: never keep it, and never let it match another item.
    if !is_web_address(&page.final_url) {
        return Err(BackendError::io(format!("the page didn’t load (it ended at {})", page.final_url)));
    }
    let checks = checks::check(&page);
    let now_ms = store.clock.now_ms();
    let at = librarium_kernel::time::iso_compact(now_ms);
    let now = librarium_kernel::time::iso_utc(now_ms);
    let sha = sha256(&page.pdf);
    let snapshot =
        json!({ "at": at, "sha256": sha, "final-url": page.final_url, "status": page.status, "checks": checks });
    let text = json!({ "extractor": PAGE_EXTRACTOR, "version": 1, "title": page.title, "final_url": page.final_url, "status": page.status, "language": page.language, "images": page.images, "checks": checks, "text": page.text });
    let hide: Vec<String> = p["hide"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let existing =
        item_for_url_visible(store, &url, &hide).or_else(|| item_for_url_visible(store, &page.final_url, &hide));
    // Idempotent: the job's own snapshot (same key, same PDF) is not added twice.
    if let Some(e) = &existing {
        if e.fields.get(SNAPSHOTS).and_then(|v| v.as_array()).is_some_and(|a| a.iter().any(|s| s["sha256"] == sha)) {
            return Ok(());
        }
    }
    let id = existing.as_ref().map(|e| e.id).unwrap_or_else(|| store.ids.next_id());
    let stage = store.stage_dir(id).join("snapshot");
    store.stage_file(&stage, "page.pdf", &page.pdf)?;
    store.stage_file(&stage, "text.json", &serde_json::to_vec_pretty(&text).unwrap())?;
    ctx.progress(Some(0.9), Some("Storing the snapshot"));
    match existing {
        Some(e) => {
            let version = e.hash.clone();
            let mut all = e.fields.get(SNAPSHOTS).and_then(|v| v.as_array()).cloned().unwrap_or_default();
            all.push(snapshot);
            let at2 = at.clone();
            ctx.library.write(Lane::Background, move |tx| -> Result<()> {
                tx.import_into(id, &stage, &format!("snapshots/{at2}"))?;
                // record.json is the commit point.
                tx.set_fields(
                    id,
                    Some(&version),
                    &[
                        (SNAPSHOTS.into(), Some(FmValue::Other(Value::Array(all)))),
                        (SNAPSHOT.into(), Some(FmValue::Str(at2.clone()))),
                    ],
                )?;
                Ok(())
            })?;
        }
        None => {
            let title = if page.title.trim().is_empty() { url.clone() } else { page.title.clone() };
            let record = json!({
                "id": id,
                "kind": KIND,
                "kind-version": 1,
                "created": now,
                "title": title,
                "provenance": { "source": url, "final-url": page.final_url, "author": page.author, "publication": page.publication, "published": page.published, "saved-at": now, "saved-with": format!("Librarium {} (WebKit)", env!("CARGO_PKG_VERSION")) },
                FORMAT: "web",
                SNAPSHOT: at,
                SNAPSHOTS: [snapshot],
            });
            let dir = store.stage_dir(id);
            let snap_dir = dir.join("snapshots").join(&at);
            store.fs.create_dir_all(snap_dir.parent().unwrap()).map_err(|e| BackendError::io(e.to_string()))?;
            store.fs.rename(&stage, &snap_dir).map_err(|e| BackendError::io(e.to_string()))?;
            let mut rj = serde_json::to_vec_pretty(&record).unwrap();
            rj.push(b'\n');
            store.stage_file(&dir, "record.json", &rj)?;
            ctx.library.write(Lane::Background, move |tx| tx.import_staged(KIND, &dir, &title))?;
        }
    }
    Ok(())
}

/// The job that saves pages, with the saver it uses.
pub fn contribute_page_jobs(
    r: &mut Registry<JobKind>,
    saver: Arc<dyn librarium_contracts::ports::PageSaver>,
) -> Result<(), DuplicateId> {
    r.add(
        ID,
        "library.savePage",
        JobKind {
            kind: "library.savePage".into(),
            title: "Saving a web page".into(),
            noun: "saves".into(),
            resumable: true,
            one_at_a_time: true,
            run: Arc::new(move |ctx: &JobCtx, p: &Value| save_page(&*saver, ctx, p)),
            trigger: None,
        },
    )
}

/// `library.savePage {url, hide?}`: queues a save (one job per address at a time).
pub fn contribute_page_methods(m: &mut Registry<ApiMethod>) -> Result<(), DuplicateId> {
    m.add(
        ID,
        "library.savePage",
        Arc::new(|ctx: &MethodCtx, p: Value| {
            let url = p["url"]
                .as_str()
                .map(str::trim)
                .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
                .ok_or_else(|| BackendError::invalid("That isn’t a web address (it should start with https://)."))?;
            let jobs = ctx.jobs.ok_or_else(|| BackendError::new(ErrorCode::NotReady, "Jobs are starting."))?;
            // Records hidden in the interface (e.g. archived) never receive the snapshot.
            let hide = p.get("hide").cloned().unwrap_or(json!([]));
            Ok(serde_json::to_value(jobs.enqueue("library.savePage", url, json!({ "url": url, "hide": hide }))?)
                .unwrap())
        }),
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_web_addresses_count() {
        for good in ["https://a.example/x", "http://a.example", "HTTPS://A.example/?q"] {
            assert!(super::is_web_address(good), "{good}");
        }
        for bad in ["about:blank", "https://", "file:///etc/passwd", "", "data:text/html,x"] {
            assert!(!super::is_web_address(bad), "{bad}");
        }
    }

    use super::*;

    #[test]
    fn detects_formats() {
        assert_eq!(detect(b"%PDF-1.7 ...", "x.pdf").unwrap().0, Kind::Pdf);
        assert_eq!(detect(b"\x89PNG\r\n\x1a\n....", "x.png").unwrap().1, "png");
        assert_eq!(detect(&[0xFF, 0xD8, 0xFF, 0xE0], "photo").unwrap().1, "jpg");
        let mut epub = b"PK\x03\x04".to_vec();
        epub.extend([0u8; 26]);
        epub.extend(b"mimetypeapplication/epub+zip");
        assert_eq!(detect(&epub, "book").unwrap().0, Kind::Epub);
        assert!(detect(b"plain text", "notes.txt").is_none());
    }
}
