//! A Desktop that remembers what it was asked to show.

use librarium_contracts::ports::Desktop;
use librarium_contracts::Result;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Default)]
pub struct RecordingDesktop {
    pub revealed: Mutex<Vec<PathBuf>>,
    pub opened: Mutex<Vec<String>>,
}

impl Desktop for RecordingDesktop {
    fn reveal(&self, path: &Path) -> Result<()> {
        self.revealed.lock().unwrap().push(path.to_path_buf());
        Ok(())
    }

    fn open_url(&self, url: &str) -> Result<()> {
        self.opened.lock().unwrap().push(url.to_string());
        Ok(())
    }
}
