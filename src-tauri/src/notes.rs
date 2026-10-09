//! Notes: what the user writes, named and in folders.

use crate::error::Result;
use crate::store::{record, save, Library};
use crate::types::{NoteParams, Written};

/// Creates a note; an empty title becomes "Untitled".
pub fn create(lib: &Library, p: NoteParams) -> Result<Written> {
    let title = p.title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| "Untitled".into());
    let w = lib.write();
    let e = save::create(&w, "note", &title, vec![], &p.body, p.folder.as_deref())?;
    Ok(Written { info: record::info(lib, &e), seq: w.seq() })
}
