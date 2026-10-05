//! The user's folders. A kind that names a subfolder field (notes, library items) keeps its
//! records in subfolders of its own top folder, and each such kind has its own folders: notes'
//! folders are under `notes/`, the library's under `items/`. The disk is the truth: a folder
//! exists while a directory does, even an empty one.

use crate::frontmatter::FmValue;
use crate::kinds::{Format, RecordKindDef};
use crate::store::{rel_str, Entry, Intent, Store, Tx};
use librarium_contracts::events::{ChangeOp, ChangeOrigin};
use librarium_contracts::ports::Flush;
use librarium_contracts::{BackendError, Id, Result};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::Path;

/// Files the system leaves in folders, which never keep a folder from being removed.
const LITTER: &[&str] = &[".DS_Store", ".localized"];

/// Whether a directory name is a folder record's own (`<id>[-slug]`), not a user's folder.
fn is_record_dir_name(name: &str) -> bool {
    name.get(..36).is_some_and(|p| p.parse::<Id>().is_ok())
}

/// Checks a folder path given by the user: `/`-separated names, none empty, hidden or `..`,
/// and none that looks like a record's own folder.
pub fn clean_folder(path: &str) -> Result<String> {
    let p = path.trim().trim_matches('/').to_string();
    if p.is_empty() {
        return Err(BackendError::invalid("a folder needs a name"));
    }
    for part in p.split('/') {
        let t = part.trim();
        if t.is_empty() || t != part {
            return Err(BackendError::invalid(format!("“{part}” can’t be a folder name")));
        }
        if part.starts_with('.') || part.contains(['\\', ':']) || part.chars().any(char::is_control) {
            return Err(BackendError::invalid(format!("“{part}” can’t be a folder name")));
        }
        if part.len() > 200 {
            return Err(BackendError::invalid("that folder name is too long"));
        }
        if is_record_dir_name(part) {
            return Err(BackendError::invalid(format!("“{part}” looks like a record’s own folder")));
        }
    }
    Ok(p)
}

fn display(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Where the order the user arranged things in is kept: `{ kind's top folder: { folder:
/// [entry, …] } }`, a top level as `""`. An entry is a record's ID, or `folder:<name>` for a
/// folder inside. Anything not listed comes after, in the usual order. Losing it loses only
/// the arrangement.
pub const ORDER_FILE: &str = ".librarium/order.json";

/// The key a folder has in its parent's order.
pub fn folder_key(path: &str) -> String {
    format!("folder:{}", display(path))
}

/// One kind's arrangement: `{ folder: [entry, …] }`.
pub type FolderOrder = BTreeMap<String, Vec<String>>;
type AllOrders = BTreeMap<String, FolderOrder>;

fn parent(path: &str) -> &str {
    path.rsplit_once('/').map(|(p, _)| p).unwrap_or("")
}

impl Store {
    fn all_orders(&self) -> AllOrders {
        self.fs.read(&self.abs(ORDER_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    /// The order the user arranged each folder of a kind in.
    pub fn folder_order(&self, kind: &str) -> FolderOrder {
        let Ok(def) = self.foldered_kind(kind) else { return FolderOrder::new() };
        self.all_orders().remove(&def.folder).unwrap_or_default()
    }

    /// The kinds kept in the user's folders: one per top folder (its primary; kinds sharing it,
    /// like boards beside notes, are in [`Store::space_kinds`]).
    pub fn foldered(&self) -> Vec<RecordKindDef> {
        self.kinds
            .all()
            .filter(|d| {
                d.subfolder_field.is_some() && self.kinds.by_folder(&d.folder).is_some_and(|p| p.kind == d.kind)
            })
            .cloned()
            .collect()
    }

    /// A kind kept in folders, by name (a kind sharing another's folders included).
    pub fn foldered_kind(&self, kind: &str) -> Result<RecordKindDef> {
        self.kinds
            .all()
            .find(|d| d.kind == kind && d.subfolder_field.is_some())
            .cloned()
            .ok_or_else(|| BackendError::invalid(format!("“{kind}” records aren’t kept in folders")))
    }

    /// Every kind kept in the same folders as `def` (itself included, the primary first).
    pub fn space_kinds(&self, def: &RecordKindDef) -> Vec<String> {
        self.kinds.sharing(&def.folder).into_iter().map(|d| d.kind.clone()).collect()
    }

    /// The records of every kind kept in `def`'s folders.
    fn space_records(&self, def: &RecordKindDef) -> Vec<crate::store::Entry> {
        let kinds = self.space_kinds(def);
        self.list(None).into_iter().filter(|e| kinds.contains(&e.kind)).collect()
    }

    /// Every folder of a kind, from the disk (empty ones too) and from records' paths, sorted.
    pub fn folders(&self, kind: &str) -> Vec<String> {
        let Ok(def) = self.foldered_kind(kind) else { return vec![] };
        let mut out = BTreeSet::new();
        let top = self.abs(&def.folder);
        let mut stack = vec![(top, String::new())];
        while let Some((dir, rel)) = stack.pop() {
            for e in self.fs.list(&dir).unwrap_or_default() {
                if !e.is_dir || e.name.starts_with('.') {
                    continue;
                }
                let p = dir.join(&e.name);
                if def.format == Format::JsonDir
                    && (is_record_dir_name(&e.name) || self.fs.stat(&p.join("record.json")).ok().flatten().is_some())
                {
                    continue;
                }
                let r = if rel.is_empty() { e.name.clone() } else { format!("{rel}/{}", e.name) };
                out.insert(r.clone());
                stack.push((p, r));
            }
        }
        for e in self.space_records(&def) {
            if let Some(sub) = self.subfolder_of(&def, &e.path).filter(|s| !s.is_empty()) {
                let parts: Vec<&str> = sub.split('/').collect();
                for i in 1..=parts.len() {
                    out.insert(parts[..i].join("/"));
                }
            }
        }
        out.into_iter().collect()
    }

    /// Whether a kind has a folder.
    pub fn folder_exists(&self, def: &RecordKindDef, path: &str) -> bool {
        self.fs.stat(&self.abs(&format!("{}/{path}", def.folder))).ok().flatten().is_some_and(|m| m.is_dir)
    }

    /// Records inside a kind's folder (at any depth), of every kind kept there.
    pub fn records_in_folder(&self, def: &RecordKindDef, path: &str) -> Vec<Entry> {
        let prefix = format!("{}/{path}/", def.folder);
        self.space_records(def).into_iter().filter(|e| e.path.starts_with(&prefix)).collect()
    }
}

impl Tx<'_> {
    /// Makes a new, empty folder for a kind.
    pub fn create_folder(&self, kind: &str, path: &str) -> Result<String> {
        let s = self.store;
        let def = s.foldered_kind(kind)?;
        let path = clean_folder(path)?;
        if s.folder_exists(&def, &path) {
            return Err(BackendError::conflict(format!("There’s already a folder called “{}” there.", display(&path))));
        }
        let abs = s.abs(&format!("{}/{path}", def.folder));
        s.fs.create_dir_all(&abs).map_err(|e| io_error(e, "making the folder"))?;
        let _ = s.fs.flush_dir(abs.parent().unwrap(), self.dur.flush());
        Ok(path)
    }

    /// Moves or renames a folder with everything in it, as an intent. Refuses to merge into a
    /// folder that already exists. Returns how many records moved.
    pub fn move_folder(&self, kind: &str, from: &str, to: &str) -> Result<usize> {
        let s = self.store;
        let def = s.foldered_kind(kind)?;
        let (from, to) = (clean_folder(from)?, clean_folder(to)?);
        if from == to {
            return Ok(0);
        }
        if to.starts_with(&format!("{from}/")) {
            return Err(BackendError::invalid(format!("“{}” can’t go inside itself.", display(&from))));
        }
        if !s.folder_exists(&def, &from) {
            return Err(BackendError::not_found(format!("There’s no folder “{}” any more.", display(&from))));
        }
        if s.folder_exists(&def, &to) {
            return Err(BackendError::conflict(format!("There’s already a folder called “{}” there.", display(&to))));
        }
        let intent = Intent::MoveFolder { kind: kind.to_string(), from, to };
        let p = s.write_intent(&intent)?;
        let Intent::MoveFolder { kind, from, to } = &intent else { unreachable!() };
        let r = self.apply_move_folder(kind, from, to);
        if r.is_ok() {
            s.clear_intent(&p);
        }
        r
    }

    /// Carries out a folder move. Idempotent: redone at startup, it finishes what's left.
    pub(crate) fn apply_move_folder(&self, kind: &str, from: &str, to: &str) -> Result<usize> {
        let s = self.store;
        // Every kind kept in these folders moves with them (boards beside notes).
        let first = s.foldered_kind(kind)?;
        let defs: Vec<RecordKindDef> = s.space_kinds(&first).iter().filter_map(|k| s.kinds.get(k).cloned()).collect();
        // The folders themselves, one rename each (other files inside go along).
        for d in &defs {
            let (a, b) = (s.abs(&format!("{}/{from}", d.folder)), s.abs(&format!("{}/{to}", d.folder)));
            let exists = |p: &Path| s.fs.stat(p).ok().flatten().is_some();
            if exists(&a) && !exists(&b) {
                s.fs.create_dir_all(b.parent().unwrap()).map_err(|e| io_error(e, "making the folder"))?;
                s.fs.rename_exclusive(&a, &b).map_err(|e| io_error(e, "moving the folder"))?;
                let _ = s.fs.flush_dir(b.parent().unwrap(), self.dur.flush());
                let _ = s.fs.flush_dir(a.parent().unwrap(), self.dur.flush());
            }
        }
        // Memory follows the files, then each record's subfolder field follows its path.
        let mut moved: Vec<Id> = vec![];
        for e in s.list(None) {
            let Some(d) = defs.iter().find(|d| d.kind == e.kind) else { continue };
            let old = format!("{}/{from}/", d.folder);
            if let Some(rest) = e.path.strip_prefix(&old) {
                let mut m = e.clone();
                m.path = format!("{}/{to}/{rest}", d.folder);
                if s.fs.stat(&s.abs(&m.path)).ok().flatten().is_some() {
                    s.upsert(m)?;
                    moved.push(e.id);
                }
            }
        }
        for e in s.list(None) {
            let Some(d) = defs.iter().find(|d| d.kind == e.kind) else { continue };
            if !e.path.starts_with(&format!("{}/{to}/", d.folder)) {
                continue;
            }
            let sub = s.subfolder_of(d, &e.path).filter(|x| !x.is_empty());
            let field = d.subfolder_field.clone().unwrap_or_default();
            let want = sub.as_ref().map(|x| Value::String(x.clone()));
            let stale = e.fields.get(&field) != want.as_ref();
            let was_moved = moved.contains(&e.id);
            if !stale && !was_moved {
                continue;
            }
            if stale && e.read_only.is_none() {
                self.rewrite(d, &e.path, &[(field, sub.map(FmValue::Str))], true)?;
            } else {
                s.changes.emit(e.id, &e.kind, ChangeOp::Renamed, ChangeOrigin::App);
            }
        }
        self.order_follows(&defs[0], from, to)?;
        Ok(moved.len())
    }

    /// Removes an empty folder. Refuses while records (archived ones too) or other files are
    /// inside; the system's litter (`.DS_Store`) doesn't count.
    pub fn remove_folder(&self, kind: &str, path: &str) -> Result<()> {
        let s = self.store;
        let def = s.foldered_kind(kind)?;
        let path = clean_folder(path)?;
        let inside = s.records_in_folder(&def, &path);
        if !inside.is_empty() {
            let n = inside.len();
            return Err(BackendError::conflict(format!(
                "“{}” isn’t empty: it holds {n} {} (archived ones count too).",
                display(&path),
                if n == 1 { "item" } else { "items" }
            )));
        }
        // Everything to remove, checked before anything is.
        let mut litter = vec![];
        let mut dirs = vec![];
        {
            let top = format!("{}/{path}", def.folder);
            let mut stack = vec![top];
            while let Some(rel) = stack.pop() {
                let Ok(list) = s.fs.list(&s.abs(&rel)) else { continue };
                dirs.push(rel.clone());
                for e in list {
                    let p = format!("{rel}/{}", e.name);
                    if e.is_dir {
                        stack.push(p);
                    } else if LITTER.contains(&e.name.as_str()) {
                        litter.push(p);
                    } else {
                        return Err(BackendError::conflict(format!(
                            "“{}” holds other files (such as “{}”), so it was left as it is.",
                            display(&path),
                            e.name
                        )));
                    }
                }
            }
        }
        for f in litter {
            let _ = s.fs.remove_file(&s.abs(&f));
        }
        dirs.sort_by_key(|d| std::cmp::Reverse(d.matches('/').count()));
        for d in &dirs {
            s.fs.remove_dir(&s.abs(d)).map_err(|e| io_error(e, "removing the folder"))?;
        }
        for d in &dirs {
            if let Some(parent) = Path::new(d).parent() {
                let _ = s.fs.flush_dir(&s.abs(&rel_str(parent)), Flush::Data);
            }
        }
        // Its arrangement goes with it.
        self.change_order(&def, |order| {
            order.retain(|k, _| k != &path && !k.starts_with(&format!("{path}/")));
            if let Some(list) = order.get_mut(parent(&path)) {
                list.retain(|e| *e != folder_key(&path));
            }
        })
    }

    /// Keeps the order the user arranged a kind's folder in (`""`: its top level).
    pub fn set_folder_order(&self, kind: &str, path: &str, entries: Vec<String>) -> Result<()> {
        let def = self.store.foldered_kind(kind)?;
        let path = if path.trim_matches('/').is_empty() { String::new() } else { clean_folder(path)? };
        if entries.len() > 100_000 || entries.iter().any(|e| e.len() > 300) {
            return Err(BackendError::invalid("that order is too long"));
        }
        let mut seen = BTreeSet::new();
        let entries: Vec<String> = entries.into_iter().filter(|e| seen.insert(e.clone())).collect();
        self.change_order(&def, move |order| {
            if entries.is_empty() {
                order.remove(&path);
            } else {
                order.insert(path, entries);
            }
        })
    }

    /// Changes one kind's arrangement, writing the file only if something changed.
    fn change_order(&self, def: &RecordKindDef, f: impl FnOnce(&mut FolderOrder)) -> Result<()> {
        let s = self.store;
        let mut all = s.all_orders();
        let before = all.clone();
        let order = all.entry(def.folder.clone()).or_default();
        f(order);
        if order.is_empty() {
            all.remove(&def.folder);
        }
        if all == before {
            return Ok(());
        }
        let p = s.abs(ORDER_FILE);
        s.fs.create_dir_all(p.parent().unwrap()).map_err(|e| io_error(e, "making .librarium"))?;
        let mut b = serde_json::to_vec_pretty(&all).unwrap();
        b.push(b'\n');
        s.safe_write(&p, &b, false, self.dur).map_err(|e| io_error(e, "keeping the order"))
    }

    /// The arrangement follows a folder that moved (idempotent, so a redo changes nothing).
    fn order_follows(&self, def: &RecordKindDef, from: &str, to: &str) -> Result<()> {
        self.change_order(def, |order| {
            let under = |k: &str| k == from || k.starts_with(&format!("{from}/"));
            let moved: Vec<String> = order.keys().filter(|k| under(k)).cloned().collect();
            for k in moved {
                if let Some(v) = order.remove(&k) {
                    order.insert(format!("{to}{}", &k[from.len()..]), v);
                }
            }
            // Its place among its siblings: kept when renamed in place, dropped when moved away.
            let (old, new) = (folder_key(from), folder_key(to));
            if let Some(list) = order.get_mut(parent(from)) {
                if let Some(i) = list.iter().position(|e| *e == old) {
                    if parent(from) == parent(to) {
                        list[i] = new;
                    } else {
                        list.remove(i);
                    }
                }
            }
        })
    }

    /// Moves records into a folder (`None`: the top level). Each move is its own intent.
    pub fn move_to_folder(&self, id: Id, folder: Option<&str>) -> Result<(Entry, u64)> {
        let folder = folder.map(clean_folder).transpose()?;
        let e = self.store.get(id).ok_or_else(|| BackendError::not_found(format!("no record {id}")))?;
        let def = self.store.kind_def(&e.kind)?;
        if def.subfolder_field.is_none() {
            return Err(BackendError::invalid(format!("“{}” can’t be put in a folder", e.title)));
        }
        self.relocate(id, None, Some(folder.as_deref()))
    }
}

fn io_error(e: io::Error, what: &str) -> BackendError {
    BackendError::io(format!("{what}: {e}"))
}
