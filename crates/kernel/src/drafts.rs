//! Drafts: the editor's text, kept in Application Support until its save succeeds, so words
//! are never lost (§6). A draft remembers the version and body it started from, which makes a
//! three-way merge possible.

use crate::store::TMP_MARK;
use librarium_contracts::api::Draft;
use librarium_contracts::ports::{FileSystem, Flush};
use librarium_contracts::{BackendError, Id, Result};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub struct Drafts {
    fs: Arc<dyn FileSystem>,
    dir: PathBuf,
    lock: Mutex<()>,
}

impl Drafts {
    pub fn new(fs: Arc<dyn FileSystem>, dir: PathBuf) -> Drafts {
        Drafts { fs, dir, lock: Mutex::new(()) }
    }

    fn path(&self, id: Id) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    /// Keeps a draft. Written and flushed before returning, so it survives the process being
    /// killed.
    pub fn put(&self, d: &Draft) -> Result<()> {
        let _g = self.lock.lock().unwrap();
        self.fs.create_dir_all(&self.dir).map_err(|e| BackendError::io(e.to_string()))?;
        let target = self.path(d.id);
        let tmp = self.dir.join(format!(".{}.json{TMP_MARK}d", d.id));
        let _ = self.fs.remove_file(&tmp);
        let bytes = serde_json::to_vec(d).unwrap();
        self.fs
            .write_new(&tmp, &bytes)
            .and_then(|_| self.fs.flush_file(&tmp, Flush::Data))
            .and_then(|_| self.fs.rename(&tmp, &target))
            .and_then(|_| self.fs.flush_dir(&self.dir, Flush::Data))
            .map_err(|e| BackendError::io(format!("keeping the draft: {e}")))
    }

    pub fn get(&self, id: Id) -> Option<Draft> {
        self.fs.read(&self.path(id)).ok().and_then(|b| serde_json::from_slice(&b).ok())
    }

    pub fn all(&self) -> Vec<Draft> {
        let mut out = vec![];
        for e in self.fs.list(&self.dir).unwrap_or_default() {
            if e.is_dir || e.name.starts_with('.') || !e.name.ends_with(".json") {
                continue;
            }
            if let Some(d) =
                self.fs.read(&self.dir.join(&e.name)).ok().and_then(|b| serde_json::from_slice::<Draft>(&b).ok())
            {
                out.push(d);
            }
        }
        out.sort_by_key(|d| std::cmp::Reverse(d.updated_ms));
        out
    }

    pub fn remove(&self, id: Id) {
        let _g = self.lock.lock().unwrap();
        let _ = self.fs.remove_file(&self.path(id));
    }

    /// Removes the draft only if it holds exactly `body` (more typing since keeps it).
    pub fn settle(&self, id: Id, body: &str) {
        let _g = self.lock.lock().unwrap();
        if self.get(id).is_some_and(|d| d.body == body) {
            let _ = self.fs.remove_file(&self.path(id));
        }
    }
}
