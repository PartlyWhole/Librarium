//! A database the app downloads once, when asked (word origins, the Bible): fetched gzipped from
//! a release of this repository, unpacked beside where it goes, checked against its SHA-256,
//! then moved into the app's folder and opened read-only. Progress and the outcome go out as
//! `<event>` events with the dataset's status.

use crate::error::{Code, Error, Result};
use crate::store::Emit;
use crate::types::DataStatus;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Where a dataset comes from and what it must be.
pub struct Source {
    /// What it is called in messages ("Word origins").
    pub name: &'static str,
    pub url: &'static str,
    pub file: &'static str,
    pub download_bytes: u64,
    pub disk_bytes: u64,
    pub sha256: &'static str,
    /// The `schema_version` in its `meta` table that this version of the app reads.
    pub schema: &'static str,
    pub event: &'static str,
}

pub struct Dataset {
    src: &'static Source,
    path: PathBuf,
    emit: Emit,
    state: Arc<Mutex<DataStatus>>,
    cancel: Arc<AtomicBool>,
    db: Mutex<Option<Connection>>,
}

fn status(src: &Source, state: &str, received: u64, error: Option<String>) -> DataStatus {
    DataStatus { state: state.into(), received, download_bytes: src.download_bytes, disk_bytes: src.disk_bytes, error }
}

impl Dataset {
    pub fn new(src: &'static Source, app_data: &Path, emit: Emit) -> Dataset {
        let path = app_data.join(src.file);
        let state = status(src, if path.exists() { "ready" } else { "missing" }, 0, None);
        Dataset {
            src,
            path,
            emit,
            state: Arc::new(Mutex::new(state)),
            cancel: Arc::new(AtomicBool::new(false)),
            db: Mutex::new(None),
        }
    }

    pub fn status(&self) -> DataStatus {
        self.state.lock().unwrap().clone()
    }

    /// Starts the download (once); progress and the outcome come as events.
    pub fn download(&self) -> DataStatus {
        {
            let mut s = self.state.lock().unwrap();
            if matches!(s.state.as_str(), "downloading" | "unpacking" | "ready") {
                return s.clone();
            }
            *s = status(self.src, "downloading", 0, None);
        }
        self.cancel.store(false, Ordering::SeqCst);
        let (src, path, state, emit, cancel) =
            (self.src, self.path.clone(), self.state.clone(), self.emit.clone(), self.cancel.clone());
        tauri::async_runtime::spawn(async move {
            let result = fetch(src, &path, &state, &emit, &cancel).await;
            let s = {
                let mut s = state.lock().unwrap();
                *s = match result {
                    Ok(()) => status(src, "ready", src.download_bytes, None),
                    Err(_) if cancel.load(Ordering::SeqCst) => status(src, "missing", 0, None),
                    Err(e) => {
                        log::warn!("{} wasn't downloaded: {}", src.name, e.message);
                        status(src, "failed", 0, Some(e.message))
                    }
                };
                s.clone()
            };
            emit(src.event, serde_json::to_value(s).unwrap_or_default());
        });
        self.status()
    }

    pub fn cancel(&self) -> DataStatus {
        self.cancel.store(true, Ordering::SeqCst);
        self.status()
    }

    /// Runs `f` on the database, opened read-only the first time.
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T> {
        let mut db = self.db.lock().unwrap();
        if db.is_none() {
            if !self.path.exists() {
                return Err(Error::not_found(format!("{} isn’t downloaded yet.", self.src.name)));
            }
            let c = Connection::open_with_flags(
                &self.path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            let version: Option<String> =
                c.query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| r.get(0)).optional()?;
            if version.as_deref() != Some(self.src.schema) {
                return Err(Error::invalid(format!("{} is of a kind this version doesn’t read.", self.src.name)));
            }
            *db = Some(c);
        }
        Ok(f(db.as_ref().unwrap())?)
    }
}

/// The download: the gzipped file, then unpacked and checked, then put in place.
async fn fetch(src: &Source, path: &Path, state: &Mutex<DataStatus>, emit: &Emit, cancel: &AtomicBool) -> Result<()> {
    let net = |e: reqwest::Error| Error::io(format!("The download didn’t complete ({e})."));
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder().user_agent("Librarium").build().map_err(net)?;
    let mut res = client.get(src.url).send().await.map_err(net)?.error_for_status().map_err(net)?;
    let gz = path.with_extension("db.gz.part");
    let mut out = BufWriter::new(File::create(&gz)?);
    let (mut received, mut told) = (0u64, Instant::now());
    let tell = |s: DataStatus| {
        *state.lock().unwrap() = s.clone();
        emit(src.event, serde_json::to_value(s).unwrap_or_default());
    };
    while let Some(chunk) = res.chunk().await.map_err(net)? {
        if cancel.load(Ordering::SeqCst) {
            drop(out);
            let _ = fs::remove_file(&gz);
            return Err(Error::new(Code::Cancelled, "cancelled"));
        }
        out.write_all(&chunk)?;
        received += chunk.len() as u64;
        if told.elapsed() > Duration::from_millis(250) {
            told = Instant::now();
            tell(status(src, "downloading", received, None));
        }
    }
    out.flush()?;
    drop(out);
    tell(status(src, "unpacking", received, None));
    let (dst, sha) = (path.to_path_buf(), src.sha256);
    tauri::async_runtime::spawn_blocking(move || unpack(&gz, &dst, sha)).await.map_err(|e| Error::io(e.to_string()))?
}

/// Unpacks the download beside where it goes, checks it, and moves it there.
fn unpack(gz: &Path, dst: &Path, sha256: &str) -> Result<()> {
    let part = dst.with_extension("db.part");
    let result = (|| -> Result<()> {
        let mut input = flate2::read::GzDecoder::new(BufReader::new(File::open(gz)?));
        let mut out = BufWriter::new(File::create(&part)?);
        let mut hash = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = input.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hash.update(&buf[..n]);
            out.write_all(&buf[..n])?;
        }
        out.into_inner().map_err(|e| Error::io(e.to_string()))?.sync_all()?;
        let got: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if got != sha256 {
            return Err(Error::io("The download was damaged; try again."));
        }
        fs::rename(&part, dst)?;
        Ok(())
    })();
    let _ = fs::remove_file(gz);
    if result.is_err() {
        let _ = fs::remove_file(&part);
    }
    result
}
