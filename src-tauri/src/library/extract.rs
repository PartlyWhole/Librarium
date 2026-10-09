//! The `library.extract` job: an item's text, read once and stored in
//! `extracted/text-v1.json`, stamped with what made it. Anchors point into that text, so it is
//! never made again once it exists: an index rebuild reads the stored file.
//!
//! - PDF: PDFKit page by page (pdf-extract when PDFKit can't open the file). Pages with fewer
//!   than 16 visible characters are scans, and are recognised with Vision.
//! - EPUB: each spine document's text; the book's own title replaces the file name, unless the
//!   item was renamed since.
//! - Pictures: recognised with Vision.

use super::{epub, file_path, import::stem, ocr, stored_json, FORMAT, KIND, PAGES, TEXT, TEXT_FILE};
use crate::error::{Error, Result};
use crate::jobs::JobCtx;
use crate::store::frontmatter::FmValue;
use crate::store::{files, relocate, save, Library};
use crate::util::{clean_title, json_bytes, parse_id};
use serde_json::{json, Value};
use std::path::Path;

pub const PDF_EXTRACTOR: &str = "pdfkit";
/// Used only when PDFKit can't open a file.
pub const PDF_FALLBACK: &str = "pdf-extract 0.12";
pub const VERSION: u32 = 1;
/// A page with fewer visible characters than this is a scan.
const SCAN_CHARS: usize = 16;

pub fn run(lib: &Library, payload: &Value, job: &JobCtx) -> Result<()> {
    let id = payload["id"].as_str().and_then(parse_id).ok_or_else(|| Error::invalid("no item ID"))?;
    let Some(e) = lib.index.get(id).filter(|e| e.kind == KIND) else { return Ok(()) };
    if stored_json(lib, &e).is_some() {
        return Ok(());
    }
    // Stored before, but `record.json` didn't get to say so: kept as it is. One that doesn't
    // parse is never replaced.
    let written: Option<Value> = match std::fs::read(e.dir(lib).join(TEXT_FILE)) {
        Ok(b) => Some(serde_json::from_slice(&b).map_err(|_| {
            Error::invalid(format!("{TEXT_FILE} of “{}” can’t be read, so it was left as it is.", e.title))
        })?),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => return Err(Error::io(format!("reading the stored text: {err}"))),
    };
    let fresh = written.is_none();
    let stored = match written {
        Some(v) => v,
        None => {
            let path = || file_path(lib, id, None);
            match e.field_str(FORMAT) {
                Some("pdf") => pdf(&path()?, job)?,
                Some("epub") => {
                    job.progress(None, Some("Reading the book"));
                    epub::parse(&path()?)?
                }
                Some("image") => image(&path()?, job)?,
                _ => return Ok(()),
            }
        }
    };
    job.check_cancelled()?;
    commit(lib, id, &stored, fresh)
}

/// Writes the text (when new), then `record.json`, which is the commit point.
fn commit(lib: &Library, id: crate::util::Id, stored: &Value, fresh: bool) -> Result<()> {
    let w = lib.write();
    let Some(e) = lib.index.get(id) else { return Ok(()) };
    if fresh {
        files::write_item_file(&w, &e, TEXT_FILE, &json_bytes(stored, false))?;
    }
    let mut edits = vec![(TEXT.to_string(), Some(FmValue::Str(TEXT_FILE.into())))];
    if let Some(n) = stored["pages"].as_array().or_else(|| stored["chapters"].as_array()).map(Vec::len) {
        edits.push((PAGES.to_string(), Some(FmValue::Int(n as i64))));
    }
    let e = save::set_fields(&w, id, None, &edits)?;
    let book_title = stored["title"].as_str().map(clean_title).filter(|t| !t.is_empty());
    if let (Some("epub"), Some(t)) = (e.field_str(FORMAT), book_title) {
        let original = e.fields.get("provenance").and_then(|p| p["original-name"].as_str()).map(stem);
        if original.as_deref() == Some(e.title.as_str()) && e.title != t {
            relocate::relocate(&w, id, None, Some(&t), None)?;
        }
    }
    Ok(())
}

fn pdf(path: &Path, job: &JobCtx) -> Result<Value> {
    job.progress(None, Some("Reading the text"));
    let mut v = pdf_text(path)?;
    let visible = |p: &Value| p["text"].as_str().unwrap_or("").chars().filter(|c| !c.is_whitespace()).count();
    let scans: Vec<u32> = v["pages"]
        .as_array()
        .map(|a| a.iter().filter(|p| visible(p) < SCAN_CHARS).filter_map(|p| p["page"].as_u64()).map(|n| n as u32))
        .into_iter()
        .flatten()
        .collect();
    if scans.is_empty() {
        return Ok(v);
    }
    let what = format!("Recognising text on {} scanned page{}", scans.len(), if scans.len() == 1 { "" } else { "s" });
    for (i, &n) in scans.iter().enumerate() {
        job.check_cancelled()?;
        job.progress(Some(i as f32 / scans.len() as f32), Some(&what));
        let Some(r) = ocr::pdf_page(path, n)? else { continue };
        if let Some(page) = v["pages"].as_array_mut().and_then(|a| a.iter_mut().find(|p| p["page"] == n)) {
            page["text"] = r["text"].clone();
            page["lines"] = r["lines"].clone();
            page["recognized"] = json!(true);
        }
    }
    let base = v["extractor"].as_str().unwrap_or(PDF_EXTRACTOR).to_string();
    v["extractor"] = json!(format!("{base} + {} {}", ocr::EXTRACTOR, ocr::VERSION));
    Ok(v)
}

fn image(path: &Path, job: &JobCtx) -> Result<Value> {
    let size = imagesize::size(path).map_err(|e| Error::invalid(format!("not a picture that can be read: {e}")))?;
    job.progress(None, Some("Recognising text"));
    let page = ocr::image(path)?;
    Ok(json!({
        "extractor": format!("{} {}", ocr::EXTRACTOR, ocr::VERSION),
        "version": VERSION,
        "pages": [page],
        "image": { "width": size.width, "height": size.height },
    }))
}

/// Each page's text, with PDFKit (Apple's own reader, which copes with the fonts WebKit and most
/// producers embed), or with pdf-extract if PDFKit can't open the file.
pub fn pdf_text(path: &Path) -> Result<Value> {
    let (extractor, pages) = match pdfkit_pages(path) {
        Some(p) => (PDF_EXTRACTOR, p),
        None => {
            let bytes = std::fs::read(path).map_err(|e| Error::io(e.to_string()))?;
            let pages = pdf_extract::extract_text_from_mem_by_pages(&bytes)
                .map_err(|e| Error::invalid(format!("the PDF’s text couldn’t be read: {e}")))?;
            (PDF_FALLBACK, pages)
        }
    };
    let pages: Vec<Value> =
        pages.iter().enumerate().map(|(i, t)| json!({ "page": i + 1, "text": normalize(t) })).collect();
    Ok(json!({ "extractor": extractor, "version": VERSION, "pages": pages }))
}

fn pdfkit_pages(path: &Path) -> Option<Vec<String>> {
    use objc2::AnyThread;
    use objc2_foundation::{NSString, NSURL};
    use objc2_pdf_kit::PDFDocument;
    objc2::rc::autoreleasepool(|_| {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str()?));
        // SAFETY: a file URL; PDFKit returns nil for files it can't read.
        let doc = unsafe { PDFDocument::initWithURL(PDFDocument::alloc(), &url) }?;
        // SAFETY: plain getters on a live document and its pages.
        unsafe {
            if doc.isLocked() {
                return None;
            }
            let n = doc.pageCount();
            Some(
                (0..n)
                    .map(|i| doc.pageAtIndex(i).and_then(|p| p.string()).map(|s| s.to_string()).unwrap_or_default())
                    .collect(),
            )
        }
    })
}

/// Tidies extracted text: no trailing spaces, at most one blank line in a row.
pub fn normalize(t: &str) -> String {
    let mut out = String::with_capacity(t.len());
    let mut blank = 0;
    for line in t.lines() {
        let l = line.trim_end();
        if l.is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        out.push_str(l);
        out.push('\n');
    }
    out.trim().to_string()
}
