//! Notes: everything the user writes. Named, in folders, linked to each other.

use librarium_contracts::api::Written;
use librarium_contracts::{BackendError, Result};
use librarium_kernel::kinds::{Format, Kinds, RecordKindDef};
use librarium_kernel::methods::{ApiMethod, MethodCtx};
use librarium_kernel::registry::{DuplicateId, Registry};
use librarium_kernel::writer::Lane;
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeSet;
use std::sync::Arc;

pub const ID: &str = "notes";
pub const KIND: &str = "note";
/// Mirrors the note's subfolder inside `notes/`.
pub const FOLDER_FIELD: &str = "notes.folder";

pub fn contribute_kinds(k: &mut Kinds) -> Result<(), DuplicateId> {
    k.add(
        ID,
        RecordKindDef {
            kind: KIND.into(),
            version: 1,
            format: Format::Markdown,
            folder: "notes".into(),
            slugged: true,
            subfolder_field: Some(FOLDER_FIELD.into()),
        },
    )
}

#[derive(Deserialize)]
struct CreateParams {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    folder: Option<String>,
    #[serde(default)]
    body: String,
}

pub fn contribute_methods(r: &mut Registry<ApiMethod>) -> Result<(), DuplicateId> {
    r.add(
        ID,
        "notes.create",
        Arc::new(|ctx: &MethodCtx, p: Value| {
            let p: CreateParams = serde_json::from_value(p).map_err(|e| BackendError::invalid(e.to_string()))?;
            Ok(serde_json::to_value(create(ctx, p.title.as_deref().unwrap_or(""), p.folder.as_deref(), &p.body)?)
                .unwrap())
        }),
    )?;
    r.add(ID, "notes.folders", Arc::new(|ctx: &MethodCtx, _p: Value| Ok(serde_json::to_value(folders(ctx)).unwrap())))?;
    Ok(())
}

/// Creates a note; an empty title becomes "Untitled".
pub fn create(ctx: &MethodCtx, title: &str, folder: Option<&str>, body: &str) -> Result<Written> {
    let title = if title.trim().is_empty() { "Untitled".to_string() } else { title.to_string() };
    let folder = folder.map(|f| f.trim_matches('/').to_string()).filter(|f| !f.is_empty());
    let body = body.to_string();
    let (e, seq) =
        ctx.library.write(Lane::Interactive, move |tx| tx.create(KIND, &title, vec![], &body, folder.as_deref()))?;
    Ok(Written { info: e.info(), seq })
}

/// Every folder holding notes, from their paths (the path is the truth).
pub fn folders(ctx: &MethodCtx) -> Vec<String> {
    let mut out = BTreeSet::new();
    for e in ctx.library.store.list(Some(KIND)) {
        let parts: Vec<&str> = e.path.split('/').collect();
        for i in 2..parts.len() {
            out.insert(parts[1..i].join("/"));
        }
    }
    out.into_iter().collect()
}
