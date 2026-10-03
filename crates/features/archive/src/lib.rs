//! Archive: deleting is two steps (BRIEF §6). Archiving sets `archive.at` and leaves the file
//! where it is, so links, captures and the ID keep working; lists and search hide it. Restoring
//! removes the field. Permanent deletion is allowed only for archived records, and only with a
//! confirmation token from `archive.prepareDelete` that the user's explicit confirmation sends
//! back to `archive.delete`. Tokens are single-use, bound to the versions shown, and expire.

use librarium_contracts::api::Written;
use librarium_contracts::{BackendError, Id, Result};
use librarium_kernel::frontmatter::FmValue;
use librarium_kernel::methods::{ApiMethod, MethodCtx};
use librarium_kernel::registry::{DuplicateId, Registry};
use librarium_kernel::writer::Lane;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub const ID: &str = "archive";
/// When the record was archived (UTC, ISO 8601). Its presence is what "archived" means.
pub const AT: &str = "archive.at";
/// How long a confirmation stays valid.
pub const CONFIRM_TTL_MS: i64 = 5 * 60 * 1000;

#[derive(Deserialize)]
struct One {
    id: Id,
    #[serde(default)]
    base_version: Option<String>,
}

#[derive(Deserialize)]
struct Many {
    ids: Vec<Id>,
}

#[derive(Deserialize)]
struct Confirm {
    token: String,
}

/// What a confirmation covers: (library root, [(record, version)]), and when it expires.
struct Pending {
    root: String,
    records: Vec<(Id, String)>,
    expires_ms: i64,
}

fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    static P: std::sync::OnceLock<Mutex<HashMap<String, Pending>>> = std::sync::OnceLock::new();
    P.get_or_init(Default::default)
}

#[derive(Serialize, Debug)]
pub struct DeletionPreview {
    pub token: String,
    pub records: Vec<Value>,
    pub files: usize,
    pub expires_ms: i64,
}

#[derive(Serialize, Debug, Default)]
pub struct Deleted {
    pub deleted: Vec<Id>,
    pub skipped: Vec<Value>,
}

fn invalid(e: impl std::fmt::Display) -> BackendError {
    BackendError::invalid(e.to_string())
}

fn is_archived(ctx: &MethodCtx, id: Id) -> Result<bool> {
    let e = ctx.library.store.get(id).ok_or_else(|| BackendError::not_found("that record can't be found"))?;
    Ok(e.fields.get(AT).is_some_and(|v| !v.is_null()))
}

/// Step one of deleting: archives a record (with an undo that restores it).
pub fn archive(ctx: &MethodCtx, id: Id, base_version: Option<String>) -> Result<Written> {
    let at = librarium_kernel::time::iso_utc(ctx.library.store.clock.now_ms());
    set(ctx, id, base_version, Some(FmValue::Str(at)))
}

pub fn restore(ctx: &MethodCtx, id: Id, base_version: Option<String>) -> Result<Written> {
    set(ctx, id, base_version, None)
}

fn set(ctx: &MethodCtx, id: Id, base_version: Option<String>, v: Option<FmValue>) -> Result<Written> {
    ctx.library.store.wait_ready();
    let (e, seq) = ctx
        .library
        .write(Lane::Interactive, move |tx| tx.set_fields(id, base_version.as_deref(), &[(AT.to_string(), v)]))?;
    Ok(Written { info: e.info(), seq })
}

/// Archived records, most recently archived first.
pub fn list(ctx: &MethodCtx) -> Vec<Value> {
    let mut v: Vec<_> = ctx
        .library
        .store
        .list(None)
        .into_iter()
        .filter(|e| e.fields.get(AT).is_some_and(|v| !v.is_null()))
        .map(|e| serde_json::to_value(e.info()).unwrap())
        .collect();
    v.sort_by(|a, b| b["fields"][AT].as_str().cmp(&a["fields"][AT].as_str()));
    v
}

/// Shows exactly what would be deleted and returns a token for the user's confirmation.
/// Refuses records that aren't archived: archiving is always the first step.
pub fn prepare_delete(ctx: &MethodCtx, ids: &[Id]) -> Result<DeletionPreview> {
    if ids.is_empty() {
        return Err(invalid("nothing to delete"));
    }
    let store = &ctx.library.store;
    let mut records = vec![];
    let mut covered = vec![];
    let mut files = 0;
    for &id in ids {
        if !is_archived(ctx, id)? {
            return Err(invalid("Archive it first: only archived records can be deleted permanently."));
        }
        let e = store.get(id).unwrap();
        let (f, _) = ctx.library.write(Lane::Interactive, move |tx| tx.deletion_plan(id))?;
        files += f.len();
        records.push(json!({ "id": id, "title": e.title, "kind": e.kind, "version": e.hash, "files": f }));
        covered.push((id, e.hash.clone()));
    }
    let now = store.clock.now_ms();
    let token = store.ids.next_id().to_string();
    let mut p = pending().lock().unwrap();
    p.retain(|_, x| x.expires_ms > now);
    let expires_ms = now + CONFIRM_TTL_MS;
    p.insert(token.clone(), Pending { root: store.root.display().to_string(), records: covered, expires_ms });
    Ok(DeletionPreview { token, records, files, expires_ms })
}

/// Step two: deletes what the confirmed token covers, if each record is still archived and
/// unchanged. The token is used up either way.
pub fn delete(ctx: &MethodCtx, token: &str) -> Result<Deleted> {
    let store = &ctx.library.store;
    let p = pending().lock().unwrap().remove(token);
    let p = match p {
        Some(p) if p.expires_ms > store.clock.now_ms() && p.root == store.root.display().to_string() => p,
        _ => return Err(invalid("That confirmation has expired. Nothing was deleted.")),
    };
    let mut out = Deleted::default();
    for (id, version) in p.records {
        if !is_archived(ctx, id).unwrap_or(false) {
            out.skipped.push(json!({ "id": id, "reason": "it is no longer archived" }));
            continue;
        }
        match ctx.library.write(Lane::Interactive, move |tx| tx.delete_permanently(id, &version)) {
            Ok(_) => out.deleted.push(id),
            Err(e) => out.skipped.push(json!({ "id": id, "reason": e.message })),
        }
    }
    Ok(out)
}

pub fn contribute_methods(r: &mut Registry<ApiMethod>) -> Result<(), DuplicateId> {
    r.add(
        ID,
        "archive.archive",
        Arc::new(|ctx: &MethodCtx, p: Value| {
            let p: One = serde_json::from_value(p).map_err(invalid)?;
            Ok(serde_json::to_value(archive(ctx, p.id, p.base_version)?).unwrap())
        }),
    )?;
    r.add(
        ID,
        "archive.restore",
        Arc::new(|ctx: &MethodCtx, p: Value| {
            let p: One = serde_json::from_value(p).map_err(invalid)?;
            Ok(serde_json::to_value(restore(ctx, p.id, p.base_version)?).unwrap())
        }),
    )?;
    r.add(ID, "archive.list", Arc::new(|ctx: &MethodCtx, _p: Value| Ok(Value::Array(list(ctx)))))?;
    r.add(
        ID,
        "archive.prepareDelete",
        Arc::new(|ctx: &MethodCtx, p: Value| {
            let p: Many = serde_json::from_value(p).map_err(invalid)?;
            Ok(serde_json::to_value(prepare_delete(ctx, &p.ids)?).unwrap())
        }),
    )?;
    r.add(
        ID,
        "archive.delete",
        Arc::new(|ctx: &MethodCtx, p: Value| {
            let p: Confirm = serde_json::from_value(p).map_err(invalid)?;
            Ok(serde_json::to_value(delete(ctx, &p.token)?).unwrap())
        }),
    )?;
    Ok(())
}
