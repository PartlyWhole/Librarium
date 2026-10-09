//! Finding the folder's state: the library's ID and lock, the walk over its records, the check
//! against the index (at start, every file; while open, what the watcher reports), and the
//! watcher itself. Identity always comes from the ID inside a file, never its name.
//!
//! A file whose size, modification time and inode match the index, and that wasn't modified
//! after it was last looked at, is trusted without being read. Our own writes come back as
//! watcher events too, and are recognised by the hash the index already has.

use super::record::{self, decode, entry_from, folder_kind, record_path, slug_for, subfolder_of, Decoded, Entry};
use super::repair::{classify, DupClass, Duplicate, Repair};
use super::write::{is_temp, safe_write};
use super::{Library, Write};
use crate::error::{Context, Result};
use crate::util::{iso_utc, json_bytes, new_id, now_ms, sha256, Id};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc};
use std::time::Duration;

/// Reads `.librarium/library.json`, or makes it (and `.librarium/.gitignore`) for a new library.
pub fn library_id(root: &Path) -> Result<Id> {
    let meta = root.join(".librarium");
    let p = meta.join("library.json");
    if let Some(id) = fs::read(&p)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v["id"].as_str().and_then(crate::util::parse_id))
    {
        return Ok(id);
    }
    fs::create_dir_all(&meta).ctx("making .librarium")?;
    let id = new_id();
    let v = json!({ "created": iso_utc(now_ms()), "id": id });
    safe_write(&p, &json_bytes(&v, true), false).ctx("writing library.json")?;
    let gitignore = meta.join(".gitignore");
    if !gitignore.exists() {
        safe_write(&gitignore, b"lock\n", true).ctx("writing .gitignore")?;
    }
    Ok(id)
}

/// Writes `.librarium/lock` with our process ID. One left behind means the app didn't close
/// cleanly; the startup check reads every changed file either way.
pub fn take_lock(root: &Path) {
    let lock = root.join(".librarium/lock");
    if lock.exists() {
        log::info!("the library wasn't closed cleanly last time");
    }
    if let Err(e) = safe_write(&lock, format!("{}\n", std::process::id()).as_bytes(), false) {
        log::warn!("the lock file couldn't be written: {e}");
    }
}

/// Every record file in the library, and our leftover temp files.
fn walk(root: &Path) -> (Vec<String>, Vec<PathBuf>) {
    let (mut files, mut temps) = (vec![], vec![]);
    for folder in ["notes", "captures", "items"] {
        let k = folder_kind(folder).expect("a kind for each top folder");
        walk_dir(root, k, &root.join(folder), &mut files, &mut temps);
    }
    files.sort();
    (files, temps)
}

/// In Markdown folders: every `*.md`, recursively, skipping dot-entries. In `items/`: every
/// folder holding `record.json` is an item; other folders are the user's.
fn walk_dir(root: &Path, k: &record::Kind, dir: &Path, files: &mut Vec<String>, temps: &mut Vec<PathBuf>) {
    let rel = |p: &Path| p.strip_prefix(root).unwrap_or(p).to_string_lossy().to_string();
    if k.json && dir.join("record.json").is_file() {
        files.push(rel(&dir.join("record.json")));
        let inner = fs::read_dir(dir).into_iter().flatten().flatten();
        temps.extend(inner.filter(|f| is_temp(&f.file_name().to_string_lossy())).map(|f| f.path()));
        return;
    }
    for e in fs::read_dir(dir).into_iter().flatten().flatten() {
        let (name, p) = (e.file_name().to_string_lossy().to_string(), e.path());
        if name.starts_with('.') {
            if is_temp(&name) && p.is_file() {
                temps.push(p);
            }
        } else if p.is_dir() {
            walk_dir(root, k, &p, files, temps);
        } else if !k.json && name.ends_with(".md") {
            files.push(rel(&p));
        }
    }
}

/// What a check found.
#[derive(Debug, Default, Clone, Copy)]
pub struct Report {
    /// Records created, changed, moved or gone.
    pub changed: usize,
    pub duplicates: usize,
    /// Files with no usable ID.
    pub unidentified: usize,
}

enum Seen {
    /// Its fingerprint matches the index: trusted without reading.
    Unchanged(Entry),
    Read {
        meta: fs::Metadata,
        bytes: Vec<u8>,
        decoded: Box<Decoded>,
    },
}

impl Seen {
    fn id(&self) -> Option<Id> {
        match self {
            Seen::Unchanged(e) => Some(e.id),
            Seen::Read { decoded, .. } => decoded.id,
        }
    }

    fn text(&self, lib: &Library, rel: &str) -> String {
        match self {
            Seen::Read { bytes, .. } => String::from_utf8_lossy(bytes).into_owned(),
            Seen::Unchanged(_) => {
                fs::read(lib.root.join(rel)).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default()
            }
        }
    }
}

fn look(lib: &Library, rel: &str) -> Option<Seen> {
    let meta = fs::metadata(lib.root.join(rel)).ok().filter(|m| m.is_file())?;
    if let Some(e) = lib.index.at_path(rel) {
        let mtime = meta.mtime().saturating_mul(1_000_000_000).saturating_add(meta.mtime_nsec());
        let same = e.size == meta.len() && e.mtime_ns == mtime && e.inode == meta.ino();
        // A file modified at or after the last look may have changed within the same tick.
        if same && mtime < e.checked_ns {
            return Some(Seen::Unchanged(e));
        }
    }
    let bytes = fs::read(lib.root.join(rel)).ok()?;
    let decoded = Box::new(decode(rel, &bytes)?);
    Some(Seen::Read { meta, bytes, decoded })
}

/// Checks every file: at start, and after a rebuild of the index. Leftover temp files go.
pub fn full_scan(w: &Write) -> Result<Report> {
    let (files, temps) = walk(&w.lib.root);
    for t in temps {
        let _ = fs::remove_file(t);
    }
    *w.lib.problems.lock().unwrap() = Default::default();
    check_set(w, files, true)
}

/// Checks the paths the watcher reported (files or folders, present or gone).
pub fn check_paths(w: &Write, paths: &[PathBuf]) -> Result<Report> {
    let lib = w.lib;
    let mut rels = BTreeSet::new();
    let known = lib.index.list(None)?;
    for p in paths {
        let Ok(rel) = p.strip_prefix(&lib.root) else { continue };
        let rel = rel.to_string_lossy().to_string();
        if rel.is_empty() || rel.split('/').any(|c| c.starts_with('.')) || folder_kind(&rel).is_none() {
            continue;
        }
        let prefix = format!("{rel}/");
        if p.is_dir() {
            let mut files = vec![];
            walk_dir(&lib.root, folder_kind(&rel).unwrap(), p, &mut files, &mut vec![]);
            rels.extend(files);
        } else if p.is_file() {
            if rel.ends_with(".md") || rel.ends_with("/record.json") {
                rels.insert(rel.clone());
            }
            continue;
        }
        // Gone or a folder: whatever the index or the problems list had there.
        rels.extend(known.iter().filter(|e| e.path == rel || e.path.starts_with(&prefix)).map(|e| e.path.clone()));
        let problems = lib.problems.lock().unwrap();
        rels.extend(problems.paths().filter(|k| **k == rel || k.starts_with(&prefix)).cloned());
    }
    check_set(w, rels.into_iter().collect(), false)
}

/// Checks files in one index transaction, committed even when the check stops part way.
fn check_set(w: &Write, rels: Vec<String>, full: bool) -> Result<Report> {
    w.lib.index.begin()?;
    let r = check_files(w, rels, full);
    w.lib.index.commit()?;
    r
}

fn check_files(w: &Write, rels: Vec<String>, full: bool) -> Result<Report> {
    let lib = w.lib;
    let mut report = Report::default();
    lib.problems.lock().unwrap().forget(&rels);
    let mut by_id: BTreeMap<Id, Vec<(String, Seen)>> = BTreeMap::new();
    let mut gone = vec![];
    for rel in rels {
        match look(lib, &rel) {
            None => gone.push(rel),
            Some(Seen::Unchanged(e)) => by_id.entry(e.id).or_default().push((rel, Seen::Unchanged(e))),
            Some(Seen::Read { meta, bytes, decoded }) => match decoded.id {
                Some(id) => by_id.entry(id).or_default().push((rel, Seen::Read { meta, bytes, decoded })),
                None => {
                    report.unidentified += 1;
                    let mut problems = lib.problems.lock().unwrap();
                    if decoded.read_only.is_some() {
                        problems.unreadable.insert(rel.clone(), "its frontmatter doesn’t parse and has no ID".into());
                    } else {
                        let id = decoded.damaged_id.as_deref().and_then(|s| uuid::Uuid::parse_str(s.trim()).ok());
                        problems
                            .repairs
                            .insert(rel.clone(), Repair::AssignId { path: rel.clone(), hash: sha256(&bytes), id });
                    }
                    // It used to be a record; now it has no usable ID.
                    gone.push(rel);
                }
            },
        }
    }
    let mut resolved = BTreeSet::new();
    for (id, mut claims) in by_id {
        if !full {
            // The indexed file still claims this ID, even when the watcher didn't report it.
            if let Some(e) = lib.index.get(id).filter(|e| !claims.iter().any(|(r, _)| *r == e.path)) {
                if let Some(seen) = look(lib, &e.path).filter(|s| s.id() == Some(id)) {
                    claims.push((e.path.clone(), seen));
                }
            }
        }
        resolve(w, id, claims, &mut report)?;
        resolved.insert(id);
    }
    for rel in gone {
        if let Some(e) = lib.index.at_path(&rel).filter(|e| !resolved.contains(&e.id)) {
            lib.index.remove(e.id)?;
            w.changed(e.id);
            report.changed += 1;
        }
    }
    if full {
        for e in lib.index.list(None)?.into_iter().filter(|e| !resolved.contains(&e.id)) {
            lib.index.remove(e.id)?;
            w.changed(e.id);
            report.changed += 1;
        }
    }
    Ok(report)
}

/// Settles which file holds an ID. The original is the one at the indexed path, else the one
/// with the canonical name, else the one created first; the others are duplicates.
fn resolve(w: &Write, id: Id, claims: Vec<(String, Seen)>, report: &mut Report) -> Result<()> {
    let lib = w.lib;
    let indexed = lib.index.get(id);
    let canonical = |rel: &str, seen: &Seen| {
        let (title, fields) = match seen {
            Seen::Read { decoded, .. } => (&decoded.title, &decoded.fields),
            Seen::Unchanged(e) => (&e.title, &e.fields),
        };
        let k = folder_kind(rel);
        k.is_some_and(|k| record_path(k, id, &slug_for(title, fields), subfolder_of(k, rel).as_deref()) == rel)
    };
    let birth = |seen: &Seen| match seen {
        Seen::Read { meta, .. } => meta.created().ok(),
        Seen::Unchanged(_) => None,
    };
    let original = match indexed.as_ref().and_then(|e| claims.iter().position(|(r, _)| *r == e.path)) {
        Some(i) => i,
        None => (0..claims.len())
            .min_by_key(|&i| (!canonical(&claims[i].0, &claims[i].1), birth(&claims[i].1), claims[i].0.clone()))
            .unwrap_or(0),
    };
    let (orig_rel, orig_seen) = &claims[original];
    if claims.len() > 1 {
        let orig_text = orig_seen.text(lib, orig_rel);
        let mut problems = lib.problems.lock().unwrap();
        for (rel, seen) in claims.iter().enumerate().filter(|(i, _)| *i != original).map(|(_, c)| c) {
            let class = classify(rel, &orig_text, &seen.text(lib, rel));
            problems.duplicates.insert(rel.clone(), Duplicate { id, path: rel.clone(), class });
            if let (DupClass::Copy, Seen::Read { bytes, .. }) = (class, seen) {
                let hash = sha256(bytes);
                problems.repairs.insert(rel.clone(), Repair::RewriteCopy { path: rel.clone(), hash, original: id });
            }
            report.duplicates += 1;
        }
    }
    let Seen::Read { meta, bytes, decoded } = orig_seen else { return Ok(()) };
    let e = entry_from(orig_rel, meta, bytes, decoded, id);
    match &indexed {
        Some(old) if old.hash == e.hash && old.path == e.path => lib.index.touch(&e)?,
        _ => {
            record::index(w, &e, bytes)?;
            if indexed.is_some() && e.is_markdown() {
                // Changed outside the app: a version of it as it is now.
                lib.history.take(&e, bytes, crate::history::Origin::Outside);
            }
            w.changed(id);
            report.changed += 1;
        }
    }
    Ok(())
}

/// Watches the folder for outside changes, checking what changed once events have been quiet
/// for 300 ms. Stops when the returned watcher is dropped.
pub fn watch(lib: &Arc<Library>) -> Option<notify::RecommendedWatcher> {
    use notify::Watcher;
    let (tx, rx) = mpsc::channel::<Vec<PathBuf>>();
    let mut watcher = notify::recommended_watcher(move |r: notify::Result<notify::Event>| {
        if let Ok(ev) = r {
            let _ = tx.send(ev.paths);
        }
    })
    .map_err(|e| log::warn!("the folder can’t be watched: {e}"))
    .ok()?;
    if let Err(e) = watcher.watch(&lib.root, notify::RecursiveMode::Recursive) {
        log::warn!("the folder can’t be watched: {e}");
        return None;
    }
    let weak = Arc::downgrade(lib);
    // Events name the real path (`/private/var/…` for `/var/…`): map them back to the root's.
    let (root, real) = (lib.root.clone(), fs::canonicalize(&lib.root).unwrap_or_else(|_| lib.root.clone()));
    let meta_dir = lib.root.join(".librarium");
    std::thread::Builder::new()
        .name("librarium-watcher".into())
        .spawn(move || {
            while let Ok(first) = rx.recv() {
                let mut paths: BTreeSet<PathBuf> = first.into_iter().collect();
                while let Ok(more) = rx.recv_timeout(Duration::from_millis(300)) {
                    paths.extend(more);
                }
                let mut paths: BTreeSet<PathBuf> =
                    paths.into_iter().map(|p| p.strip_prefix(&real).map(|r| root.join(r)).unwrap_or(p)).collect();
                paths.retain(|p| {
                    !p.starts_with(&meta_dir) && !p.file_name().is_some_and(|n| is_temp(&n.to_string_lossy()))
                });
                let Some(lib) = weak.upgrade() else { return };
                if paths.is_empty() || lib.is_closed() {
                    continue;
                }
                let paths: Vec<PathBuf> = paths.into_iter().collect();
                let checked = check_paths(&lib.write(), &paths);
                match checked {
                    Ok(r) if r.changed + r.duplicates + r.unidentified > 0 => lib.note_outside_activity(),
                    Ok(_) => {}
                    Err(e) => log::warn!("checking outside changes failed: {e}"),
                }
            }
        })
        .ok()?;
    Some(watcher)
}
