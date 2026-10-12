//! The library: imported PDFs, EPUBs and pictures, and saved web pages. Each item is a folder
//! in `items/` holding `record.json`, its original (or its snapshots) and its extracted text.

pub mod epub;
pub mod extract;
pub mod import;
pub mod ocr;
pub mod snapshots;

use crate::error::{Error, Result};
use crate::store::record::{self, Entry};
use crate::store::{files, Library};
use crate::types::Written;
use crate::util::{iso_utc, json_bytes, new_id, now_ms, Id};
use serde_json::{json, Value};
use std::path::PathBuf;

pub const KIND: &str = "item";
pub const FORMAT: &str = "library.format";
pub const ORIGINAL: &str = "library.original";
pub const TEXT: &str = "library.text";
pub const PAGES: &str = "library.pages";
/// Where extracted text is stored, inside the item's folder.
pub const TEXT_FILE: &str = "extracted/text-v1.json";
/// A saved page's current snapshot (its folder name under `snapshots/`).
pub const SNAPSHOT: &str = "library.snapshot";
/// Every snapshot of a saved page, oldest first.
pub const SNAPSHOTS: &str = "library.snapshots";
/// Mirrors the item's subfolder of `items/`.
pub const FOLDER: &str = "library.folder";

/// An item that stands for one of the app's downloaded datasets (a Bible version, word origins),
/// which captures from it cite: the one whose field `key` is `value`, or a new one with these
/// fields (its record only; the data stays in app data).
pub fn dataset_item(
    lib: &Library,
    key: &str,
    value: &str,
    title: &str,
    fields: Value,
    how: &str,
    source: &str,
) -> Result<Written> {
    let w = lib.write();
    if let Some(e) = lib.index.with_field(key, value)?.into_iter().find(|e| e.kind == KIND) {
        return Ok(Written { info: record::info(lib, &e), seq: w.seq() });
    }
    let at = iso_utc(now_ms());
    let mut rec = json!({
        "id": new_id(),
        "kind": KIND,
        "kind-version": 1,
        "created": at,
        "title": title,
        "provenance": { "saved-at": at, "saved-with": saved_with(how), "source": source },
    });
    if let (Some(rec), Value::Object(f)) = (rec.as_object_mut(), fields) {
        rec.extend(f);
    }
    let stage = files::stage_dir(lib)?;
    let made =
        files::stage_file(&stage, "record.json", &json_bytes(&rec, true)).and_then(|_| files::import_item(&w, &stage));
    let _ = std::fs::remove_dir_all(&stage);
    let e = made?;
    Ok(Written { info: record::info(lib, &e), seq: w.seq() })
}

/// "Librarium 0.1.0 (import)": what saved an item.
pub fn saved_with(how: &str) -> String {
    format!("Librarium {} ({how})", env!("CARGO_PKG_VERSION"))
}

/// A library item by ID.
pub fn item(lib: &Library, id: Id) -> Result<Entry> {
    lib.index.get(id).filter(|e| e.kind == KIND).ok_or_else(|| Error::not_found("That library item can’t be found."))
}

/// A file of an item: its original when `name` is absent, else a file inside its folder
/// (`snapshots/<at>/page.pdf`). Never anything outside the folder.
pub fn file_path(lib: &Library, id: Id, name: Option<&str>) -> Result<PathBuf> {
    let e = item(lib, id)?;
    let name = match name {
        Some(n) => n,
        None => e.field_str(ORIGINAL).ok_or_else(|| Error::not_found("This item has no original file."))?,
    };
    if name.split('/').any(|p| p.is_empty() || p == ".." || p.starts_with('.')) {
        return Err(Error::invalid("That isn’t a file of this item."));
    }
    Ok(e.dir(lib).join(name))
}

/// An item's stored extraction (`extracted/text-v1.json`), as it is on disk.
pub fn stored_json(lib: &Library, e: &Entry) -> Option<Value> {
    let rel = e.field_str(TEXT)?;
    serde_json::from_slice(&std::fs::read(e.dir(lib).join(rel)).ok()?).ok()
}
