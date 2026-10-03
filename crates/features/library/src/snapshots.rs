//! Removing snapshots of saved web pages. Like permanent deletion, it is two steps:
//! `library.removeSnapshots.prepare` lists exactly what would go and returns a single-use token
//! bound to each item's version; only the user's explicit confirmation sends it back to
//! `library.removeSnapshots`. An item always keeps at least one snapshot, and a snapshot that
//! another record uses (a capture made from it, through `kernel.part-users`) is never removed.

use crate::{KIND, SNAPSHOT, SNAPSHOTS};
use librarium_contracts::{BackendError, Id, Result};
use librarium_kernel::frontmatter::FmValue;
use librarium_kernel::methods::MethodCtx;
use librarium_kernel::store::remove_tree;
use librarium_kernel::writer::Lane;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// How long a confirmation stays valid.
pub const CONFIRM_TTL_MS: i64 = 5 * 60 * 1000;

#[derive(Deserialize)]
pub struct Request {
    pub id: Id,
    /// The snapshots to remove; omitted, all but the latest.
    #[serde(default)]
    pub snapshots: Option<Vec<String>>,
}

struct Pending {
    root: String,
    items: Vec<(Id, String, Vec<String>)>,
    expires_ms: i64,
}

fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    static P: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
    P.get_or_init(Default::default)
}

fn snapshots_of(e: &librarium_kernel::store::Entry) -> Vec<Value> {
    e.fields.get(SNAPSHOTS).and_then(|v| v.as_array()).cloned().unwrap_or_default()
}

/// Step one: what would be removed, and a token for the user's confirmation.
pub fn prepare(ctx: &MethodCtx, reqs: &[Request]) -> Result<Value> {
    let store = &ctx.library.store;
    let mut items = vec![];
    let mut covered = vec![];
    let mut total = 0;
    for r in reqs {
        let e = store.get(r.id).ok_or_else(|| BackendError::not_found("that item can't be found"))?;
        if e.kind != KIND {
            return Err(BackendError::invalid("only saved web pages have snapshots"));
        }
        let all: Vec<String> = snapshots_of(&e).iter().filter_map(|s| s["at"].as_str().map(str::to_string)).collect();
        let wanted: Vec<String> = match &r.snapshots {
            Some(list) => all.iter().filter(|a| list.contains(a)).cloned().collect(),
            None => all.iter().take(all.len().saturating_sub(1)).cloned().collect(),
        };
        // Parts other records use, with who uses them.
        let mut users: HashMap<String, Vec<String>> = HashMap::new();
        for (part, user) in store.kinds.parts_in_use(store, r.id) {
            let title = store.get(user).map(|u| u.title).unwrap_or_default();
            users.entry(part).or_default().push(title);
        }
        let mut remove: Vec<String> = wanted.iter().filter(|a| !users.contains_key(*a)).cloned().collect();
        // Always keep one: if everything would go, the latest stays.
        if remove.len() == all.len() {
            remove.retain(|a| Some(a) != all.last());
        }
        let protected: Vec<Value> =
            wanted.iter().filter_map(|a| users.get(a).map(|by| json!({ "at": a, "by": by }))).collect();
        total += remove.len();
        items.push(json!({ "id": r.id, "title": e.title, "remove": remove, "protected": protected, "kept": all.len() - remove.len() }));
        if !remove.is_empty() {
            covered.push((r.id, e.hash.clone(), remove));
        }
    }
    let now = store.clock.now_ms();
    let token = store.ids.next_id().to_string();
    let mut p = pending().lock().unwrap();
    p.retain(|_, x| x.expires_ms > now);
    p.insert(
        token.clone(),
        Pending { root: store.root.display().to_string(), items: covered, expires_ms: now + CONFIRM_TTL_MS },
    );
    Ok(json!({ "token": token, "items": items, "count": total }))
}

/// Step two: removes what the confirmed token covers, from items that haven't changed since.
pub fn remove(ctx: &MethodCtx, token: &str) -> Result<Value> {
    let store = &ctx.library.store;
    let p = pending().lock().unwrap().remove(token);
    let p = match p {
        Some(p) if p.expires_ms > store.clock.now_ms() && p.root == store.root.display().to_string() => p,
        _ => return Err(BackendError::invalid("That confirmation has expired. Nothing was removed.")),
    };
    let mut removed = 0;
    let mut skipped = vec![];
    for (id, version, gone) in p.items {
        let r = ctx.library.write(Lane::Interactive, move |tx| -> Result<usize> {
            let s = tx.store;
            let e = s.get(id).ok_or_else(|| BackendError::not_found("the item is gone"))?;
            if e.hash != version {
                return Err(BackendError::conflict("it changed since you confirmed"));
            }
            // A capture may have been made from one of them since: it stays.
            let used: Vec<String> = s.kinds.parts_in_use(s, id).into_iter().map(|(part, _)| part).collect();
            let gone: Vec<String> = gone.into_iter().filter(|a| !used.contains(a)).collect();
            let keep: Vec<Value> = snapshots_of(&e)
                .into_iter()
                .filter(|x| !x["at"].as_str().is_some_and(|a| gone.iter().any(|g| g == a)))
                .collect();
            let Some(latest) = keep.last().and_then(|x| x["at"].as_str()).map(str::to_string) else {
                return Err(BackendError::invalid("an item keeps at least one snapshot"));
            };
            let current = e.field_str(SNAPSHOT).map(str::to_string);
            let current = current.filter(|c| !gone.contains(c)).unwrap_or(latest);
            // record.json first: once it no longer lists them, the folders are just leftovers.
            tx.set_fields(
                id,
                Some(&version),
                &[
                    (SNAPSHOTS.into(), Some(FmValue::Other(Value::Array(keep)))),
                    (SNAPSHOT.into(), Some(FmValue::Str(current))),
                ],
            )?;
            let dir = s.record_dir(&e).join("snapshots");
            for at in &gone {
                if !at.is_empty() && !at.contains('/') && !at.contains("..") {
                    let _ = remove_tree(&*s.fs, &dir.join(at));
                }
            }
            Ok(gone.len())
        });
        match r {
            Ok(n) => removed += n,
            Err(e) => skipped.push(json!({ "id": id, "reason": e.message })),
        }
    }
    Ok(json!({ "removed": removed, "skipped": skipped }))
}
