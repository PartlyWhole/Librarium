//! Per-device state in app data: `settings.json` (unknown keys kept), and drafts, the
//! editor's unsaved text, kept until its save succeeds.

use crate::error::{Context, Result};
use crate::store::write::{safe_write, write_json};
use crate::types::Draft;
use crate::util::{json_bytes, Id};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The settings key holding the library folder.
pub const LIBRARY_PATH: &str = "store.path";

pub struct Settings {
    path: PathBuf,
    values: Mutex<Map<String, Value>>,
}

impl Settings {
    pub fn load(app_data: &Path) -> Settings {
        let path = app_data.join("settings.json");
        let values = fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Settings { path, values: Mutex::new(values) }
    }

    pub fn get(&self, key: &str) -> Option<Value> {
        self.values.lock().unwrap().get(key).cloned()
    }

    pub fn all(&self) -> Map<String, Value> {
        self.values.lock().unwrap().clone()
    }

    /// Sets keys (`null` removes one), then saves.
    pub fn set(&self, changes: Map<String, Value>) -> Result<()> {
        let mut values = self.values.lock().unwrap();
        for (k, v) in changes {
            if v.is_null() {
                values.remove(&k);
            } else {
                values.insert(k, v);
            }
        }
        fs::create_dir_all(self.path.parent().unwrap()).ctx("making the app’s folder")?;
        write_json(&self.path, &Value::Object(values.clone()), true).ctx("saving settings")
    }
}

/// Drafts in `<library app data>/drafts/<id>.json`.
pub struct Drafts {
    dir: PathBuf,
    lock: Mutex<()>,
}

impl Drafts {
    pub fn new(dir: PathBuf) -> Drafts {
        Drafts { dir, lock: Mutex::new(()) }
    }

    fn path(&self, id: Id) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    /// Keeps a draft, flushed to the disk before returning.
    pub fn put(&self, d: &Draft) -> Result<()> {
        let _g = self.lock.lock().unwrap();
        fs::create_dir_all(&self.dir).ctx("making the drafts folder")?;
        safe_write(&self.path(d.id), &json_bytes(&serde_json::to_value(d)?, false), false).ctx("keeping the draft")
    }

    pub fn get(&self, id: Id) -> Option<Draft> {
        fs::read(self.path(id)).ok().and_then(|b| serde_json::from_slice(&b).ok())
    }

    /// Every draft, newest first.
    pub fn all(&self) -> Vec<Draft> {
        let mut out: Vec<Draft> = fs::read_dir(&self.dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| {
                e.path().extension().is_some_and(|x| x == "json") && !e.file_name().to_string_lossy().starts_with('.')
            })
            .filter_map(|e| serde_json::from_slice(&fs::read(e.path()).ok()?).ok())
            .collect();
        out.sort_by_key(|d| std::cmp::Reverse(d.updated_ms));
        out
    }

    pub fn remove(&self, id: Id) {
        let _g = self.lock.lock().unwrap();
        let _ = fs::remove_file(self.path(id));
    }

    /// Removes the draft only if it holds exactly `body` (typing since keeps it).
    pub fn settle(&self, id: Id, body: &str) {
        let _g = self.lock.lock().unwrap();
        if self.get(id).is_some_and(|d| d.body == body) {
            let _ = fs::remove_file(self.path(id));
        }
    }
}
