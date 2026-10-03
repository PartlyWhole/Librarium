//! PDF text extraction, page by page.

use librarium_contracts::BackendError;
use serde_json::{json, Value};
use std::path::Path;

/// Stamped into every stored extraction, so anchors know which text they refer to.
pub const EXTRACTOR: &str = "pdf-extract 0.12";
pub const VERSION: u32 = 1;

pub fn text(path: &Path) -> Result<Value, BackendError> {
    let bytes = std::fs::read(path).map_err(|e| BackendError::io(e.to_string()))?;
    let pages = pdf_extract::extract_text_from_mem_by_pages(&bytes)
        .map_err(|e| BackendError::invalid(format!("the PDF's text could not be read: {e}")))?;
    let pages: Vec<Value> =
        pages.into_iter().enumerate().map(|(i, t)| json!({ "page": i + 1, "text": normalize(&t) })).collect();
    Ok(json!({ "extractor": EXTRACTOR, "version": VERSION, "pages": pages }))
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
