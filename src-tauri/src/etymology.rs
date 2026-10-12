//! Word origins: the database the `etym` tool builds from Wiktionary and other dictionaries,
//! read-only SQLite in the app's folder (`etymology.db`), downloaded once when asked (see
//! dataset.rs). The queries follow the database's contract (schema version 2):
//! terms are named by their stable keys, and links weaker than 0.4 are left out.

use crate::dataset::{Dataset, Source};
use crate::error::{Code, Error, Result};
use crate::store::Emit;
use crate::types::{EtymEntry, EtymLookup, EtymRelatives, EtymSense, EtymStep, EtymTerm};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{HashSet, VecDeque};
use std::path::Path;
use unicode_normalization::char::is_combining_mark;
use unicode_normalization::UnicodeNormalization;

/// The database, gzipped, as released; and the database it unpacks to.
static SOURCE: Source = Source {
    name: "Word origins",
    url: "https://github.com/PartlyWhole/Librarium/releases/download/etymology-2026-10-11/etymology.db.gz",
    file: "etymology.db",
    download_bytes: 207_218_613,
    disk_bytes: 635_740_160,
    sha256: "548d12e9c88a894fdbc9bef45cf666c0d3af3a71eda3c13429c70e81382f8b6f",
    schema: "2",
    event: "etymology.status",
};
const MIN_CONFIDENCE: f64 = 0.4;

pub struct Etymology {
    pub data: Dataset,
}

impl Etymology {
    pub fn new(app_data: &Path, emit: Emit) -> Etymology {
        Etymology { data: Dataset::new(&SOURCE, app_data, emit) }
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T> {
        self.data.with(f)
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
