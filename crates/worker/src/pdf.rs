//! PDF text extraction, page by page.

use librarium_contracts::BackendError;
use serde_json::{json, Value};
use std::path::Path;

/// Stamped into every stored extraction, so anchors know which text they refer to.
pub const EXTRACTOR: &str = "pdfkit";
pub const VERSION: u32 = 1;
/// Used only when PDFKit can't open a file.
pub const FALLBACK: &str = "pdf-extract 0.12";

/// Each page's text, read with PDFKit (Apple's own reader, which copes with the fonts WebKit
/// and most producers embed). Falls back to pdf-extract if PDFKit can't open the file.
pub fn text(path: &Path) -> Result<Value, BackendError> {
    if let Some(pages) = pdfkit_pages(path) {
        let pages: Vec<Value> =
            pages.into_iter().enumerate().map(|(i, t)| json!({ "page": i + 1, "text": normalize(&t) })).collect();
        return Ok(json!({ "extractor": EXTRACTOR, "version": VERSION, "pages": pages }));
    }
    let bytes = std::fs::read(path).map_err(|e| BackendError::io(e.to_string()))?;
    let pages = pdf_extract::extract_text_from_mem_by_pages(&bytes)
        .map_err(|e| BackendError::invalid(format!("the PDF's text could not be read: {e}")))?;
    let pages: Vec<Value> =
        pages.into_iter().enumerate().map(|(i, t)| json!({ "page": i + 1, "text": normalize(&t) })).collect();
    Ok(json!({ "extractor": FALLBACK, "version": VERSION, "pages": pages }))
}

fn pdfkit_pages(path: &Path) -> Option<Vec<String>> {
    use objc2::AnyThread;
    use objc2_foundation::{NSString, NSURL};
    use objc2_pdf_kit::PDFDocument;
    objc2::rc::autoreleasepool(|_| {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str()?));
        // SAFETY: a plain file URL; PDFKit returns nil for files it can't read.
        let doc = unsafe { PDFDocument::initWithURL(PDFDocument::alloc(), &url) }?;
        if unsafe { doc.isLocked() } {
            return None;
        }
        let n = unsafe { doc.pageCount() };
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let text = unsafe { doc.pageAtIndex(i) }.and_then(|p| unsafe { p.string() });
            out.push(text.map(|s| s.to_string()).unwrap_or_default());
        }
        Some(out)
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

/// Pages and drawn images (image XObjects used by the pages).
pub fn info(path: &Path) -> Result<Value, BackendError> {
    let doc =
        lopdf::Document::load(path).map_err(|e| BackendError::invalid(format!("the PDF couldn’t be read: {e}")))?;
    // Images may sit inside form XObjects (WebKit wraps content in them), so follow those too.
    // Each image counts once, however often it is drawn.
    let mut images = std::collections::HashSet::new();
    let mut seen_forms = std::collections::HashSet::new();
    for (_, page) in doc.get_pages() {
        let (resources, inherited) = doc.get_page_resources(page).unwrap_or((None, vec![]));
        let mut stack: Vec<lopdf::Dictionary> = resources.into_iter().cloned().collect();
        stack.extend(inherited.iter().filter_map(|id| doc.get_dictionary(*id).ok().cloned()));
        while let Some(res) = stack.pop() {
            let Ok(xobjects) =
                res.get(b"XObject").and_then(|o| doc.dereference(o).map(|(_, o)| o)).and_then(|o| o.as_dict())
            else {
                continue;
            };
            for (_, v) in xobjects.iter() {
                let id = v.as_reference().ok();
                let Ok((_, lopdf::Object::Stream(s))) = doc.dereference(v) else { continue };
                match s.dict.get(b"Subtype").and_then(|t| t.as_name()) {
                    Ok(b"Image") => {
                        images.insert(id.unwrap_or((u32::MAX - images.len() as u32, 0)));
                    }
                    Ok(b"Form") if id.is_none_or(|id| seen_forms.insert(id)) => {
                        if let Ok(r) = s.dict.get(b"Resources").and_then(|o| doc.dereference(o).map(|(_, o)| o)) {
                            if let Ok(d) = r.as_dict() {
                                stack.push(d.clone());
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    Ok(json!({ "pages": doc.get_pages().len(), "images": images.len() }))
}
