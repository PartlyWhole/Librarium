//! TextRecognizer port: Apple Vision, run in the worker process (image decoding and
//! recognition are untrusted, heavy work). One worker call per image or page, each within the
//! worker's timeout.

use librarium_contracts::ports::{Recognized, TextRecognizer, WorkerHost};
use librarium_contracts::{BackendError, Result};
use serde_json::json;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

pub struct VisionRecognizer {
    worker: Arc<dyn WorkerHost>,
    timeout: Duration,
}

impl VisionRecognizer {
    pub fn new(worker: Arc<dyn WorkerHost>) -> Self {
        VisionRecognizer { worker, timeout: Duration::from_secs(30) }
    }
}

fn parse(v: serde_json::Value) -> Result<Recognized> {
    serde_json::from_value(v).map_err(|e| BackendError::internal(format!("unexpected recognition result: {e}")))
}

impl TextRecognizer for VisionRecognizer {
    fn recognize_image(&self, path: &Path) -> Result<Recognized> {
        parse(self.worker.call("ocr.image", json!({ "path": path }), self.timeout)?)
    }

    fn recognize_pdf_pages(&self, path: &Path, pages: &[u32]) -> Result<Recognized> {
        let mut out = Recognized { extractor: "apple-vision".into(), version: 1, pages: vec![] };
        for &p in pages {
            let r = parse(self.worker.call("ocr.pdf", json!({ "path": path, "pages": [p] }), self.timeout)?)?;
            out.extractor = r.extractor;
            out.version = r.version;
            out.pages.extend(r.pages);
        }
        Ok(out)
    }
}
