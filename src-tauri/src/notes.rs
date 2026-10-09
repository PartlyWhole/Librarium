//! Notes: what the user writes, named and in folders.

use crate::error::Result;
use crate::store::{record, Library};
use crate::types::{NoteParams, Written};
use std::collections::BTreeSet;

/// Creates a note; an empty title becomes "Untitled".
pub fn create(lib: &Library, p: NoteParams) -> Result<Written> {
    let title = p.title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| "Untitled".into());
    let w = lib.write();
    let e = record::create(&w, "note", &title, vec![], &p.body, p.folder.as_deref())?;
    Ok(Written { info: record::info(lib, &e), seq: w.seq() })
}

/// Every folder holding notes, from their paths.
pub fn folders(lib: &Library) -> Result<Vec<String>> {
    let mut out = BTreeSet::new();
    for e in lib.index.list(Some("note"))? {
        let parts: Vec<&str> = e.path.split('/').collect();
        out.extend((2..parts.len()).map(|i| parts[1..i].join("/")));
    }
    Ok(out.into_iter().collect())
}
