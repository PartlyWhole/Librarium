//! Checking the folder against the records table: at startup (by replay or in full), on every
//! outside change, and on a timer. Identity always comes from the ID inside the file.

use crate::hash::version_of;
use crate::kinds::Format;
use crate::record::{Decoded, ReadOnly};
use crate::store::{rel_str, DupClass, Duplicate, Repair, Tx, TMP_MARK};
use librarium_contracts::events::{ChangeOp, ChangeOrigin};
use librarium_contracts::ports::FileMeta;
use librarium_contracts::{Id, Result};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;

#[derive(Debug, Default, Clone)]
pub struct CheckReport {
    pub full: bool,
    pub seen: usize,
    pub hashed: usize,
    pub created: Vec<Id>,
    pub updated: Vec<Id>,
    pub moved: Vec<Id>,
    pub removed: Vec<Id>,
    pub duplicates: Vec<String>,
    /// Files without a usable ID (waiting for one, or unreadable).
    pub unidentified: usize,
    pub temps_removed: usize,
}

impl CheckReport {
    pub fn changed(&self) -> usize {
        self.created.len() + self.updated.len() + self.moved.len() + self.removed.len()
    }
}

/// What looking at one file found.
enum Seen {
    /// Fingerprint unchanged and not racy: trust the table.
    Unchanged(Id),
    /// Read and decoded.
    Read { meta: FileMeta, bytes: Vec<u8>, decoded: Box<Decoded> },
}

/// Does a file's name look like a sync tool's conflict copy?
pub fn conflict_name(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel).to_lowercase();
    let stem = name.strip_suffix(".md").unwrap_or(&name);
    if ["sync-conflict", "conflicted copy", "(conflict", "conflict)", "conflicted"].iter().any(|p| stem.contains(p)) {
        return true;
    }
    // iCloud and Obsidian Sync: "name 2.md" (a space never appears in our slugs).
    stem.rsplit_once(' ').is_some_and(|(_, n)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

/// Does a file's name look like a deliberate copy (Finder's "copy")?
pub fn copy_name(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel).to_lowercase();
    let stem = name.strip_suffix(".md").unwrap_or(&name);
    stem.ends_with(" copy") || stem.rsplit_once(" copy ").is_some_and(|(_, n)| n.chars().all(|c| c.is_ascii_digit()))
}

/// Mostly the same text?
pub fn mostly_same(a: &str, b: &str) -> bool {
    similar::TextDiff::from_lines(a, b).ratio() >= 0.8
}

/// Classifies a second file claiming an ID (§6).
pub fn classify(other_rel: &str, original_text: &str, other_text: &str) -> DupClass {
    if conflict_name(other_rel) {
        DupClass::Conflict
    } else if copy_name(other_rel) {
        DupClass::Copy
    } else if mostly_same(original_text, other_text) {
        DupClass::Conflict
    } else {
        DupClass::Copy
    }
}

impl Tx<'_> {
    /// Every record file in the store, and our leftover temporary files.
    fn walk(&self) -> (Vec<String>, Vec<PathBuf>) {
        let s = self.store;
        let mut files = vec![];
        let mut temps = vec![];
        for def in s.kinds.all() {
            let top = s.root.join(&def.folder);
            match def.format {
                Format::Markdown => {
                    let mut stack = vec![top];
                    while let Some(d) = stack.pop() {
                        let Ok(list) = s.fs.list(&d) else { continue };
                        for e in list {
                            let p = d.join(&e.name);
                            if e.name.starts_with('.') {
                                if e.name.contains(TMP_MARK) && !e.is_dir {
                                    temps.push(p);
                                }
                                continue;
                            }
                            if e.is_dir {
                                stack.push(p);
                            } else if e.name.ends_with(".md") {
                                files.push(rel_str(p.strip_prefix(&s.root).unwrap()));
                            }
                        }
                    }
                }
                Format::JsonDir => {
                    // Record folders, in the user's folders when the kind has them.
                    let mut stack = vec![top];
                    while let Some(d) = stack.pop() {
                        let Ok(list) = s.fs.list(&d) else { continue };
                        for e in list.into_iter().filter(|e| e.is_dir && !e.name.starts_with('.')) {
                            let dir = d.join(&e.name);
                            let Ok(inner) = s.fs.list(&dir) else { continue };
                            let mut is_record = false;
                            for f in &inner {
                                if f.name.starts_with('.') && f.name.contains(TMP_MARK) {
                                    temps.push(dir.join(&f.name));
                                } else if f.name == "record.json" {
                                    is_record = true;
                                    files.push(rel_str(dir.join("record.json").strip_prefix(&s.root).unwrap()));
                                }
                            }
                            if !is_record && def.subfolder_field.is_some() {
                                stack.push(dir);
                            }
                        }
                    }
                }
            }
        }
        files.sort();
        (files, temps)
    }

    fn look(&self, rel: &str, report: &mut CheckReport) -> Option<Seen> {
        let s = self.store;
        let meta = s.fs.stat(&s.abs(rel)).ok().flatten().filter(|m| !m.is_dir)?;
        report.seen += 1;
        if let Some(id) = s.id_at(rel) {
            if let Some(e) = s.get(id) {
                let same_fp = e.fp == (&meta).into();
                // git's racy rule: a file modified at or after the last look must be hashed.
                let racy = meta.mtime_ns >= e.checked_ns;
                if same_fp && !racy {
                    return Some(Seen::Unchanged(id));
                }
            }
        }
        let bytes = s.fs.read(&s.abs(rel)).ok()?;
        report.hashed += 1;
        let decoded = s.decode(rel, &bytes)?;
        Some(Seen::Read { meta, bytes, decoded: Box::new(decoded) })
    }

    /// Checks every file (first run, history unusable, dropped events, timer).
    pub fn full_check(&self) -> Result<CheckReport> {
        let s = self.store;
        let mut report = CheckReport { full: true, ..Default::default() };
        let (files, temps) = self.walk();
        for t in &temps {
            // Ours, and never the committed state: an unfinished write.
            if s.fs.remove_file(t).is_ok() {
                report.temps_removed += 1;
            }
        }
        let known: BTreeSet<String> = s.list(None).into_iter().map(|e| e.path).collect();
        let mut all: BTreeSet<String> = files.into_iter().collect();
        all.extend(known);
        self.check_set(all.into_iter().collect(), true, &mut report)?;
        Ok(report)
    }

    /// Checks the given absolute paths (from the change source). Folders are expanded.
    pub fn check_paths(&self, paths: &[PathBuf]) -> Result<CheckReport> {
        let s = self.store;
        let mut report = CheckReport::default();
        let mut rels = BTreeSet::new();
        for p in paths {
            let Ok(rel) = p.strip_prefix(&s.root) else { continue };
            let rel = rel_str(rel);
            if rel.is_empty() || rel.split('/').any(|c| c.starts_with('.')) {
                continue;
            }
            if s.kind_for_path(&rel).is_none() {
                continue;
            }
            match s.fs.stat(p).ok().flatten() {
                Some(m) if m.is_dir => {
                    // A folder changed (created, renamed, removed contents): look inside.
                    let mut stack = vec![p.clone()];
                    while let Some(d) = stack.pop() {
                        for e in s.fs.list(&d).unwrap_or_default() {
                            if e.name.starts_with('.') {
                                continue;
                            }
                            let c = d.join(&e.name);
                            if e.is_dir {
                                stack.push(c);
                            } else if e.name.ends_with(".md") || e.name == "record.json" {
                                rels.insert(rel_str(c.strip_prefix(&s.root).unwrap()));
                            }
                        }
                    }
                    let prefix = format!("{rel}/");
                    rels.extend(s.list(None).into_iter().filter(|e| e.path.starts_with(&prefix)).map(|e| e.path));
                }
                Some(_) => {
                    if rel.ends_with(".md") || rel.ends_with("/record.json") {
                        rels.insert(rel);
                    }
                }
                None => {
                    // Gone: a file, or a whole folder.
                    let prefix = format!("{rel}/");
                    rels.extend(
                        s.list(None)
                            .into_iter()
                            .filter(|e| e.path == rel || e.path.starts_with(&prefix))
                            .map(|e| e.path),
                    );
                    let st = s.state.read().unwrap();
                    rels.extend(st.duplicates.keys().filter(|k| **k == rel || k.starts_with(&prefix)).cloned());
                }
            }
        }
        self.check_set(rels.into_iter().collect(), false, &mut report)?;
        Ok(report)
    }

    fn check_set(&self, rels: Vec<String>, full: bool, report: &mut CheckReport) -> Result<()> {
        let s = self.store;
        s.table_begin();
        let mut by_id: BTreeMap<Id, Vec<(String, Option<Seen>)>> = BTreeMap::new();
        let mut gone: Vec<String> = vec![];
        let mut seen_paths: BTreeSet<String> = BTreeSet::new();

        for rel in rels {
            match self.look(&rel, report) {
                None => gone.push(rel),
                Some(Seen::Unchanged(id)) => {
                    seen_paths.insert(rel.clone());
                    by_id.entry(id).or_default().push((rel, Some(Seen::Unchanged(id))));
                }
                Some(Seen::Read { meta, bytes, decoded }) => {
                    seen_paths.insert(rel.clone());
                    // Repair candidates: no ID, or a damaged one.
                    let id = decoded.id.or_else(|| decoded.damaged_id.as_deref().and_then(Id::parse_lenient));
                    match id {
                        Some(id) if decoded.id.is_some() => {
                            by_id.entry(id).or_default().push((rel, Some(Seen::Read { meta, bytes, decoded })))
                        }
                        other => {
                            report.unidentified += 1;
                            let unparsable = matches!(decoded.read_only, Some(ReadOnly::Unparsable(_)));
                            s.with_state(|st| {
                                if unparsable {
                                    st.unreadable
                                        .insert(rel.clone(), "frontmatter does not parse and has no ID".into());
                                } else {
                                    st.repairs.insert(
                                        rel.clone(),
                                        Repair::AssignId { path: rel.clone(), hash: version_of(&bytes), id: other },
                                    );
                                }
                            });
                            if let Some(old) = s.id_at(&rel) {
                                // It used to be a record; now it has no usable ID.
                                gone.push(rel);
                                let _ = old;
                            }
                        }
                    }
                }
            }
        }

        // Each ID's claimants: the files in this check, plus its indexed file if still there.
        for (id, mut claims) in by_id {
            if let Some(e) = s.get(id) {
                if !claims.iter().any(|(r, _)| *r == e.path) && !full {
                    if let Some(seen) = self.look(&e.path, report) {
                        let still = match &seen {
                            Seen::Unchanged(i) => *i == id,
                            Seen::Read { decoded, .. } => decoded.id == Some(id),
                        };
                        if still {
                            claims.push((e.path.clone(), Some(seen)));
                        }
                    }
                }
            }
            self.resolve(id, claims, report)?;
        }

        // Paths that are gone.
        let claimed: BTreeSet<Id> =
            s.list(None).into_iter().filter(|e| seen_paths.contains(&e.path)).map(|e| e.id).collect();
        for rel in gone {
            s.with_state(|st| {
                if let Some(d) = st.duplicates.remove(&rel) {
                    if let Some(e) = st.by_id.get_mut(&d.id) {
                        e.conflicts.retain(|c| *c != rel);
                    }
                }
                st.repairs.remove(&rel);
            });
            if let Some(id) = s.id_at(&rel) {
                let moved_elsewhere = s.get(id).is_some_and(|e| e.path != rel);
                if !moved_elsewhere && !claimed.contains(&id) {
                    if let Some(e) = s.forget(id)? {
                        s.changes.emit(id, &e.kind, ChangeOp::Removed, ChangeOrigin::Outside);
                        report.removed.push(id);
                    }
                }
            }
        }
        if full {
            // Anything indexed whose file wasn't seen at all is gone.
            for e in s.list(None) {
                if !seen_paths.contains(&e.path) {
                    s.forget(e.id)?;
                    s.changes.emit(e.id, &e.kind, ChangeOp::Removed, ChangeOrigin::Outside);
                    report.removed.push(e.id);
                }
            }
            s.with_state(|st| {
                st.duplicates.retain(|p, _| seen_paths.contains(p));
                st.repairs.retain(|p, _| seen_paths.contains(p));
                st.unreadable.retain(|p, _| seen_paths.contains(p));
            });
        }
        self.save_side_lists()?;
        s.table_commit();
        Ok(())
    }

    /// Settles which file holds an ID: one claimant is the record; others are duplicates.
    fn resolve(&self, id: Id, claims: Vec<(String, Option<Seen>)>, report: &mut CheckReport) -> Result<()> {
        let s = self.store;
        let indexed = s.get(id);
        let original_idx = if claims.len() == 1 {
            0
        } else if let Some(i) = indexed.as_ref().and_then(|e| claims.iter().position(|(r, _)| *r == e.path)) {
            // The original is the one at the indexed path…
            i
        } else {
            // …with no index, the one with the canonical name, then the earlier creation.
            let canonical = |rel: &str, seen: &Option<Seen>| -> bool {
                let Some(def) = s.kind_for_path(rel) else { return false };
                let (title, fields) = match seen {
                    Some(Seen::Read { decoded, .. }) => (decoded.title.clone(), decoded.fields.clone()),
                    _ => match s.get(id) {
                        Some(e) => (e.title, e.fields),
                        None => return false,
                    },
                };
                let slug = s.slug_for(&def.kind, &title, &fields);
                s.record_path(def, id, &slug, s.subfolder_of(def, rel).as_deref()) == rel
            };
            let birth = |seen: &Option<Seen>| match seen {
                Some(Seen::Read { meta, .. }) => meta.birth_ns.unwrap_or(meta.mtime_ns),
                _ => i64::MIN,
            };
            let mut best = 0;
            for (i, (rel, seen)) in claims.iter().enumerate() {
                let (brel, bseen) = &claims[best];
                let key = (!canonical(rel, seen), birth(seen), rel.clone());
                let bkey = (!canonical(brel, bseen), birth(bseen), brel.clone());
                if key < bkey {
                    best = i;
                }
            }
            best
        };

        let (orig_rel, orig_seen) = &claims[original_idx];
        let mut conflicts = vec![];
        let mut orig_text: Option<String> = None;
        for (i, (rel, seen)) in claims.iter().enumerate() {
            if i == original_idx {
                continue;
            }
            let text = |seen: &Option<Seen>, rel: &str| match seen {
                Some(Seen::Read { bytes, .. }) => String::from_utf8_lossy(bytes).into_owned(),
                _ => s.read_bytes(rel).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default(),
            };
            let ot = orig_text.get_or_insert_with(|| text(orig_seen, orig_rel)).clone();
            let class = classify(rel, &ot, &text(seen, rel));
            report.duplicates.push(rel.clone());
            s.with_state(|st| {
                st.duplicates.insert(rel.clone(), Duplicate { id, path: rel.clone(), class });
                if class == DupClass::Copy {
                    let hash = match seen {
                        Some(Seen::Read { bytes, .. }) => version_of(bytes),
                        _ => String::new(),
                    };
                    st.repairs.insert(rel.clone(), Repair::RewriteCopy { path: rel.clone(), hash, original: id });
                }
            });
            if class == DupClass::Conflict {
                conflicts.push(rel.clone());
            }
            // A duplicate's old table mapping (if it was once the record) is dropped.
            s.with_state(|st| {
                if st.by_path.get(rel) == Some(&id) {
                    st.by_path.remove(rel);
                }
            });
        }

        let op = match (&indexed, orig_seen) {
            (None, _) => Some(ChangeOp::Created),
            (Some(e), _) if e.path != *orig_rel => Some(ChangeOp::Renamed),
            (Some(e), Some(Seen::Read { bytes, .. })) if e.hash != version_of(bytes) => Some(ChangeOp::Updated),
            _ => None,
        };
        let mut entry = match orig_seen {
            Some(Seen::Read { meta, bytes, decoded }) => s.entry_from(orig_rel, meta, bytes, decoded, id),
            _ => indexed.clone().expect("unchanged implies indexed"),
        };
        entry.path = orig_rel.clone();
        let mut all_conflicts: Vec<String> = indexed.map(|e| e.conflicts).unwrap_or_default();
        for c in conflicts {
            if !all_conflicts.contains(&c) {
                all_conflicts.push(c);
            }
        }
        all_conflicts.retain(|c| s.fs.stat(&s.abs(c)).ok().flatten().is_some());
        entry.conflicts = all_conflicts;
        let refresh = matches!(orig_seen, Some(Seen::Read { .. }));
        if op.is_some() || refresh {
            s.upsert(entry.clone())?;
        } else {
            s.with_state(|st| {
                if let Some(e) = st.by_id.get_mut(&id) {
                    e.conflicts = entry.conflicts.clone();
                }
            });
        }
        if let Some(op) = op {
            s.changes.emit(id, &entry.kind, op, ChangeOrigin::Outside);
            match op {
                ChangeOp::Created => report.created.push(id),
                ChangeOp::Renamed => report.moved.push(id),
                _ => report.updated.push(id),
            }
        }
        Ok(())
    }

    /// Duplicates, repairs and unreadable files live in the records view's metadata, so a
    /// replayed startup (which looks only at changed files) still knows them.
    pub(crate) fn save_side_lists(&self) -> Result<()> {
        let s = self.store;
        let (d, r, u) = {
            let st = s.state.read().unwrap();
            (
                serde_json::to_string(
                    &st.duplicates.values().map(|d| (d.path.clone(), d.id, d.class)).collect::<Vec<_>>(),
                )
                .unwrap(),
                serde_json::to_string(&st.repairs.values().collect::<Vec<_>>()).unwrap(),
                serde_json::to_string(&st.unreadable).unwrap(),
            )
        };
        s.set_table_meta("duplicates", &d)?;
        s.set_table_meta("repairs", &r)?;
        s.set_table_meta("unreadable", &u)
    }
}

impl crate::store::Store {
    pub(crate) fn load_side_lists(&self) {
        let d: Vec<(String, Id, DupClass)> =
            self.table_meta("duplicates").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let r: Vec<Repair> = self.table_meta("repairs").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let u: BTreeMap<String, String> =
            self.table_meta("unreadable").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let mut conflicts: HashMap<Id, Vec<String>> = HashMap::new();
        self.with_state(|st| {
            for (path, id, class) in d {
                if class == DupClass::Conflict {
                    conflicts.entry(id).or_default().push(path.clone());
                }
                st.duplicates.insert(path.clone(), Duplicate { id, path, class });
            }
            for rep in r {
                st.repairs.insert(rep.path().to_string(), rep);
            }
            st.unreadable = u;
            for (id, c) in conflicts {
                if let Some(e) = st.by_id.get_mut(&id) {
                    e.conflicts = c;
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert!(conflict_name("notes/0192-a.sync-conflict-20261002-091400-ABC.md"));
        assert!(conflict_name("notes/0192-a (conflicted copy 2026-10-02).md"));
        assert!(conflict_name("notes/0192-jacques-ellul 2.md"));
        assert!(!conflict_name("notes/0192-jacques-ellul-2.md"));
        assert!(copy_name("notes/0192-jacques-ellul copy.md"));
        assert!(copy_name("notes/0192-jacques-ellul copy 3.md"));
        assert!(!copy_name("notes/0192-copy.md"));
    }

    #[test]
    fn classification() {
        let a = "---\nid: x\n---\nOne\nTwo\nThree\nFour\nFive\n";
        let b = "---\nid: x\n---\nOne\nTwo\nThree\nFour\nFive!\n";
        assert_eq!(classify("notes/x-other.md", a, b), DupClass::Conflict);
        assert_eq!(classify("notes/x copy.md", a, a), DupClass::Copy);
        assert_eq!(classify("notes/x-other.md", a, "---\nid: x\n---\nSomething else entirely\n"), DupClass::Copy);
        assert_eq!(classify("notes/x 2.md", a, "totally different"), DupClass::Conflict);
    }
}
