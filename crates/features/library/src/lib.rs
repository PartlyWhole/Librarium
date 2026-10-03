//! Library: saved web pages, PDFs, images and EPUBs, each a folder with `record.json`.
//!
//! - Importing stages the untouched original (and its record) in Application Support, then
//!   moves the folder in with one rename. `record.json` holds the original's sha256 and its
//!   provenance.
//! - Text is extracted in the worker (`library.extract`, a resumable job) and stored in
//!   `extracted/text-v1.json`, stamped with the extractor's version, so rebuilding the index
//!   never re-runs extraction (or, later, recognition).

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
    k.add_text_source(ID, KIND, Arc::new(item_text))
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

/// Text for the derived views: pages (or chapters) as paragraphs, from stored files only.
pub fn item_text(store: &Store, e: &Entry) -> Option<String> {
    let v = stored_text(store, e)?;
    let parts = v["pages"].as_array().or_else(|| v["chapters"].as_array())?;
    Some(parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n\n"))
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

/// Extracts text in the worker and stores it beside the original. Idempotent: an existing
/// extraction by the same extractor version is kept.
fn extract(ctx: &JobCtx, p: &Value) -> Result<()> {
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
    let pages = out["pages"].as_array().or_else(|| out["chapters"].as_array()).map(|a| a.len());
    let stored = if format == "image" {
        json!({ "extractor": "none", "version": 0, "pages": [], "image": out })
    } else {
        out.clone()
    };
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

pub fn contribute_jobs(r: &mut Registry<JobKind>) -> Result<(), DuplicateId> {
    r.add(
        ID,
        "library.extract",
        JobKind {
            kind: "library.extract".into(),
            title: "Reading an item’s text".into(),
            noun: "text extractions".into(),
            resumable: true,
            run: Arc::new(extract),
            trigger: None,
        },
    )
}

#[cfg(test)]
mod tests {
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
