//! A TextRecognizer answering from stored results, counting its calls.

use librarium_contracts::ports::{Recognized, RecognizedLine, RecognizedPage, TextRecognizer};
use librarium_contracts::{BackendError, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

#[derive(Default)]
pub struct StoredRecognitions {
    /// file name → the text of each page.
    texts: Mutex<HashMap<String, Vec<String>>>,
    pub calls: AtomicU32,
    pub last: Mutex<Option<PathBuf>>,
}

impl StoredRecognitions {
    /// Stores the text found in a file (by its name), one entry per page.
    pub fn with(self, file_name: &str, pages: &[&str]) -> Self {
        self.texts.lock().unwrap().insert(file_name.into(), pages.iter().map(|s| s.to_string()).collect());
        self
    }
    pub fn calls(&self) -> u32 {
        self.calls.load(Ordering::SeqCst)
    }
    fn lookup(&self, path: &Path) -> Result<Vec<String>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        *self.last.lock().unwrap() = Some(path.to_path_buf());
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        // Imported originals are renamed (original.png): match by suffix too.
        let t = self.texts.lock().unwrap();
        t.get(&name)
            .or_else(|| t.iter().find(|(k, _)| k.rsplit('.').next() == name.rsplit('.').next()).map(|(_, v)| v))
            .cloned()
            .ok_or_else(|| BackendError::invalid(format!("no stored recognition for {name}")))
    }
}

fn page(n: u32, text: &str) -> RecognizedPage {
    let lines: Vec<RecognizedLine> = text
        .lines()
        .enumerate()
        .map(|(i, l)| RecognizedLine {
            text: l.into(),
            confidence: 1.0,
            x: 0.05,
            y: 0.1 + i as f64 * 0.25,
            w: 0.9,
            h: 0.15,
        })
        .collect();
    RecognizedPage { page: n, text: text.into(), lines }
}

impl TextRecognizer for StoredRecognitions {
    fn recognize_image(&self, path: &Path) -> Result<Recognized> {
        let pages = self.lookup(path)?;
        Ok(Recognized {
            extractor: "stored".into(),
            version: 1,
            pages: vec![page(1, pages.first().map(String::as_str).unwrap_or(""))],
        })
    }
    fn recognize_pdf_pages(&self, path: &Path, pages: &[u32]) -> Result<Recognized> {
        let all = self.lookup(path)?;
        Ok(Recognized {
            extractor: "stored".into(),
            version: 1,
            pages: pages.iter().filter_map(|&n| all.get(n as usize - 1).map(|t| page(n, t))).collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn passes_the_shared_suite() {
        let r = super::StoredRecognitions::default()
            .with("words.png", &["Gravity and grace are two forces.\nAttention is the rarest form of generosity.\nWe read slowly and quote exactly."])
            .with("scan.pdf", &["Gravity and grace are two forces.\nAttention is the rarest form of generosity.\nWe read slowly and quote exactly."]);
        crate::suites::recognizer::run(&r);
    }
}
