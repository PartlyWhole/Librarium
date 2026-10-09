//! Repairs: two files claiming one ID, and files whose ID is missing or damaged.
//!
//! A second file with an ID is a sync tool's *conflict* (shown to compare, never merged) or a
//! *copy* (given its own ID and `copied-from`). Repairs write only when the folder is quiet:
//! 3 s without outside changes and no git operation in progress.

use super::frontmatter::{self, FmValue, Frontmatter};
use super::record::{self, decode, folder_kind, new_frontmatter, record_path, slug_for, subfolder_of};
use super::save;
use super::write::{rename_exclusive, safe_write, sync_dir, with_intent, Intent};
use super::Write;
use crate::error::{Context, Error, Result};
use crate::types::DuplicateInfo;
use crate::util::{iso_utc, new_id, now_ms, sha256, Id};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DupClass {
    Conflict,
    Copy,
}

#[derive(Debug, Clone)]
pub struct Duplicate {
    pub id: Id,
    pub path: String,
    pub class: DupClass,
}

/// A write the app makes on its own, once the folder is quiet.
#[derive(Debug, Clone, PartialEq)]
pub enum Repair {
    /// Give a file without a canonical ID one (`id` keeps a damaged one that still parses).
    AssignId { path: String, hash: String, id: Option<Id> },
    /// Give a copy its own ID, saying where it was copied from.
    RewriteCopy { path: String, hash: String, original: Id },
}

/// What the last check found wrong, by path.
#[derive(Debug, Default)]
pub struct Problems {
    pub duplicates: BTreeMap<String, Duplicate>,
    pub repairs: BTreeMap<String, Repair>,
    /// Files that can't be identified at all (unparsable, with no ID).
    pub unreadable: BTreeMap<String, String>,
}

impl Problems {
    /// Other files claiming this ID that look like sync conflicts.
    pub fn conflicts_of(&self, id: Id) -> Vec<String> {
        self.duplicates
            .values()
            .filter(|d| d.id == id && d.class == DupClass::Conflict)
            .map(|d| d.path.clone())
            .collect()
    }

    pub fn duplicate_infos(&self) -> Vec<DuplicateInfo> {
        let class = |c| if c == DupClass::Conflict { "conflict" } else { "copy" };
        self.duplicates
            .values()
            .map(|d| DuplicateInfo { path: d.path.clone(), id: d.id, class: class(d.class).into() })
            .collect()
    }

    pub fn has_repairs(&self) -> bool {
        !self.repairs.is_empty()
    }

    pub fn paths(&self) -> impl Iterator<Item = &String> {
        self.duplicates.keys().chain(self.repairs.keys()).chain(self.unreadable.keys())
    }

    /// Forgets what was known about these paths (they are being checked again).
    pub fn forget(&mut self, rels: &[String]) {
        for r in rels {
            self.duplicates.remove(r);
            self.repairs.remove(r);
            self.unreadable.remove(r);
        }
    }
}

fn stem(rel: &str) -> String {
    let name = rel.rsplit('/').next().unwrap_or(rel).to_lowercase();
    name.strip_suffix(".md").unwrap_or(&name).to_string()
}

/// A sync tool's conflict copy: "sync-conflict", "conflicted copy", "(conflict…", or a stem
/// ending in " <digits>" (iCloud's "name 2.md"; our slugs never hold a space).
pub fn conflict_name(rel: &str) -> bool {
    let stem = stem(rel);
    ["sync-conflict", "conflicted copy", "(conflict", "conflict)", "conflicted"].iter().any(|p| stem.contains(p))
        || stem.rsplit_once(' ').is_some_and(|(_, n)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

/// A Finder copy: the stem ends in " copy" or " copy N".
pub fn copy_name(rel: &str) -> bool {
    let stem = stem(rel);
    stem.ends_with(" copy") || stem.rsplit_once(" copy ").is_some_and(|(_, n)| n.chars().all(|c| c.is_ascii_digit()))
}

/// Classifies a second file claiming an ID, against the original's text.
pub fn classify(other_rel: &str, original: &str, other: &str) -> DupClass {
    if conflict_name(other_rel) {
        DupClass::Conflict
    } else if copy_name(other_rel) {
        DupClass::Copy
    } else if similar::TextDiff::from_lines(original, other).ratio() >= 0.8 {
        DupClass::Conflict
    } else {
        DupClass::Copy
    }
}

/// Runs the pending repairs whose files are still as they were seen.
pub fn run_repairs(w: &Write) {
    let repairs: Vec<Repair> = w.lib.problems.lock().unwrap().repairs.values().cloned().collect();
    for r in repairs {
        let (path, hash, id, copied_from) = match r {
            Repair::AssignId { path, hash, id } => (path, hash, id.unwrap_or_else(new_id), None),
            Repair::RewriteCopy { path, hash, original } => (path, hash, new_id(), Some(original)),
        };
        if fs::read(w.lib.root.join(&path)).map(|b| sha256(&b)).ok().as_deref() != Some(hash.as_str()) {
            // Changed since it was seen: the next check sees it afresh.
            w.lib.problems.lock().unwrap().repairs.remove(&path);
            continue;
        }
        let intent = Intent::Identify { from: path.clone(), hash: hash.clone(), id, copied_from };
        let done =
            with_intent(&w.lib.app_dir, &intent, |changed| apply_identify(w, &path, &hash, id, copied_from, changed));
        if let Err(e) = done {
            // Not tried again until the file changes.
            log::warn!("repairing {path} failed: {e}");
            let mut problems = w.lib.problems.lock().unwrap();
            problems.repairs.remove(&path);
            problems.unreadable.insert(path, e.message);
        }
    }
}

/// Renames `from` to the canonical name for `id`, then writes the ID in (and `copied-from`,
/// and a missing kind or title; a file without frontmatter gets a whole envelope). The new
/// bytes are worked out before the rename, and a failure after it renames the file back. Only
/// a file still as it was seen (`hash`) is touched.
pub(crate) fn apply_identify(
    w: &Write,
    from: &str,
    hash: &str,
    id: Id,
    copied_from: Option<Id>,
    changed: &mut bool,
) -> Result<record::Entry> {
    let lib = w.lib;
    let k =
        folder_kind(from).filter(|k| !k.json).ok_or_else(|| Error::invalid("only Markdown is identified in place"))?;
    // Where the file is now: at `from`, or already renamed.
    let cur = if lib.root.join(from).exists() {
        from.to_string()
    } else {
        let dir = Path::new(from).parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default();
        let found = fs::read_dir(lib.root.join(&dir)).ctx("listing")?.flatten().find_map(|f| {
            let n = f.file_name().to_string_lossy().to_string();
            (n.starts_with(&id.to_string()) && n.ends_with(".md")).then_some(n)
        });
        format!("{dir}/{}", found.ok_or_else(|| Error::not_found(format!("{from} is gone")))?)
    };
    let bytes = fs::read(lib.root.join(&cur)).ctx("reading")?;
    let d = decode(&cur, &bytes).ok_or_else(|| Error::invalid("that file can’t be read"))?;
    if d.id == Some(id) {
        // Finished before a crash, all but the index.
        lib.problems.lock().unwrap().forget(&[from.to_string(), cur.clone()]);
        return save::commit(w, &cur, &bytes);
    }
    if sha256(&bytes) != hash {
        return Err(Error::conflict(format!("{cur} changed since it was seen")));
    }
    let title = if d.title.is_empty() {
        Path::new(&cur).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
    } else {
        d.title.clone()
    };
    let target = record_path(k, id, &slug_for(&title, &d.fields), subfolder_of(k, from).as_deref());
    let out = identified(&bytes, &d, &title, id, copied_from)?;
    let (cur_path, target_path) = (lib.root.join(&cur), lib.root.join(&target));
    if cur != target {
        *changed = true;
        rename_exclusive(&cur_path, &target_path).ctx("renaming")?;
        sync_dir(target_path.parent().unwrap()).ctx("flushing")?;
    }
    let written = safe_write(&target_path, out.as_bytes(), false).ctx("writing the ID");
    if let Err(e) = written {
        if cur != target && rename_exclusive(&target_path, &cur_path).is_ok() {
            *changed = false;
        }
        return Err(e);
    }
    lib.problems.lock().unwrap().forget(&[from.to_string(), target.clone()]);
    save::commit(w, &target, out.as_bytes())
}

/// A file's text with its ID written in, and whatever else the envelope lacks.
fn identified(bytes: &[u8], d: &record::Decoded, title: &str, id: Id, copied_from: Option<Id>) -> Result<String> {
    let text = String::from_utf8_lossy(bytes).into_owned();
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let fm_err = |e: frontmatter::FmError| Error::read_only(e.to_string());
    Ok(match frontmatter::split(&text) {
        (Some((f, _)), body) => {
            let mut fm = Frontmatter::parse(f).map_err(fm_err)?;
            fm.set("id", &FmValue::Str(id.to_string())).map_err(fm_err)?;
            if fm.get("kind").is_none() {
                fm.set("kind", &FmValue::Str(d.kind.clone())).map_err(fm_err)?;
            }
            if fm.get("title").is_none() {
                fm.set("title", &FmValue::Str(title.to_string())).map_err(fm_err)?;
            }
            if let Some(o) = copied_from {
                fm.set("copied-from", &FmValue::Str(o.to_string())).map_err(fm_err)?;
            }
            frontmatter::join(fm.text(), body, newline)
        }
        (None, _) => {
            let mut fm = new_frontmatter(id, &d.kind, &iso_utc(now_ms()), title, &[]);
            if let Some(o) = copied_from {
                fm.push_str(&format!("copied-from: \"{o}\"\n"));
            }
            frontmatter::join(&fm, &text, newline)
        }
    })
}
