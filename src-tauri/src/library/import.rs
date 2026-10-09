//! Adding files to the library. The original is kept byte for byte, with its SHA-256 and where
//! it came from; it and its `record.json` are staged in app data and moved in with one rename.
//! Text extraction is queued after.

use super::{saved_with, FOLDER, FORMAT, KIND, ORIGINAL};
use crate::error::{Error, Result};
use crate::store::{files, folders, record, Library};
use crate::types::{ImportFailure, ImportResult, Written};
use crate::util::{iso_utc, json_bytes, new_id, now_ms, sha256};
use base64::Engine as _;
use serde_json::{json, Value};
use std::path::Path;

/// Pasted data larger than this (in base64) is refused: add it as a file instead.
const MAX_PASTE_B64: usize = 70_000_000;

/// The format (`pdf`, `epub`, `image`) and the original's extension, from the first bytes. An
/// EPUB is a zip whose first entry says so, or a zip named `.epub`.
pub fn detect(bytes: &[u8], name: &str) -> Option<(&'static str, &'static str)> {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_lowercase()).unwrap_or_default();
    if bytes.starts_with(b"%PDF-") || (bytes.len() > 1024 && bytes[..1024].windows(5).any(|w| w == b"%PDF-")) {
        return Some(("pdf", "pdf"));
    }
    if bytes.starts_with(b"PK\x03\x04") && (bytes.get(30..58) == Some(b"mimetypeapplication/epub+zip") || ext == "epub")
    {
        return Some(("epub", "epub"));
    }
    let image = if bytes.starts_with(b"\x89PNG") {
        "png"
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "jpg"
    } else if bytes.starts_with(b"GIF8") {
        "gif"
    } else if bytes.get(8..12) == Some(b"WEBP") {
        "webp"
    } else if bytes.get(4..12).is_some_and(|b| {
        b.starts_with(b"ftyp") && (b.ends_with(b"heic") || b.ends_with(b"heix") || b.ends_with(b"mif1"))
    }) {
        "heic"
    } else if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        "tiff"
    } else {
        return None;
    };
    Some(("image", image))
}

/// A file name without its extension, as an item's first title.
pub fn stem(name: &str) -> String {
    let s = Path::new(name).file_stem().map(|s| s.to_string_lossy().trim().to_string()).unwrap_or_default();
    if s.is_empty() {
        "Untitled".into()
    } else {
        s
    }
}

/// A Library folder to import into: `None` at the top level.
fn clean(folder: Option<&str>) -> Result<Option<String>> {
    folder.map(|f| f.trim().trim_matches('/')).filter(|f| !f.is_empty()).map(folders::clean_folder).transpose()
}

/// Imports files one by one; those that can't be read or aren't a known format are reported.
pub fn import_paths(lib: &Library, paths: &[String], folder: Option<&str>) -> Result<ImportResult> {
    let folder = clean(folder)?;
    let mut out = ImportResult { imported: vec![], failed: vec![] };
    for path in paths {
        match import_file(lib, Path::new(path), folder.as_deref()) {
            Ok(w) => out.imported.push(w),
            Err(e) => out.failed.push(ImportFailure { path: path.clone(), error: e.message }),
        }
    }
    Ok(out)
}

fn import_file(lib: &Library, path: &Path, folder: Option<&str>) -> Result<Written> {
    let name = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let bytes = std::fs::read(path).map_err(|e| Error::io(format!("“{name}” can’t be read: {e}")))?;
    import_bytes(lib, &bytes, &name, folder)
}

/// Imports pasted or dropped bytes, named as given.
pub fn import_data(lib: &Library, name: Option<&str>, data: &str, folder: Option<&str>) -> Result<Written> {
    let name = name.map(str::trim).filter(|n| !n.is_empty()).unwrap_or("Pasted image");
    if name.contains(['/', '\\']) || name.starts_with('.') || name.len() > 200 {
        return Err(Error::invalid("That isn’t a file name."));
    }
    if data.len() > MAX_PASTE_B64 {
        return Err(Error::invalid("That is too large to paste (over 50 MB); add it as a file."));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| Error::invalid(format!("not base64: {e}")))?;
    import_bytes(lib, &bytes, name, clean(folder)?.as_deref())
}

fn import_bytes(lib: &Library, bytes: &[u8], name: &str, folder: Option<&str>) -> Result<Written> {
    let (format, ext) =
        detect(bytes, name).ok_or_else(|| Error::invalid(format!("“{name}” isn’t a PDF, an image or an EPUB.")))?;
    let id = new_id();
    let now = iso_utc(now_ms());
    let original = format!("original.{ext}");
    let mut rec = json!({
        "id": id,
        "kind": KIND,
        "kind-version": 1,
        "created": now,
        "title": stem(name),
        "sha256": sha256(bytes),
        "provenance": {
            "original-name": name,
            "saved-at": now,
            "saved-with": saved_with("import"),
            "source": Value::Null,
        },
        FORMAT: format,
        ORIGINAL: original,
    });
    if let Some(f) = folder {
        rec[FOLDER] = json!(f);
    }
    let stage = files::stage_dir(lib)?;
    let imported = (|| -> Result<Written> {
        files::stage_file(&stage, &original, bytes)?;
        files::stage_file(&stage, "record.json", &json_bytes(&rec, true))?;
        let w = lib.write();
        let e = files::import_item(&w, &stage)?;
        Ok(Written { info: record::info(lib, &e), seq: w.seq() })
    })();
    if imported.is_err() {
        let _ = std::fs::remove_dir_all(&stage);
    }
    let written = imported?;
    lib.jobs.enqueue(lib, "library.extract", &id.to_string(), json!({ "id": id }));
    Ok(written)
}
