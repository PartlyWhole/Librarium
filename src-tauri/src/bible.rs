//! The Bible: eight English versions verse by verse, the Hebrew and Greek word by word, and their
//! lexicons, in `bible.db` (built by tools/bible/build.py), read-only in the app's folder and
//! downloaded once when asked (see dataset.rs). Verses are addressed by STEPBible's book names
//! and the KJV's chapter and verse numbers, so every version lines up; Strong's numbers link the
//! English words (KJV, BSB) to the Hebrew and Greek, and those to the lexicons.

use crate::dataset::{Dataset, Source};
use crate::error::{Error, Result};
use crate::library::{saved_with, FORMAT, KIND};
use crate::store::{files, record, Emit, Library};
use crate::types::{
    BibleBook, BibleChapter, BibleGrammar, BibleInfo, BibleLexEntry, BibleRef, BibleTag, BibleVerse, BibleVersion,
    BibleWord, BibleWordStudy, Written,
};
use crate::util::{iso_utc, json_bytes, new_id, now_ms};
use rusqlite::{params, OptionalExtension};
use serde_json::json;
use std::collections::BTreeMap;
use std::path::Path;

static SOURCE: Source = Source {
    name: "The Bible",
    url: "https://github.com/PartlyWhole/Librarium/releases/download/bible-2026-10-12/bible.db.gz",
    file: "bible.db",
    download_bytes: 63_181_004,
    disk_bytes: 196_399_104,
    sha256: "2cb5443efd757b157d24e503a8a03e8cda712c88bdec4418b23959725922d3c1",
    schema: "1",
    event: "bible.status",
};

/// The field naming the version a Bible item stands for.
pub const VERSION_FIELD: &str = "bible.version";

/// How many verses a word study lists.
const STUDY_VERSES: u32 = 300;

pub struct Bible {
    pub data: Dataset,
}

impl Bible {
    pub fn new(app_data: &Path, emit: Emit) -> Bible {
        Bible { data: Dataset::new(&SOURCE, app_data, emit) }
    }

    /// A version's library item, which captures from it cite: the one there is, or a new one
    /// (its record only; the text stays in the Bible's database).
    pub fn record(&self, lib: &Library, version: &str) -> Result<Written> {
        let name: Option<String> = self
            .data
            .with(|c| c.query_row("SELECT name FROM versions WHERE id = ?1", [version], |r| r.get(0)).optional())?;
        let name = name.ok_or_else(|| Error::not_found("There is no such version."))?;
        let w = lib.write();
        if let Some(e) = lib.index.with_field(VERSION_FIELD, version)?.into_iter().find(|e| e.kind == KIND) {
            return Ok(Written { info: record::info(lib, &e), seq: w.seq() });
        }
        let at = iso_utc(now_ms());
        let rec = json!({
            "id": new_id(),
            "kind": KIND,
            "kind-version": 1,
            "created": at,
            "title": name,
            FORMAT: "bible",
            VERSION_FIELD: version,
            "provenance": { "saved-at": at, "saved-with": saved_with("Bible"), "source": SOURCE.url },
        });
        let stage = files::stage_dir(lib)?;
        let made = files::stage_file(&stage, "record.json", &json_bytes(&rec, true))
            .and_then(|_| files::import_item(&w, &stage));
        let _ = std::fs::remove_dir_all(&stage);
        let e = made?;
        Ok(Written { info: record::info(lib, &e), seq: w.seq() })
    }

    /// The versions and books.
    pub fn info(&self) -> Result<BibleInfo> {
        self.data.with(|c| {
            let versions = c
                .prepare("SELECT id, name, year, license, attribution, strongs FROM versions ORDER BY ord")?
                .query_map([], |r| {
                    Ok(BibleVersion {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        year: r.get(2)?,
                        license: r.get(3)?,
                        attribution: r.get(4)?,
                        strongs: r.get(5)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            let books = c
                .prepare(
                    "SELECT b.id, b.name, b.testament, (SELECT max(chapter) FROM verses v WHERE v.version = 'kjv' AND v.book = b.id)
                     FROM books b ORDER BY b.ord",
                )?
                .query_map([], |r| {
                    Ok(BibleBook { id: r.get(0)?, name: r.get(1)?, testament: r.get(2)?, chapters: r.get(3)? })
                })?
                .collect::<rusqlite::Result<_>>()?;
            let attribution: String = c
                .query_row("SELECT value FROM meta WHERE key = 'attribution'", [], |r| r.get(0))
                .optional()?
                .unwrap_or_default();
            Ok(BibleInfo { versions, books, attribution })
        })
    }

    /// A chapter in the versions asked for, with the tagged versions' words, and the Hebrew or
    /// Greek word by word if asked.
    pub fn chapter(&self, book: &str, chapter: u32, versions: &[String], original: bool) -> Result<BibleChapter> {
        self.data.with(|c| {
            let mut verses: BTreeMap<u32, BibleVerse> = BTreeMap::new();

            let mut text = c.prepare_cached("SELECT verse, text FROM verses WHERE version = ?1 AND book = ?2 AND chapter = ?3")?;
            let mut tags = c.prepare_cached(
                "SELECT verse, text, strongs FROM tags WHERE version = ?1 AND book = ?2 AND chapter = ?3 ORDER BY verse, pos",
            )?;
            for v in versions {
                for row in text.query_map(params![v, book, chapter], |r| Ok((r.get::<_, u32>(0)?, r.get::<_, String>(1)?)))? {
                    let (n, t) = row?;
                    at(&mut verses, n).texts.insert(v.clone(), t);
                }
                for row in tags.query_map(params![v, book, chapter], |r| {
                    Ok((r.get::<_, u32>(0)?, BibleTag { text: r.get(1)?, strongs: r.get(2)? }))
                })? {
                    let (n, t) = row?;
                    at(&mut verses, n).tags.entry(v.clone()).or_default().push(t);
                }
            }
            // The Greek as in Nestle-Aland (words only in other editions are left out).
            if original {
                let mut words = c.prepare_cached(
                    "SELECT verse, text, translit, gloss, strongs, grammar, lang FROM words
                     WHERE book = ?1 AND chapter = ?2 AND (lang != 'G' OR kind GLOB '*[Nn]*') ORDER BY verse, id",
                )?;
                for row in words.query_map(params![book, chapter], |r| {
                    Ok((
                        r.get::<_, u32>(0)?,
                        BibleWord {
                            text: r.get(1)?,
                            translit: r.get(2)?,
                            gloss: r.get(3)?,
                            strongs: r.get(4)?,
                            grammar: r.get(5)?,
                            lang: r.get(6)?,
                        },
                    ))
                })? {
                    let (n, w) = row?;
                    at(&mut verses, n).words.push(w);
                }
            }
            Ok(BibleChapter { book: book.to_string(), chapter, verses: verses.into_values().collect() })
        })
    }

    /// A Strong's number (`H0430`, `H0430G`, `G3056`): its lexicon entries (the plain number's
    /// senses), how often its words occur, and the first verses they are in.
    pub fn word(&self, strongs: &str) -> Result<BibleWordStudy> {
        let strongs = strongs.trim().to_uppercase();
        let base = plain(&strongs);
        self.data.with(|c| {
            let entries = c
                .prepare_cached(
                    "SELECT strongs, lemma, translit, grammar, gloss, definition, relation FROM lexicon
                     WHERE base = ?1 ORDER BY strongs = ?2 DESC, strongs",
                )?
                .query_map(params![base, strongs], |r| {
                    Ok(BibleLexEntry {
                        strongs: r.get(0)?,
                        lemma: r.get(1)?,
                        translit: r.get(2)?,
                        grammar: r.get(3)?,
                        gloss: r.get(4)?,
                        definition: r.get(5)?,
                        relation: r.get(6)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            // The plain number and its senses (H0430, H0430G, H0430H…).
            let range = "strongs >= ?1 AND strongs < ?1 || 'Z'";
            let count: u32 =
                c.query_row(&format!("SELECT count(*) FROM words WHERE {range}"), [&base], |r| r.get(0))?;
            let verses = c
                .prepare_cached(&format!(
                    "SELECT w.book, w.chapter, w.verse, coalesce(v.text, '') FROM
                       (SELECT DISTINCT book, chapter, verse FROM words WHERE {range}) w
                       JOIN books b ON b.id = w.book
                       LEFT JOIN verses v ON v.version = 'kjv' AND v.book = w.book AND v.chapter = w.chapter AND v.verse = w.verse
                     ORDER BY b.ord, w.chapter, w.verse LIMIT ?2"
                ))?
                .query_map(params![base, STUDY_VERSES], |r| {
                    Ok(BibleRef { book: r.get(0)?, chapter: r.get(1)?, verse: r.get(2)?, text: r.get(3)? })
                })?
                .collect::<rusqlite::Result<_>>()?;
            Ok(BibleWordStudy { strongs, entries, count, verses })
        })
    }

    /// What a grammar code means: each morpheme's, for a Hebrew code like `HC/Td/Ncfsa`.
    pub fn grammar(&self, code: &str) -> Result<Vec<BibleGrammar>> {
        let lang = &code[..code.len().min(1)];
        let parts: Vec<String> = code
            .split('/')
            .enumerate()
            .map(
                |(i, p)| {
                    if i == 0 || lang == "G" || p.starts_with(lang) {
                        p.to_string()
                    } else {
                        format!("{lang}{p}")
                    }
                },
            )
            .collect();
        self.data.with(|c| {
            let mut st = c.prepare_cached("SELECT code, brief, description FROM grammar WHERE code = ?1")?;
            let mut out = vec![];
            for p in &parts {
                let g = st
                    .query_row([p], |r| Ok(BibleGrammar { code: r.get(0)?, brief: r.get(1)?, description: r.get(2)? }))
                    .optional()?;
                out.push(g.unwrap_or(BibleGrammar { code: p.clone(), brief: None, description: None }));
            }
            Ok(out)
        })
    }

    /// Verses of a version with all the words searched for, or the phrase if it is in quotes
    /// (the first 200, in order).
    pub fn search(&self, version: &str, query: &str) -> Result<Vec<BibleRef>> {
        // "In quotes": the phrase as it stands; otherwise every word, each as the start of a word.
        let phrase = query.trim().strip_prefix('"').map(|q| q.trim_end_matches('"'));
        let words = |q: &str| -> Vec<String> {
            q.split(|c: char| !c.is_alphanumeric() && c != '\'').filter(|w| !w.is_empty()).map(String::from).collect()
        };
        let q: Vec<String> = match phrase {
            Some(p) if !words(p).is_empty() => vec![format!("\"{}\"", words(p).join(" "))],
            _ => words(query).into_iter().map(|w| format!("\"{w}\"*")).collect(),
        };
        if q.is_empty() {
            return Ok(vec![]);
        }
        self.data.with(|c| {
            c.prepare_cached(
                "SELECT v.book, v.chapter, v.verse, v.text FROM verses_fts f JOIN verses v ON v.rowid = f.rowid
                 JOIN books b ON b.id = v.book
                 WHERE verses_fts MATCH ?1 AND v.version = ?2 ORDER BY b.ord, v.chapter, v.verse LIMIT 200",
            )?
            .query_map(params![q.join(" "), version], |r| {
                Ok(BibleRef { book: r.get(0)?, chapter: r.get(1)?, verse: r.get(2)?, text: r.get(3)? })
            })?
            .collect()
        })
    }
}

/// A chapter's verse, made the first time it is asked for.
fn at(verses: &mut BTreeMap<u32, BibleVerse>, n: u32) -> &mut BibleVerse {
    verses.entry(n).or_insert_with(|| BibleVerse {
        verse: n,
        texts: BTreeMap::new(),
        tags: BTreeMap::new(),
        words: vec![],
    })
}

/// The plain Strong's number: `H0430G` → `H0430`.
fn plain(s: &str) -> String {
    s.trim_end_matches(|c: char| c.is_ascii_alphabetic()).to_string()
}
