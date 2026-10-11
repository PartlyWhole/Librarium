//! Word origins: the database the `etym` tool builds from Wiktionary and other dictionaries,
//! read-only SQLite in the app's folder (`etymology.db`). It isn't shipped with the app: it is
//! downloaded once, when asked, from a release of this repository, unpacked, and checked against
//! its SHA-256 before it is used. The queries follow the database's contract (schema version 2):
//! terms are named by their stable keys, and links weaker than 0.4 are left out.

use crate::error::{Code, Error, Result};
use crate::store::Emit;
use crate::types::{EtymEntry, EtymLookup, EtymRelatives, EtymSense, EtymStatus, EtymStep, EtymTerm};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::{HashSet, VecDeque};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use unicode_normalization::char::is_combining_mark;
use unicode_normalization::UnicodeNormalization;

/// The database, gzipped, as released; and the database it unpacks to.
const URL: &str = "https://github.com/PartlyWhole/Librarium/releases/download/etymology-2026-10-10/etymology.db.gz";
const DOWNLOAD_BYTES: u64 = 209_056_763;
const DISK_BYTES: u64 = 641_433_600;
const SHA256: &str = "3c3e60180fde332be81550329f6060d10874b6de6bcba10f2fc66f12ecc29769";
const FILE_NAME: &str = "etymology.db";
const MIN_CONFIDENCE: f64 = 0.4;

pub struct Etymology {
    path: PathBuf,
    emit: Emit,
    state: Arc<Mutex<EtymStatus>>,
    cancel: Arc<AtomicBool>,
    db: Mutex<Option<Connection>>,
}

fn status(state: &str, received: u64, error: Option<String>) -> EtymStatus {
    EtymStatus { state: state.into(), received, download_bytes: DOWNLOAD_BYTES, disk_bytes: DISK_BYTES, error }
}

impl Etymology {
    pub fn new(app_data: &Path, emit: Emit) -> Etymology {
        let path = app_data.join(FILE_NAME);
        let state = status(if path.exists() { "ready" } else { "missing" }, 0, None);
        Etymology {
            path,
            emit,
            state: Arc::new(Mutex::new(state)),
            cancel: Arc::new(AtomicBool::new(false)),
            db: Mutex::new(None),
        }
    }

    pub fn status(&self) -> EtymStatus {
        self.state.lock().unwrap().clone()
    }

    /// Starts the download (once); progress and the outcome come as `etymology.status` events.
    pub fn download(&self) -> EtymStatus {
        {
            let mut s = self.state.lock().unwrap();
            if matches!(s.state.as_str(), "downloading" | "unpacking" | "ready") {
                return s.clone();
            }
            *s = status("downloading", 0, None);
        }
        self.cancel.store(false, Ordering::SeqCst);
        let (path, state, emit, cancel) =
            (self.path.clone(), self.state.clone(), self.emit.clone(), self.cancel.clone());
        tauri::async_runtime::spawn(async move {
            let result = fetch(&path, &state, &emit, &cancel).await;
            let s = {
                let mut s = state.lock().unwrap();
                *s = match result {
                    Ok(()) => status("ready", DOWNLOAD_BYTES, None),
                    Err(_) if cancel.load(Ordering::SeqCst) => status("missing", 0, None),
                    Err(e) => {
                        log::warn!("word origins weren't downloaded: {}", e.message);
                        status("failed", 0, Some(e.message))
                    }
                };
                s.clone()
            };
            emit("etymology.status", serde_json::to_value(s).unwrap_or_default());
        });
        self.status()
    }

    pub fn cancel(&self) -> EtymStatus {
        self.cancel.store(true, Ordering::SeqCst);
        self.status()
    }

    /// Runs `f` on the database, opened read-only the first time.
    fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T> {
        let mut db = self.db.lock().unwrap();
        if db.is_none() {
            if !self.path.exists() {
                return Err(Error::not_found("Word origins aren’t downloaded yet."));
            }
            let c = Connection::open_with_flags(
                &self.path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            let version: Option<String> =
                c.query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| r.get(0)).optional()?;
            if version.as_deref() != Some("2") {
                return Err(Error::invalid("The word origins database is of a kind this version doesn’t read."));
            }
            *db = Some(c);
        }
        Ok(f(db.as_ref().unwrap())?)
    }

    /// An English word: each of its entries (homographs), or words beginning with it.
    pub fn lookup(&self, word: &str) -> Result<EtymLookup> {
        let word = word.trim().trim_matches(|c: char| !c.is_alphanumeric() && c != '-' && c != '\'' && c != '’');
        self.with(|c| {
            let mut ids: Vec<i64> =
                ids_of(c, "SELECT id FROM terms WHERE lang = 'en' AND term = ?1 ORDER BY is_entry DESC, disc", word)?;
            if ids.is_empty() {
                ids = ids_of(
                    c,
                    "SELECT id FROM terms WHERE lang = 'en' AND norm = ?1 ORDER BY is_entry DESC, disc",
                    &norm(word),
                )?;
            }
            let entries = ids
                .into_iter()
                .take(4)
                .map(|id| entry(c, id))
                .collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .flatten()
                .collect::<Vec<_>>();
            let suggestions = if entries.is_empty() { search(c, word, 8)? } else { vec![] };
            Ok(EtymLookup { query: word.to_string(), entries, suggestions, attribution: attribution(c)? })
        })
    }

    /// Any term, by its key (an ancestor shown in a line of descent, say).
    pub fn term(&self, key: &str) -> Result<EtymLookup> {
        self.with(|c| {
            let id: Option<i64> = c.query_row("SELECT id FROM terms WHERE key = ?1", [key], |r| r.get(0)).optional()?;
            let entries = match id {
                Some(id) => entry(c, id)?.into_iter().collect(),
                None => vec![],
            };
            Ok(EtymLookup { query: key.to_string(), entries, suggestions: vec![], attribution: attribution(c)? })
        })
        .and_then(|l| {
            if l.entries.is_empty() {
                Err(Error::new(Code::NotFound, "That word isn’t in the word origins."))
            } else {
                Ok(l)
            }
        })
    }

    /// English words beginning with `q`, accents and case aside.
    pub fn search(&self, q: &str) -> Result<Vec<EtymTerm>> {
        self.with(|c| search(c, q, 12))
    }
}

/// The download: the gzipped file, then unpacked and checked, then put in place.
async fn fetch(path: &Path, state: &Mutex<EtymStatus>, emit: &Emit, cancel: &AtomicBool) -> Result<()> {
    let net = |e: reqwest::Error| Error::io(format!("The download didn’t complete ({e})."));
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder().user_agent("Librarium").build().map_err(net)?;
    let mut res = client.get(URL).send().await.map_err(net)?.error_for_status().map_err(net)?;
    let gz = path.with_extension("db.gz.part");
    let mut out = BufWriter::new(File::create(&gz)?);
    let (mut received, mut told) = (0u64, Instant::now());
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
            let s = status("downloading", received, None);
            *state.lock().unwrap() = s.clone();
            emit("etymology.status", serde_json::to_value(s).unwrap_or_default());
        }
    }
    out.flush()?;
    drop(out);
    let s = status("unpacking", received, None);
    *state.lock().unwrap() = s.clone();
    emit("etymology.status", serde_json::to_value(s).unwrap_or_default());
    let dst = path.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || unpack(&gz, &dst)).await.map_err(|e| Error::io(e.to_string()))?
}

/// Unpacks the download beside where it goes, checks it, and moves it there.
fn unpack(gz: &Path, dst: &Path) -> Result<()> {
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
        if got != SHA256 {
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

/// As the database's `norm`: lower case, accents taken off, no leading `*`.
fn norm(s: &str) -> String {
    s.trim().trim_start_matches('*').to_lowercase().nfd().filter(|c| !is_combining_mark(*c)).collect()
}

fn ids_of(c: &Connection, sql: &str, word: &str) -> rusqlite::Result<Vec<i64>> {
    c.prepare_cached(sql)?.query_map([word], |r| r.get(0))?.collect()
}

fn attribution(c: &Connection) -> rusqlite::Result<String> {
    Ok(c.query_row("SELECT value FROM meta WHERE key = 'attribution'", [], |r| r.get(0))
        .optional()?
        .unwrap_or_default())
}

fn search(c: &Connection, q: &str, limit: u32) -> rusqlite::Result<Vec<EtymTerm>> {
    let q = norm(q);
    if q.is_empty() {
        return Ok(vec![]);
    }
    let mut st = c.prepare_cached(
        "SELECT id FROM terms WHERE norm >= ?1 AND norm < ?1 || char(1114111) AND is_entry = 1 AND lang = 'en'
         ORDER BY norm = ?1 DESC, length(norm), norm LIMIT ?2",
    )?;
    let ids: Vec<i64> = st.query_map(params![q, limit], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    let mut seen = HashSet::new();
    Ok(ids.into_iter().filter_map(|id| node(c, id).ok().flatten()).filter(|t| seen.insert(t.term.clone())).collect())
}

/// A term, briefly.
fn node(c: &Connection, id: i64) -> rusqlite::Result<Option<EtymTerm>> {
    c.prepare_cached(
        "SELECT t.key, t.lang, l.name, t.term, t.gloss FROM terms t JOIN langs l ON l.code = t.lang WHERE t.id = ?1",
    )?
    .query_row([id], |r| {
        Ok(EtymTerm { key: r.get(0)?, lang: r.get(1)?, lang_name: r.get(2)?, term: r.get(3)?, gloss: r.get(4)? })
    })
    .optional()
}

/// Everything shown for a term: its senses and prose, its main line of descent, its sideways
/// links, and (English) the words it shares ancestors with or (older) the English words from it.
fn entry(c: &Connection, id: i64) -> rusqlite::Result<Option<EtymEntry>> {
    let Some(term) = node(c, id)? else { return Ok(None) };
    let (pos, senses, etymology): (Option<String>, Option<String>, Option<String>) = c
        .prepare_cached("SELECT pos, senses, etymology FROM entries WHERE term_id = ?1")?
        .query_row([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()?
        .unwrap_or_default();
    let senses = senses
        .and_then(|s| serde_json::from_str::<Vec<serde_json::Value>>(&s).ok())
        .unwrap_or_default()
        .iter()
        .filter_map(|v| {
            Some(EtymSense { pos: v["pos"].as_str().map(String::from), gloss: v["gloss"].as_str()?.to_string() })
        })
        .take(4)
        .collect();
    let (mut doublets, mut cognates, mut roots) = (vec![], vec![], vec![]);
    let mut st = c.prepare_cached("SELECT dst, kind FROM links WHERE src = ?1 AND kind IN ('doublet', 'cognate', 'root') AND confidence >= ?2 ORDER BY confidence DESC, id LIMIT 80")?;
    for row in st.query_map(params![id, MIN_CONFIDENCE], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
        let (dst, kind) = row?;
        let Some(t) = node(c, dst)? else { continue };
        match kind.as_str() {
            "doublet" => doublets.push(t),
            "cognate" if cognates.len() < 16 => cognates.push(t),
            "root" => roots.push(t),
            _ => {}
        }
    }
    let english = term.lang == "en";
    Ok(Some(EtymEntry {
        lineage: lineage(c, id)?,
        relatives: if english { relatives(c, id)? } else { vec![] },
        descendants: if english { vec![] } else { english_from(c, id, 60, &HashSet::new())?.0 },
        term,
        pos,
        senses,
        etymology,
        doublets,
        cognates,
        roots,
    }))
}

/// The main line of descent, from the precomputed main parents (at most 30 steps).
fn lineage(c: &Connection, id: i64) -> rusqlite::Result<Vec<EtymStep>> {
    let mut out = vec![];
    let mut seen = HashSet::from([id]);
    let (mut cur, mut rel, mut with) = (id, None, vec![]);
    let mut st = c.prepare_cached("SELECT parent_id, rel, with_terms FROM main_parent WHERE term_id = ?1")?;
    loop {
        let Some(t) = node(c, cur)? else { break };
        out.push(EtymStep { term: t, rel: rel.take(), with: std::mem::take(&mut with) });
        let next: Option<(i64, Option<String>, Option<String>)> =
            st.query_row([cur], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?;
        let Some((parent, r, w)) = next else { break };
        if !seen.insert(parent) || out.len() > 30 {
            break;
        }
        // The other parts of a compound, by their spelling (keys are `lang:term`).
        with = w
            .and_then(|w| serde_json::from_str::<Vec<String>>(&w).ok())
            .unwrap_or_default()
            .into_iter()
            .map(|k| k.split_once(':').map(|(_, t)| t.to_string()).unwrap_or(k))
            .collect();
        (cur, rel) = (parent, r);
    }
    Ok(out)
}

/// Every ancestor (origins and parts), nearest first.
fn ancestors(c: &Connection, id: i64) -> rusqlite::Result<Vec<i64>> {
    let mut st = c.prepare_cached(
        "SELECT dst FROM links WHERE src = ?1 AND kind IN ('origin', 'part') AND confidence >= ?2 ORDER BY id",
    )?;
    let mut seen = HashSet::from([id]);
    let mut queue = VecDeque::from([(id, 0)]);
    let mut out = vec![];
    while let Some((n, depth)) = queue.pop_front() {
        if depth >= 12 {
            continue;
        }
        for dst in st.query_map(params![n, MIN_CONFIDENCE], |r| r.get::<_, i64>(0))? {
            let dst = dst?;
            if seen.insert(dst) {
                out.push(dst);
                queue.push_back((dst, depth + 1));
            }
        }
    }
    Ok(out)
}

/// English dictionary words that come from a term, nearest first (at most `limit`, of
/// `total` found), leaving out `skip`.
fn english_from(c: &Connection, id: i64, limit: usize, skip: &HashSet<i64>) -> rusqlite::Result<(Vec<EtymTerm>, u32)> {
    let mut st =
        c.prepare_cached("SELECT src FROM links WHERE dst = ?1 AND kind IN ('origin', 'part') AND confidence >= ?2")?;
    let mut is_word = c.prepare_cached("SELECT lang = 'en' AND is_entry = 1, term FROM terms WHERE id = ?1")?;
    let mut seen = HashSet::from([id]);
    let mut queue = VecDeque::from([(id, 0)]);
    let mut found: Vec<(u32, String, i64)> = vec![];
    'walk: while let Some((n, depth)) = queue.pop_front() {
        if depth >= 12 {
            continue;
        }
        for src in st.query_map(params![n, MIN_CONFIDENCE], |r| r.get::<_, i64>(0))? {
            let src = src?;
            if !seen.insert(src) {
                continue;
            }
            queue.push_back((src, depth + 1));
            let (word, term): (bool, String) = is_word.query_row([src], |r| Ok((r.get(0)?, r.get(1)?)))?;
            if word && !skip.contains(&src) {
                found.push((depth + 1, term, src));
            }
            // A very productive root: enough to choose from.
            if seen.len() > 6000 {
                break 'walk;
            }
        }
    }
    // Plain single words first, then the shortest (usually the most familiar), nearest first.
    found.sort_by_key(|(depth, term, _)| {
        (
            term.contains(' ') || term.trim_matches('-').contains('-'),
            term.starts_with(char::is_uppercase),
            term.chars().count(),
            *depth,
            term.to_lowercase(),
        )
    });
    // Homographs once (seal, seal…).
    let mut spelled = HashSet::new();
    found.retain(|(_, term, _)| spelled.insert(term.clone()));
    let total = found.len() as u32;
    let words = found.into_iter().take(limit).filter_map(|(_, _, id)| node(c, id).ok().flatten()).collect();
    Ok((words, total))
}

/// English words sharing an ancestor with this one, each under its nearest shared ancestor
/// (affixes left out: everything shares "-ness").
fn relatives(c: &Connection, id: i64) -> rusqlite::Result<Vec<EtymRelatives>> {
    let mut seen = HashSet::from([id]);
    let mut out = vec![];
    for anc in ancestors(c, id)?.into_iter().take(16) {
        let Some(ancestor) = node(c, anc)? else { continue };
        let t = ancestor.term.trim_start_matches('*');
        if t.starts_with('-') || t.ends_with('-') {
            continue;
        }
        let (words, total) = english_from(c, anc, 16, &seen)?;
        if words.is_empty() {
            continue;
        }
        for w in &words {
            if let Ok(Some(i)) =
                c.query_row("SELECT id FROM terms WHERE key = ?1", [&w.key], |r| r.get::<_, i64>(0)).optional()
            {
                seen.insert(i);
            }
        }
        out.push(EtymRelatives { ancestor, words, total });
        if out.len() >= 5 {
            break;
        }
    }
    Ok(out)
}
