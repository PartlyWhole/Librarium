//! The user's folders: plain directories under `notes/` (shared by notes and boards) and
//! `items/`. The disk is the truth: a folder exists while its directory does, even empty.
//! The order the user arranged things in is kept in `.librarium/order.json`.

use super::frontmatter::FmValue;
use super::record::{self, kind, subfolder_of, Kind, KINDS};
use super::write::{rename_exclusive, safe_write, sync_dir, write_intent, Intent};
use super::{Library, Write};
use crate::error::{Context, Error, Result};
use crate::types::{FolderSpace, FoldersList};
use crate::util::{json_bytes, parse_id, Id};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;

pub const ORDER_FILE: &str = ".librarium/order.json";
/// Files the system leaves in folders; they never keep a folder from being removed.
const LITTER: &[&str] = &[".DS_Store", ".localized"];

/// One space's arrangement: `{ folder: [record ID or "folder:<name>", …] }`.
type Order = BTreeMap<String, Vec<String>>;

/// Checks a folder path given by the user: `/`-separated names, none empty, padded, hidden,
/// over 200 bytes, holding `\`, `:` or control characters, or starting with a UUID.
pub fn clean_folder(path: &str) -> Result<String> {
    let p = path.trim().trim_matches('/');
    if p.is_empty() {
        return Err(Error::invalid("A folder needs a name."));
    }
    for part in p.split('/') {
        let bad = part.is_empty()
            || part.trim() != part
            || part.starts_with('.')
            || part.contains(['\\', ':'])
            || part.chars().any(char::is_control)
            || part.get(..36).and_then(parse_id).is_some();
        if bad {
            return Err(Error::invalid(format!("“{part}” can’t be a folder name.")));
        }
        if part.len() > 200 {
            return Err(Error::invalid("That folder name is too long."));
        }
    }
    Ok(p.to_string())
}

fn name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn parent(path: &str) -> &str {
    path.rsplit_once('/').map(|(p, _)| p).unwrap_or("")
}

/// A folder's entry in its parent's order.
pub fn folder_key(path: &str) -> String {
    format!("folder:{}", name(path))
}

/// The kind kept in folders, by name (boards included).
fn foldered(kind_name: &str) -> Result<&'static Kind> {
    kind(kind_name)
        .filter(|k| k.folder_field.is_some())
        .ok_or_else(|| Error::invalid(format!("“{kind_name}” records aren’t kept in folders.")))
}

/// Every kind kept in a folder space, its primary first.
fn space_kinds(k: &Kind) -> Vec<&'static Kind> {
    KINDS.iter().filter(|o| o.folder == k.folder).collect()
}

fn all_orders(lib: &Library) -> BTreeMap<String, Order> {
    fs::read(lib.root.join(ORDER_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// The records kept in a space's folders.
fn space_records(lib: &Library, k: &Kind) -> Result<Vec<record::Entry>> {
    let kinds: Vec<&str> = space_kinds(k).iter().map(|k| k.name).collect();
    Ok(lib.index.list(None)?.into_iter().filter(|e| kinds.contains(&e.kind.as_str())).collect())
}

/// Every folder of a space, from the disk (empty ones too) and records' paths, sorted.
fn folders_of(lib: &Library, k: &Kind) -> Result<Vec<String>> {
    let mut out = BTreeSet::new();
    let mut stack = vec![(lib.root.join(k.folder), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        for e in fs::read_dir(&dir).into_iter().flatten().flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            let p = e.path();
            if n.starts_with('.') || !p.is_dir() {
                continue;
            }
            if k.json && (n.get(..36).and_then(parse_id).is_some() || p.join("record.json").exists()) {
                continue;
            }
            let r = if rel.is_empty() { n } else { format!("{rel}/{n}") };
            out.insert(r.clone());
            stack.push((p, r));
        }
    }
    for e in space_records(lib, k)? {
        if let Some(sub) = subfolder_of(k, &e.path).filter(|s| !s.is_empty()) {
            let parts: Vec<&str> = sub.split('/').collect();
            out.extend((1..=parts.len()).map(|i| parts[..i].join("/")));
        }
    }
    Ok(out.into_iter().collect())
}

pub fn list(lib: &Library) -> Result<FoldersList> {
    let mut orders = all_orders(lib);
    let mut spaces = vec![];
    for k in KINDS.iter().filter(|k| k.folder_field.is_some() && space_kinds(k)[0] == *k) {
        spaces.push(FolderSpace {
            kind: k.name.into(),
            kinds: space_kinds(k).iter().map(|k| k.name.to_string()).collect(),
            folders: folders_of(lib, k)?,
            order: orders.remove(k.folder).unwrap_or_default(),
        });
    }
    Ok(FoldersList { spaces })
}

fn exists(lib: &Library, k: &Kind, path: &str) -> bool {
    lib.root.join(k.folder).join(path).is_dir()
}

/// Makes a new, empty folder.
pub fn create(w: &Write, kind_name: &str, path: &str) -> Result<String> {
    let k = foldered(kind_name)?;
    let path = clean_folder(path)?;
    if exists(w.lib, k, &path) {
        return Err(Error::conflict(format!("There’s already a folder called “{}” there.", name(&path))));
    }
    let dir = w.lib.root.join(k.folder).join(&path);
    fs::create_dir_all(&dir).ctx("making the folder")?;
    let _ = sync_dir(dir.parent().unwrap());
    Ok(path)
}

/// Moves or renames a folder with everything in it, as an intent. Refuses to merge into an
/// existing folder. Returns how many records moved.
pub fn move_folder(w: &Write, kind_name: &str, from: &str, to: &str) -> Result<usize> {
    let k = foldered(kind_name)?;
    let (from, to) = (clean_folder(from)?, clean_folder(to)?);
    if from == to {
        return Ok(0);
    }
    if to.starts_with(&format!("{from}/")) {
        return Err(Error::invalid(format!("“{}” can’t go inside itself.", name(&from))));
    }
    if !exists(w.lib, k, &from) {
        return Err(Error::not_found(format!("There’s no folder “{}” any more.", name(&from))));
    }
    if exists(w.lib, k, &to) {
        return Err(Error::conflict(format!("There’s already a folder called “{}” there.", name(&to))));
    }
    let intent = Intent::MoveFolder { kind: kind_name.into(), from: from.clone(), to: to.clone() };
    let p = write_intent(&w.lib.app_dir, &intent)?;
    let moved = apply_move(w, kind_name, &from, &to)?;
    let _ = fs::remove_file(p);
    Ok(moved)
}

/// Carries out a folder move; redone at start, it finishes what is left.
pub(crate) fn apply_move(w: &Write, kind_name: &str, from: &str, to: &str) -> Result<usize> {
    let lib = w.lib;
    let k = foldered(kind_name)?;
    let (a, b) = (lib.root.join(k.folder).join(from), lib.root.join(k.folder).join(to));
    if a.exists() && !b.exists() {
        fs::create_dir_all(b.parent().unwrap()).ctx("making the folder")?;
        rename_exclusive(&a, &b).ctx("moving the folder")?;
        let _ = sync_dir(b.parent().unwrap());
        let _ = sync_dir(a.parent().unwrap());
    }
    // The index follows the files, then each record's folder field follows its path.
    let (old, new) = (format!("{}/{from}/", k.folder), format!("{}/{to}/", k.folder));
    let mut moved = 0;
    for mut e in space_records(lib, k)? {
        if let Some(rest) = e.path.strip_prefix(&old) {
            let path = format!("{new}{rest}");
            if lib.root.join(&path).exists() {
                lib.index.set_path(e.id, &path)?;
                e.path = path;
                moved += 1;
            }
        }
        if !e.path.starts_with(&new) {
            continue;
        }
        let field = k.folder_field.unwrap_or_default();
        let sub = subfolder_of(k, &e.path).filter(|s| !s.is_empty());
        if e.fields.get(field) != sub.clone().map(Value::String).as_ref() && e.read_only.is_none() {
            record::rewrite_fields(w, &e, &[(field.into(), sub.map(FmValue::Str))], true)?;
        } else {
            w.changed(e.id);
        }
    }
    change_order(w, k, |order| {
        let under = |key: &str| key == from || key.starts_with(&format!("{from}/"));
        let keys: Vec<String> = order.keys().filter(|key| under(key)).cloned().collect();
        for key in keys {
            if let Some(v) = order.remove(&key) {
                order.insert(format!("{to}{}", &key[from.len()..]), v);
            }
        }
        // Its place among its siblings: kept when renamed in place, dropped when moved away.
        if let Some(list) = order.get_mut(parent(from)) {
            if let Some(i) = list.iter().position(|e| *e == folder_key(from)) {
                if parent(from) == parent(to) {
                    list[i] = folder_key(to);
                } else {
                    list.remove(i);
                }
            }
        }
    })?;
    Ok(moved)
}

/// Removes an empty folder. Refuses while records (archived ones too) or other files are in
/// it; the system's litter doesn't count.
pub fn remove(w: &Write, kind_name: &str, path: &str) -> Result<()> {
    let lib = w.lib;
    let k = foldered(kind_name)?;
    let path = clean_folder(path)?;
    let prefix = format!("{}/{path}/", k.folder);
    let n = space_records(lib, k)?.iter().filter(|e| e.path.starts_with(&prefix)).count();
    if n > 0 {
        let what = if n == 1 { "item" } else { "items" };
        return Err(Error::conflict(format!(
            "“{}” isn’t empty: it holds {n} {what} (archived ones count too).",
            name(&path)
        )));
    }
    let (mut dirs, mut litter) = (vec![], vec![]);
    let mut stack = vec![lib.root.join(k.folder).join(&path)];
    while let Some(d) = stack.pop() {
        for e in fs::read_dir(&d).ctx("reading the folder")?.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if e.path().is_dir() {
                stack.push(e.path());
            } else if LITTER.contains(&n.as_str()) {
                litter.push(e.path());
            } else {
                return Err(Error::conflict(format!(
                    "“{}” holds other files (such as “{n}”), so it was left as it is.",
                    name(&path)
                )));
            }
        }
        dirs.push(d);
    }
    for f in litter {
        let _ = fs::remove_file(f);
    }
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    for d in &dirs {
        fs::remove_dir(d).ctx("removing the folder")?;
    }
    if let Some(p) = dirs.last().and_then(|d| d.parent()) {
        let _ = sync_dir(p);
    }
    change_order(w, k, |order| {
        order.retain(|key, _| key != &path && !key.starts_with(&format!("{path}/")));
        if let Some(list) = order.get_mut(parent(&path)) {
            list.retain(|e| *e != folder_key(&path));
        }
    })
}

/// Keeps the order the user arranged a folder in (`""`: the top level).
pub fn set_order(w: &Write, kind_name: &str, path: &str, entries: Vec<String>) -> Result<()> {
    let k = foldered(kind_name)?;
    let path = if path.trim_matches('/').is_empty() { String::new() } else { clean_folder(path)? };
    if entries.len() > 100_000 || entries.iter().any(|e| e.len() > 300) {
        return Err(Error::invalid("That order is too long."));
    }
    let mut seen = BTreeSet::new();
    let entries: Vec<String> = entries.into_iter().filter(|e| seen.insert(e.clone())).collect();
    change_order(w, k, move |order| {
        if entries.is_empty() {
            order.remove(&path);
        } else {
            order.insert(path, entries);
        }
    })
}

/// Changes one space's arrangement, writing the file only if something changed.
fn change_order(w: &Write, k: &Kind, f: impl FnOnce(&mut Order)) -> Result<()> {
    let mut all = all_orders(w.lib);
    let before = all.clone();
    let order = all.entry(k.folder.to_string()).or_default();
    f(order);
    if order.is_empty() {
        all.remove(k.folder);
    }
    if all == before {
        return Ok(());
    }
    let p = w.lib.root.join(ORDER_FILE);
    fs::create_dir_all(p.parent().unwrap()).ctx("making .librarium")?;
    let v = serde_json::to_value(&all)?;
    safe_write(&p, &json_bytes(&v, true), false).ctx("keeping the order")
}

/// Moves a record into one of its kind's folders (`None`: the top level).
pub fn move_to_folder(w: &Write, id: Id, folder: Option<&str>) -> Result<record::Entry> {
    let folder = folder.map(clean_folder).transpose()?;
    record::relocate(w, id, None, None, Some(folder.as_deref()))
}
