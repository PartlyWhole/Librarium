//! The index: one SQLite file in the library's app data, holding the records table, the links
//! between records and the full-text passages. It is disposable: a file with another schema
//! version (or a damaged one) is deleted and rebuilt from the library folder.

use crate::error::{Error, Result};
use crate::links;
use crate::store::record::Entry;
use crate::types::{Backlink, SearchHit, Unresolved};
use crate::util::Id;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use serde_json::{Map, Value};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

/// Bump when the schema changes: the old file is then deleted and rebuilt.
const SCHEMA_VERSION: i64 = 1;
/// Passages are about this many words.
pub const PASSAGE_WORDS: usize = 120;

const SCHEMA: &str = "
CREATE TABLE records (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, path TEXT NOT NULL,
    size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, inode INTEGER NOT NULL, checked_ns INTEGER NOT NULL,
    hash TEXT NOT NULL, created TEXT, read_only TEXT, fields TEXT NOT NULL, archived INTEGER NOT NULL
);
CREATE INDEX records_path ON records (path);
CREATE INDEX records_title ON records (title);
CREATE TABLE links (
    source TEXT NOT NULL, n INTEGER NOT NULL, target TEXT, label TEXT NOT NULL,
    embed INTEGER NOT NULL, context TEXT NOT NULL, offset INTEGER NOT NULL, PRIMARY KEY (source, n)
) WITHOUT ROWID;
CREATE INDEX links_target ON links (target);
CREATE INDEX links_label ON links (label) WHERE target IS NULL;
CREATE VIRTUAL TABLE passages USING fts5(title, body, record UNINDEXED, offset UNINDEXED);
CREATE TABLE passage_rows (record TEXT NOT NULL, rid INTEGER NOT NULL);
CREATE INDEX passage_rows_record ON passage_rows (record);
";

const ENTRY_COLUMNS: &str =
    "id, kind, title, path, size, mtime_ns, inode, checked_ns, hash, created, read_only, fields";

pub struct Index {
    db: Mutex<Connection>,
}

fn connect(path: &Path) -> Result<Connection> {
    let c = Connection::open(path)?;
    c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;
    let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version == SCHEMA_VERSION {
        return Ok(c);
    }
    let fresh: i64 = c.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))?;
    if fresh != 0 {
        return Err(Error::io("the index has another schema version"));
    }
    c.execute_batch(SCHEMA)?;
    c.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
    Ok(c)
}

fn remove_db(path: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

fn entry(r: &Row) -> rusqlite::Result<Entry> {
    let id: String = r.get(0)?;
    let fields: String = r.get(11)?;
    Ok(Entry {
        id: id.parse().unwrap_or_default(),
        kind: r.get(1)?,
        title: r.get(2)?,
        path: r.get(3)?,
        size: r.get::<_, i64>(4)? as u64,
        mtime_ns: r.get(5)?,
        inode: r.get::<_, i64>(6)? as u64,
        checked_ns: r.get(7)?,
        hash: r.get(8)?,
        created: r.get(9)?,
        read_only: r.get(10)?,
        fields: serde_json::from_str(&fields).unwrap_or_default(),
    })
}

pub fn is_archived(fields: &Map<String, Value>) -> bool {
    fields.get("archive.at").is_some_and(|v| !v.is_null())
}

impl Index {
    /// Opens `index.sqlite`, replacing it when its schema version differs or it is damaged.
    pub fn open(path: &Path) -> Result<Index> {
        let c = connect(path).or_else(|e| {
            log::info!("rebuilding the index ({e})");
            remove_db(path);
            connect(path)
        })?;
        Ok(Index { db: Mutex::new(c) })
    }

    fn db(&self) -> MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Starts a batch of writes (a scan); `commit` ends it.
    pub fn begin(&self) -> Result<()> {
        let db = self.db();
        if db.is_autocommit() {
            db.execute_batch("BEGIN")?;
        }
        Ok(())
    }

    pub fn commit(&self) -> Result<()> {
        let db = self.db();
        if !db.is_autocommit() {
            db.execute_batch("COMMIT")?;
        }
        Ok(())
    }

    /// Forgets everything (before a rebuild from the folder).
    pub fn clear(&self) -> Result<()> {
        self.db()
            .execute_batch("DELETE FROM records; DELETE FROM links; DELETE FROM passages; DELETE FROM passage_rows;")?;
        Ok(())
    }

    fn entries(&self, filter: &str, args: &[&dyn rusqlite::ToSql]) -> Result<Vec<Entry>> {
        let db = self.db();
        let mut st = db.prepare_cached(&format!("SELECT {ENTRY_COLUMNS} FROM records {filter}"))?;
        let rows = st.query_map(args, entry)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn get(&self, id: Id) -> Option<Entry> {
        self.entries("WHERE id = ?1", &[&id.to_string()]).ok()?.pop()
    }

    pub fn at_path(&self, path: &str) -> Option<Entry> {
        self.entries("WHERE path = ?1", &[&path]).ok()?.pop()
    }

    /// Every record, or every record of one kind, in no particular order.
    pub fn list(&self, kind: Option<&str>) -> Result<Vec<Entry>> {
        match kind {
            Some(k) => self.entries("WHERE kind = ?1", &[&k]),
            None => self.entries("", &[]),
        }
    }

    pub fn with_title(&self, title: &str) -> Result<Vec<Entry>> {
        self.entries("WHERE title = ?1", &[&title])
    }

    /// Records whose field `key` is the string `value`.
    pub fn with_field(&self, key: &str, value: &str) -> Result<Vec<Entry>> {
        let path = format!("$.\"{}\"", key.replace('"', ""));
        self.entries("WHERE json_extract(fields, ?1) = ?2", &[&path, &value])
    }

    pub fn count(&self) -> u64 {
        self.db().query_row("SELECT count(*) FROM records", [], |r| r.get::<_, i64>(0)).unwrap_or(0) as u64
    }

    /// Indexes a record with its text (a Markdown body, or an item's stored text). Returns the
    /// title it had before, if it was indexed.
    pub fn put(&self, e: &Entry, text: &str, markdown: bool) -> Result<Option<String>> {
        let db = self.db();
        let id = e.id.to_string();
        let old: Option<String> =
            db.query_row("SELECT title FROM records WHERE id = ?1", [&id], |r| r.get(0)).optional()?;
        db.prepare_cached(
            "INSERT OR REPLACE INTO records VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        )?
        .execute(params![
            id,
            e.kind,
            e.title,
            e.path,
            e.size as i64,
            e.mtime_ns,
            e.inode as i64,
            e.checked_ns,
            e.hash,
            e.created,
            e.read_only,
            Value::Object(e.fields.clone()).to_string(),
            is_archived(&e.fields),
        ])?;
        forget_text(&db, &id)?;
        if markdown {
            put_links(&db, &id, text)?;
        }
        put_passages(&db, &id, &e.title, text)?;
        Ok(old)
    }

    /// Notes that a file was looked at and found unchanged.
    pub fn touch(&self, e: &Entry) -> Result<()> {
        self.db().execute(
            "UPDATE records SET size = ?2, mtime_ns = ?3, inode = ?4, checked_ns = ?5 WHERE id = ?1",
            params![e.id.to_string(), e.size as i64, e.mtime_ns, e.inode as i64, e.checked_ns],
        )?;
        Ok(())
    }

    /// Follows a record's file that moved (its contents are unchanged).
    pub fn set_path(&self, id: Id, path: &str) -> Result<()> {
        self.db().execute("UPDATE records SET path = ?2 WHERE id = ?1", params![id.to_string(), path])?;
        Ok(())
    }

    /// Forgets a record; returns what was indexed.
    pub fn remove(&self, id: Id) -> Result<Option<Entry>> {
        let gone = self.get(id);
        let db = self.db();
        let id = id.to_string();
        db.execute("DELETE FROM records WHERE id = ?1", [&id])?;
        forget_text(&db, &id)?;
        Ok(gone)
    }

    /// Ranked passages: BM25 with the title weighted above the body, words by prefix,
    /// `"phrases"` exactly, `-word` excluded. Archived records are left out, and the kind
    /// filter applies before the limit.
    pub fn search(&self, text: &str, kinds: &[String], limit: u32) -> Result<Vec<SearchHit>> {
        let Some(expr) = fts_query(text) else { return Ok(vec![]) };
        let mut sql = String::from(
            "SELECT passages.record, records.kind, records.title, \
             snippet(passages, 1, char(2), char(3), '…', 24), passages.offset, bm25(passages, 10.0, 1.0) AS rank \
             FROM passages JOIN records ON records.id = passages.record \
             WHERE passages MATCH ?1 AND records.archived = 0",
        );
        let mut args = vec![expr];
        if !kinds.is_empty() {
            let marks: Vec<String> = (0..kinds.len()).map(|i| format!("?{}", i + 2)).collect();
            sql.push_str(&format!(" AND records.kind IN ({})", marks.join(", ")));
            args.extend(kinds.iter().cloned());
        }
        sql.push_str(&format!(" ORDER BY rank LIMIT {}", limit.max(1)));
        let db = self.db();
        let mut st = db.prepare_cached(&sql)?;
        let rows = st.query_map(params_from_iter(args.iter()), |r| {
            Ok(SearchHit {
                id: r.get::<_, String>(0)?.parse().unwrap_or_default(),
                kind: r.get(1)?,
                title: r.get(2)?,
                snippet: r.get(3)?,
                offset: r.get(4)?,
                score: -r.get::<_, f64>(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Every link to `target`, with its source.
    pub fn backlinks(&self, target: Id) -> Result<Vec<Backlink>> {
        let db = self.db();
        let mut st = db.prepare_cached(
            "SELECT links.source, records.title, records.kind, links.context, links.embed, links.offset \
             FROM links JOIN records ON records.id = links.source WHERE links.target = ?1 \
             ORDER BY lower(records.title), links.source, links.n",
        )?;
        let rows = st.query_map([target.to_string()], |r| {
            Ok(Backlink {
                source: r.get::<_, String>(0)?.parse().unwrap_or_default(),
                title: r.get(1)?,
                kind: r.get(2)?,
                context: r.get(3)?,
                embed: r.get(4)?,
                offset: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Links without a usable ID, in one record or in all.
    pub fn unresolved(&self, source: Option<Id>) -> Result<Vec<Unresolved>> {
        let db = self.db();
        let mut st = db.prepare_cached(
            "SELECT links.source, records.title, links.label FROM links JOIN records ON records.id = links.source \
             WHERE links.target IS NULL AND (?1 IS NULL OR links.source = ?1) ORDER BY links.source, links.n",
        )?;
        let rows = st.query_map([source.map(|s| s.to_string())], |r| {
            Ok(Unresolved {
                source: r.get::<_, String>(0)?.parse().unwrap_or_default(),
                title: r.get(1)?,
                label: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Records with an unresolved link labelled `label`.
    pub fn unresolved_sources(&self, label: &str) -> Result<Vec<Id>> {
        let db = self.db();
        let mut st = db.prepare_cached("SELECT DISTINCT source FROM links WHERE target IS NULL AND label = ?1")?;
        let rows = st.query_map([label], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()?.parse().ok()).collect())
    }

    /// Whether a record has an unresolved link that a record's title could fill in.
    pub fn has_resolvable(&self, source: Id) -> bool {
        self.db()
            .query_row(
                "SELECT 1 FROM links JOIN records ON records.title = links.label \
                 WHERE links.source = ?1 AND links.target IS NULL LIMIT 1",
                [source.to_string()],
                |_| Ok(()),
            )
            .optional()
            .ok()
            .flatten()
            .is_some()
    }
}

fn forget_text(db: &Connection, id: &str) -> Result<()> {
    db.prepare_cached("DELETE FROM links WHERE source = ?1")?.execute([id])?;
    let rids: Vec<i64> = {
        let mut st = db.prepare_cached("SELECT rid FROM passage_rows WHERE record = ?1")?;
        let rows = st.query_map([id], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for rid in rids {
        db.prepare_cached("DELETE FROM passages WHERE rowid = ?1")?.execute([rid])?;
    }
    db.prepare_cached("DELETE FROM passage_rows WHERE record = ?1")?.execute([id])?;
    Ok(())
}

fn put_links(db: &Connection, id: &str, text: &str) -> Result<()> {
    let mut st = db.prepare_cached("INSERT INTO links VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")?;
    for (n, l) in links::parse_links(text).into_iter().enumerate() {
        let offset = text[..l.range.start].chars().count() as i64;
        let context = links::context(text, l.range.clone());
        st.execute(params![id, n as i64, l.id.map(|t| t.to_string()), l.label, l.embed, context, offset])?;
    }
    Ok(())
}

fn put_passages(db: &Connection, id: &str, title: &str, text: &str) -> Result<()> {
    let mut ps = passages(text, PASSAGE_WORDS);
    if ps.is_empty() {
        // The title alone is still findable.
        ps.push((0, String::new()));
    }
    for (offset, body) in ps {
        db.prepare_cached("INSERT INTO passages (title, body, record, offset) VALUES (?1, ?2, ?3, ?4)")?
            .execute(params![title, body, id, offset])?;
        let rid = db.last_insert_rowid();
        db.prepare_cached("INSERT INTO passage_rows VALUES (?1, ?2)")?.execute(params![id, rid])?;
    }
    Ok(())
}

/// Translates the user's query into an FTS5 expression: words are prefix-matched,
/// `"phrases"` kept, and `-word` excluded. `None` if nothing positive remains.
pub fn fts_query(text: &str) -> Option<String> {
    let (mut pos, mut neg) = (vec![], vec![]);
    let mut chars = text.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
            continue;
        }
        let negated = c == '-';
        if negated {
            chars.next();
        }
        let phrase = chars.peek() == Some(&'"');
        let term: String = if phrase {
            chars.next();
            chars.by_ref().take_while(|c| *c != '"').collect()
        } else {
            chars.by_ref().take_while(|c| !c.is_whitespace()).collect()
        };
        // Letters and digits only: FTS5's tokenizer ignores the rest anyway.
        let words: Vec<&str> = term.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect();
        if words.is_empty() {
            continue;
        }
        if negated {
            neg.push(format!("\"{}\"", words.join(" ")));
        } else if phrase || words.len() > 1 {
            pos.push(format!("\"{}\"", words.join(" ")));
        } else {
            pos.push(format!("\"{}\"*", words[0]));
        }
    }
    if pos.is_empty() {
        return None;
    }
    Some(neg.iter().fold(pos.join(" "), |q, n| format!("{q} NOT {n}")))
}

/// Splits text into passages of up to `max` words, at paragraph and then sentence ends.
/// Links show their labels. Returns (code-point offset into `text`, passage).
pub fn passages(text: &str, max: usize) -> Vec<(i64, String)> {
    // The text with links as their labels, and for each of its chars the source char index.
    let mut plain: Vec<char> = Vec::with_capacity(text.len());
    let mut map: Vec<usize> = Vec::with_capacity(text.len());
    let mut src = 0usize;
    let mut i = 0usize;
    let mut links = links::parse_links(text).into_iter().peekable();
    while i < text.len() {
        if links.peek().is_some_and(|l| l.range.start == i) {
            let l = links.next().unwrap();
            for ch in l.label.chars() {
                plain.push(ch);
                map.push(src);
            }
            src += text[l.range.clone()].chars().count();
            i = l.range.end;
            continue;
        }
        let ch = text[i..].chars().next().unwrap();
        plain.push(ch);
        map.push(src);
        src += 1;
        i += ch.len_utf8();
    }
    // Paragraphs, long ones split at sentences.
    let mut units: Vec<(usize, String)> = vec![];
    let (mut start, mut k) = (0, 0);
    while k <= plain.len() {
        if k == plain.len() || (plain[k] == '\n' && plain.get(k + 1) == Some(&'\n')) {
            let para: String = plain[start..k].iter().collect();
            if !para.trim().is_empty() {
                units.extend(split_long(&para, start, max));
            }
            while k < plain.len() && plain[k] == '\n' {
                k += 1;
            }
            start = k;
            if k == plain.len() {
                break;
            }
        } else {
            k += 1;
        }
    }
    // Small units are grouped up to the limit.
    let mut out: Vec<(i64, String)> = vec![];
    let mut cur: Option<(usize, String, usize)> = None;
    for (s, t) in units {
        let w = t.split_whitespace().count();
        match &mut cur {
            Some((_, text, words)) if *words + w <= max => {
                text.push_str("\n\n");
                text.push_str(&t);
                *words += w;
            }
            _ => {
                if let Some((s0, t0, _)) = cur.replace((s, t, w)) {
                    out.push((map.get(s0).copied().unwrap_or(0) as i64, t0));
                }
            }
        }
    }
    if let Some((s0, t0, _)) = cur {
        out.push((map.get(s0).copied().unwrap_or(0) as i64, t0));
    }
    out
}

/// Splits a paragraph longer than `max` words, preferring sentence ends.
fn split_long(para: &str, start: usize, max: usize) -> Vec<(usize, String)> {
    if para.split_whitespace().count() <= max {
        return vec![(start, para.trim_end().to_string())];
    }
    let chars: Vec<char> = para.chars().collect();
    let mut out = vec![];
    let (mut s, mut words, mut in_word) = (0, 0, false);
    let mut sentence_end = None;
    for (i, c) in chars.iter().enumerate() {
        if c.is_whitespace() {
            if in_word {
                words += 1;
            }
            in_word = false;
            if i > 0 && matches!(chars[i - 1], '.' | '!' | '?' | '…') {
                sentence_end = Some(i);
            }
        } else {
            in_word = true;
        }
        if words >= max {
            let cut = sentence_end.filter(|e| *e > s).unwrap_or(i);
            out.push((start + s, chars[s..cut].iter().collect::<String>().trim().to_string()));
            s = cut;
            while s < chars.len() && chars[s].is_whitespace() {
                s += 1;
            }
            words = chars[s..=i.max(s)].iter().collect::<String>().split_whitespace().count().saturating_sub(1);
            sentence_end = None;
        }
    }
    let rest: String = chars[s.min(chars.len())..].iter().collect();
    if !rest.trim().is_empty() {
        out.push((start + s, rest.trim().to_string()));
    }
    out
}
