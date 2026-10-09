//! Removing older snapshots of saved web pages, in two steps like permanent deletion:
//! `prepare` lists exactly what would go and returns a single-use token bound to each item's
//! version; only the user's confirmation sends it back to `remove`. An item always keeps at
//! least one snapshot, and a snapshot a capture was made from is never removed.

use super::{item, SNAPSHOT, SNAPSHOTS};
use crate::error::{Error, Result};
use crate::store::frontmatter::FmValue;
use crate::store::record::Entry;
use crate::store::{files, save, Library};
use crate::types::{ProtectedSnapshot, RemovalItem, RemovalPreview, Skipped, SnapshotRequest, SnapshotsRemoved};
use crate::util::{new_id, now_ms, Id};
use serde_json::Value;
use std::collections::HashMap;

/// How long a confirmation stays valid.
const CONFIRM_TTL_MS: i64 = 5 * 60 * 1000;

/// What a token covers: for each item, its version when shown and the snapshots to remove.
pub struct Pending {
    items: Vec<(Id, String, Vec<String>)>,
    expires_ms: i64,
}

fn snapshots_of(e: &Entry) -> Vec<Value> {
    e.fields.get(SNAPSHOTS).and_then(Value::as_array).cloned().unwrap_or_default()
}

/// Step one: what would be removed, and a token for the user's confirmation.
pub fn prepare(lib: &Library, reqs: &[SnapshotRequest]) -> Result<RemovalPreview> {
    let mut items = vec![];
    let mut covered = vec![];
    let mut count = 0;
    for r in reqs {
        let e = item(lib, r.id)?;
        let all: Vec<String> = snapshots_of(&e).iter().filter_map(|s| s["at"].as_str().map(String::from)).collect();
        if all.is_empty() {
            return Err(Error::invalid("Only saved web pages have snapshots."));
        }
        let wanted: Vec<&String> = match &r.snapshots {
            Some(list) => all.iter().filter(|a| list.contains(a)).collect(),
            None => all.iter().take(all.len() - 1).collect(),
        };
        let mut users: HashMap<String, Vec<String>> = HashMap::new();
        for (at, capture) in crate::captures::snapshots_in_use(lib, r.id) {
            let title = lib.index.get(capture).map(|c| c.title).unwrap_or_default();
            users.entry(at).or_default().push(title);
        }
        let mut remove: Vec<String> =
            wanted.iter().filter(|a| !users.contains_key(**a)).map(|a| a.to_string()).collect();
        // Always keep one: if everything would go, the latest stays.
        if remove.len() == all.len() {
            remove.retain(|a| Some(a) != all.last());
        }
        let protected = wanted
            .iter()
            .filter_map(|a| users.get(*a).map(|by| ProtectedSnapshot { at: a.to_string(), by: by.clone() }))
            .collect();
        count += remove.len() as u64;
        let kept = (all.len() - remove.len()) as u64;
        if !remove.is_empty() {
            covered.push((r.id, e.hash.clone(), remove.clone()));
        }
        items.push(RemovalItem { id: r.id, title: e.title, remove, protected, kept });
    }
    let now = now_ms();
    let token = new_id().to_string();
    let mut pending = lib.removals.lock().unwrap();
    pending.retain(|_, p| p.expires_ms > now);
    pending.insert(token.clone(), Pending { items: covered, expires_ms: now + CONFIRM_TTL_MS });
    Ok(RemovalPreview { token, count, items })
}

/// Step two: removes what the confirmed token covers, from items unchanged since. The token is
/// used up either way. Not undoable.
pub fn remove(lib: &Library, token: &str) -> Result<SnapshotsRemoved> {
    let p = lib.removals.lock().unwrap().remove(token).filter(|p| p.expires_ms > now_ms());
    let p = p.ok_or_else(|| Error::invalid("That confirmation has expired. Nothing was removed."))?;
    let mut out = SnapshotsRemoved { removed: 0, skipped: vec![] };
    for (id, version, gone) in p.items {
        match remove_from(lib, id, &version, gone) {
            Ok(n) => out.removed += n as u64,
            Err(e) => out.skipped.push(Skipped { id, reason: e.message }),
        }
    }
    Ok(out)
}

fn remove_from(lib: &Library, id: Id, version: &str, gone: Vec<String>) -> Result<usize> {
    let w = lib.write();
    let e = item(lib, id)?;
    if e.hash != version {
        return Err(Error::conflict("It changed since you confirmed."));
    }
    // A capture may have been made from one of them since: that one stays.
    let used: Vec<String> = crate::captures::snapshots_in_use(lib, id).into_iter().map(|(at, _)| at).collect();
    let gone: Vec<String> = gone.into_iter().filter(|a| !used.contains(a) && !a.contains(['/', '.'])).collect();
    let keep: Vec<Value> = snapshots_of(&e)
        .into_iter()
        .filter(|s| !s["at"].as_str().is_some_and(|a| gone.iter().any(|g| g == a)))
        .collect();
    let latest = keep.last().and_then(|s| s["at"].as_str()).map(String::from);
    let latest = latest.ok_or_else(|| Error::invalid("A page keeps at least one snapshot."))?;
    let current = e.field_str(SNAPSHOT).filter(|c| !gone.iter().any(|g| g == c)).map(String::from).unwrap_or(latest);
    // record.json first: once it no longer lists them, the folders are only leftovers.
    let edits = [
        (SNAPSHOTS.to_string(), Some(FmValue::Other(Value::Array(keep)))),
        (SNAPSHOT.to_string(), Some(FmValue::Str(current))),
    ];
    let e = save::set_fields(&w, id, Some(version), &edits)?;
    for at in &gone {
        files::remove_item_dir(&w, &e, &format!("snapshots/{at}"))?;
    }
    Ok(gone.len())
}
