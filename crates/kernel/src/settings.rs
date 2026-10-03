//! Per-device settings (`settings.json` in Application Support), written by the backend with
//! the safe-write algorithm. Unknown keys are kept.

use librarium_contracts::ports::{FileSystem, Flush};
use librarium_contracts::{BackendError, Result};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub struct Settings {
    fs: Arc<dyn FileSystem>,
    path: PathBuf,
    values: Mutex<Map<String, Value>>,
}

impl Settings {
    pub fn load(fs: Arc<dyn FileSystem>, app_support: &Path) -> Settings {
        let path = app_support.join("settings.json");
        let values =
            fs.read(&path).ok().and_then(|b| serde_json::from_slice::<Map<String, Value>>(&b).ok()).unwrap_or_default();
        Settings { fs, path, values: Mutex::new(values) }
    }

    pub fn get(&self, key: &str) -> Option<Value> {
        self.values.lock().unwrap().get(key).cloned()
    }

    pub fn all(&self) -> Map<String, Value> {
        self.values.lock().unwrap().clone()
    }

    /// Sets (or with `None` removes) keys, then saves.
    pub fn set(&self, changes: &[(String, Option<Value>)]) -> Result<()> {
        let snapshot = {
            let mut v = self.values.lock().unwrap();
            for (k, val) in changes {
                match val {
                    Some(x) => v.insert(k.clone(), x.clone()),
                    None => v.remove(k),
                };
            }
            v.clone()
        };
        let mut bytes = serde_json::to_vec_pretty(&Value::Object(snapshot)).unwrap();
        bytes.push(b'\n');
        let dir = self.path.parent().unwrap();
        self.fs.create_dir_all(dir).map_err(|e| BackendError::io(e.to_string()))?;
        let tmp = dir.join(format!(".settings.json.librarium-tmp-{}", std::process::id()));
        let _ = self.fs.remove_file(&tmp);
        let r = self
            .fs
            .write_new(&tmp, &bytes)
            .and_then(|_| self.fs.flush_file(&tmp, Flush::Full))
            .and_then(|_| self.fs.rename(&tmp, &self.path))
            .and_then(|_| self.fs.flush_dir(dir, Flush::Full));
        r.map_err(|e| BackendError::io(format!("saving settings: {e}")))
    }
}
