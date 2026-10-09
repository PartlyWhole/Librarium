//! Archiving, and deleting in two steps. Archiving sets `archive.at` and leaves the file where
//! it is, so links and IDs keep working; lists and search hide it. Only archived records can be
//! deleted permanently, and only with a token from `prepare_delete` that the user's explicit
//! confirmation sends back to `delete`. Tokens are single-use, bound to the versions shown,
//! and expire.

use crate::error::{Error, Result};
use crate::index::is_archived;
use crate::store::frontmatter::FmValue;
use crate::store::{record, relocate, save, Library};
use crate::types::{Deleted, DeletionPreview, DeletionRecord, Skipped, Written};
use crate::util::{iso_utc, new_id, now_ms, Id};

pub const AT: &str = "archive.at";
/// How long a confirmation stays valid.
const CONFIRM_TTL_MS: i64 = 5 * 60 * 1000;

/// What a deletion token covers: each record at the version shown.
pub struct Confirmation {
    records: Vec<(Id, String)>,
    expires_ms: i64,
}

fn set(lib: &Library, id: Id, base_version: Option<&str>, v: Option<FmValue>) -> Result<Written> {
    let w = lib.write();
    let e = save::set_fields(&w, id, base_version, &[(AT.into(), v)])?;
    Ok(Written { info: record::info(lib, &e), seq: w.seq() })
}

/// Step one of deleting, and undoable: sets `archive.at`.
pub fn archive(lib: &Library, id: Id, base_version: Option<&str>) -> Result<Written> {
    set(lib, id, base_version, Some(FmValue::Str(iso_utc(now_ms()))))
}

pub fn restore(lib: &Library, id: Id, base_version: Option<&str>) -> Result<Written> {
    set(lib, id, base_version, None)
}

/// Says exactly what would be deleted, and returns a token for the user's confirmation.
pub fn prepare_delete(lib: &Library, ids: &[Id]) -> Result<DeletionPreview> {
    if ids.is_empty() {
        return Err(Error::invalid("Nothing to delete."));
    }
    let mut records = vec![];
    for &id in ids {
        let e = lib.index.get(id).ok_or_else(|| Error::not_found("That record can’t be found."))?;
        if !is_archived(&e.fields) {
            return Err(Error::invalid("Archive it first: only archived records can be deleted permanently."));
        }
        let (files, _) = relocate::deletion_plan(lib, &e);
        records.push(DeletionRecord { id, title: e.title, kind: e.kind, version: e.hash, files });
    }
    let now = now_ms();
    let token = new_id().to_string();
    let expires_ms = now + CONFIRM_TTL_MS;
    let mut pending = lib.confirmations.lock().unwrap();
    pending.retain(|_, c| c.expires_ms > now);
    let covered = records.iter().map(|r| (r.id, r.version.clone())).collect();
    pending.insert(token.clone(), Confirmation { records: covered, expires_ms });
    let files = records.iter().map(|r| r.files.len() as u64).sum();
    Ok(DeletionPreview { token, records, files, expires_ms })
}

/// Step two: deletes what the confirmed token covers, if each record is still archived and
/// unchanged. The token is used up either way.
pub fn delete(lib: &Library, token: &str) -> Result<Deleted> {
    let c = lib.confirmations.lock().unwrap().remove(token);
    let c = c.filter(|c| c.expires_ms > now_ms());
    let c = c.ok_or_else(|| Error::invalid("That confirmation has expired. Nothing was deleted."))?;
    let mut out = Deleted::default();
    let w = lib.write();
    for (id, version) in c.records {
        let archived = lib.index.get(id).is_some_and(|e| is_archived(&e.fields));
        let r = if archived {
            relocate::delete_permanently(&w, id, &version)
        } else {
            Err(Error::invalid("it is no longer archived"))
        };
        match r {
            Ok(()) => out.deleted.push(id),
            Err(e) => out.skipped.push(Skipped { id, reason: e.message }),
        }
    }
    Ok(out)
}
