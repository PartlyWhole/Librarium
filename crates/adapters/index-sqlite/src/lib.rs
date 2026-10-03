//! IndexEngine port: one SQLite file per derived view, each stamped with its schema version,
//! with FTS5 (default tokenizer) for passages. `SqliteIndex::in_memory()` is the test adapter.

use librarium_contracts::ports::{
    Cell, IndexEngine, OpenState, Passage, Row, TableSpec, TextHit, TextQuery, ViewIndex, ViewSpec,
};
use librarium_contracts::{BackendError, Result};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, ToSql};
use std::path::{Path, PathBuf};

pub struct SqliteIndex {
    dir: Option<PathBuf>,
}

impl SqliteIndex {
    /// Views live in `dir`, one `<name>.sqlite` file each.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        SqliteIndex { dir: Some(dir.into()) }
    }
    /// The test adapter: every view is an in-memory database.
    pub fn in_memory() -> Self {
        SqliteIndex { dir: None }
    }
    fn path(&self, name: &str) -> Option<PathBuf> {
        self.dir.as_ref().map(|d| d.join(format!("{name}.sqlite")))
    }
}

fn err(e: impl std::fmt::Display) -> BackendError {
    BackendError::io(format!("index: {e}"))
}

fn ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

fn table_name(t: &str) -> String {
    ident(&format!("t_{t}"))
}

fn create_schema(c: &Connection, spec: &ViewSpec) -> Result<()> {
    let mut sql = String::from("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);\n");
    for t in &spec.tables {
        let cols: Vec<String> = t.columns.iter().map(|c| ident(c)).collect();
        sql.push_str(&format!(
            "CREATE TABLE IF NOT EXISTS {} ({}, PRIMARY KEY({})) WITHOUT ROWID;\n",
            table_name(&t.name),
            cols.join(", "),
            cols[0]
        ));
        for i in &t.indexed {
            sql.push_str(&format!(
                "CREATE INDEX IF NOT EXISTS {} ON {} ({});\n",
                ident(&format!("i_{}_{}", t.name, i)),
                table_name(&t.name),
                ident(i)
            ));
        }
    }
    if spec.text {
        sql.push_str("CREATE VIRTUAL TABLE IF NOT EXISTS passages USING fts5(title, body, record UNINDEXED, kind UNINDEXED, ordinal UNINDEXED, offset UNINDEXED);\n");
    }
    c.execute_batch(&sql).map_err(err)?;
    c.execute(
        "INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?1)",
        params![spec.schema_version.to_string()],
    )
    .map_err(err)?;
    Ok(())
}

fn connect(path: Option<&Path>) -> Result<Connection> {
    let c = match path {
        Some(p) => Connection::open(p).map_err(err)?,
        None => Connection::open_in_memory().map_err(err)?,
    };
    c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=OFF;").map_err(err)?;
    Ok(c)
}

fn stamped_version(c: &Connection) -> Option<u32> {
    c.query_row("SELECT value FROM _meta WHERE key = 'schema_version'", [], |r| r.get::<_, String>(0))
        .ok()?
        .parse()
        .ok()
}

fn remove_db(p: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{}", p.display(), suffix));
    }
}

impl IndexEngine for SqliteIndex {
    fn open(&self, spec: &ViewSpec) -> Result<(Box<dyn ViewIndex>, OpenState)> {
        let Some(path) = self.path(&spec.name) else {
            let c = connect(None)?;
            create_schema(&c, spec)?;
            return Ok((Box::new(SqliteView::new(c, spec.clone(), None)), OpenState::Empty));
        };
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d).map_err(err)?;
        }
        if path.exists() {
            match connect(Some(&path)) {
                Ok(c) if stamped_version(&c) == Some(spec.schema_version) && create_schema(&c, spec).is_ok() => {
                    return Ok((Box::new(SqliteView::new(c, spec.clone(), None)), OpenState::Ready));
                }
                Ok(c) if stamped_version(&c).is_some() => {
                    // Another schema version: keep the old file until a rebuild replaces it,
                    // and serve nothing meanwhile.
                    drop(c);
                    let c = connect(None)?;
                    create_schema(&c, spec)?;
                    return Ok((Box::new(SqliteView::new(c, spec.clone(), None)), OpenState::Empty));
                }
                _ => remove_db(&path), // damaged
            }
        }
        let c = connect(Some(&path))?;
        create_schema(&c, spec)?;
        Ok((Box::new(SqliteView::new(c, spec.clone(), None)), OpenState::Empty))
    }

    fn rebuild(&self, spec: &ViewSpec) -> Result<Box<dyn ViewIndex>> {
        let Some(path) = self.path(&spec.name) else {
            let c = connect(None)?;
            create_schema(&c, spec)?;
            return Ok(Box::new(SqliteView::new(c, spec.clone(), None)));
        };
        let tmp = PathBuf::from(format!("{}.new", path.display()));
        remove_db(&tmp);
        let c = connect(Some(&tmp))?;
        create_schema(&c, spec)?;
        Ok(Box::new(SqliteView::new(c, spec.clone(), Some((tmp, path)))))
    }

    fn drop_view(&self, name: &str) -> Result<()> {
        if let Some(p) = self.path(name) {
            remove_db(&p);
        }
        Ok(())
    }
}

pub struct SqliteView {
    c: Connection,
    spec: ViewSpec,
    /// While rebuilding: (new file, final path).
    rebuild: Option<(PathBuf, PathBuf)>,
    in_tx: bool,
}

impl SqliteView {
    fn new(c: Connection, spec: ViewSpec, rebuild: Option<(PathBuf, PathBuf)>) -> Self {
        SqliteView { c, spec, rebuild, in_tx: false }
    }
    fn table(&self, name: &str) -> Result<&TableSpec> {
        self.spec
            .tables
            .iter()
            .find(|t| t.name == name)
            .ok_or_else(|| BackendError::internal(format!("view {} has no table {name}", self.spec.name)))
    }
    fn column(&self, t: &TableSpec, col: &str) -> Result<String> {
        if t.columns.iter().any(|c| c == col) {
            Ok(ident(col))
        } else {
            Err(BackendError::internal(format!("table {} has no column {col}", t.name)))
        }
    }
}

struct C<'a>(&'a Cell);
impl ToSql for C<'_> {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        use rusqlite::types::{ToSqlOutput, Value};
        Ok(match self.0 {
            Cell::Null => ToSqlOutput::Owned(Value::Null),
            Cell::Int(i) => ToSqlOutput::Owned(Value::Integer(*i)),
            Cell::Text(s) => ToSqlOutput::Borrowed(rusqlite::types::ValueRef::Text(s.as_bytes())),
        })
    }
}

fn read_row(r: &rusqlite::Row, n: usize) -> rusqlite::Result<Row> {
    use rusqlite::types::ValueRef;
    (0..n)
        .map(|i| {
            Ok(match r.get_ref(i)? {
                ValueRef::Null => Cell::Null,
                ValueRef::Integer(x) => Cell::Int(x),
                ValueRef::Real(f) => Cell::Int(f as i64),
                ValueRef::Text(t) | ValueRef::Blob(t) => Cell::Text(String::from_utf8_lossy(t).into_owned()),
            })
        })
        .collect()
}

/// Translates the user's query into an FTS5 expression: words are prefix-matched,
/// `"phrases"` kept, and `-word` excluded. `None` if nothing positive remains.
pub fn fts_query(text: &str) -> Option<String> {
    let mut pos = vec![];
    let mut neg = vec![];
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
        let term: String;
        let phrase;
        if chars.peek() == Some(&'"') {
            chars.next();
            term = chars.by_ref().take_while(|c| *c != '"').collect();
            phrase = true;
        } else {
            term = chars.by_ref().take_while(|c| !c.is_whitespace()).collect();
            phrase = false;
        }
        // Keep letters and digits; FTS5's tokenizer ignores the rest anyway.
        let words: Vec<String> =
            term.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_string).collect();
        if words.is_empty() {
            continue;
        }
        let expr =
            if phrase || words.len() > 1 { format!("\"{}\"", words.join(" ")) } else { format!("\"{}\"*", words[0]) };
        if negated {
            neg.push(format!("\"{}\"", words.join(" ")));
        } else {
            pos.push(expr);
        }
    }
    if pos.is_empty() {
        return None;
    }
    let mut q = pos.join(" ");
    for n in neg {
        q = format!("{q} NOT {n}");
    }
    Some(q)
}

impl ViewIndex for SqliteView {
    fn begin(&mut self) -> Result<()> {
        if !self.in_tx {
            self.c.execute_batch("BEGIN").map_err(err)?;
            self.in_tx = true;
        }
        Ok(())
    }
    fn commit(&mut self) -> Result<()> {
        if self.in_tx {
            self.c.execute_batch("COMMIT").map_err(err)?;
            self.in_tx = false;
        }
        Ok(())
    }
    fn put(&mut self, table: &str, row: Row) -> Result<()> {
        let t = self.table(table)?.clone();
        if row.len() != t.columns.len() {
            return Err(BackendError::internal(format!(
                "row for {table} has {} cells, expected {}",
                row.len(),
                t.columns.len()
            )));
        }
        let marks: Vec<String> = (1..=row.len()).map(|i| format!("?{i}")).collect();
        let sql = format!("INSERT OR REPLACE INTO {} VALUES ({})", table_name(table), marks.join(", "));
        self.c.prepare_cached(&sql).map_err(err)?.execute(params_from_iter(row.iter().map(C))).map_err(err)?;
        Ok(())
    }
    fn delete(&mut self, table: &str, key: &str) -> Result<()> {
        let t = self.table(table)?.clone();
        let sql = format!("DELETE FROM {} WHERE {} = ?1", table_name(table), ident(&t.columns[0]));
        self.c.prepare_cached(&sql).map_err(err)?.execute(params![key]).map_err(err)?;
        Ok(())
    }
    fn delete_where(&mut self, table: &str, column: &str, value: &Cell) -> Result<()> {
        let t = self.table(table)?.clone();
        let sql = format!("DELETE FROM {} WHERE {} = ?1", table_name(table), self.column(&t, column)?);
        self.c.prepare_cached(&sql).map_err(err)?.execute([C(value)]).map_err(err)?;
        Ok(())
    }
    fn get(&self, table: &str, key: &str) -> Result<Option<Row>> {
        let t = self.table(table)?;
        let sql = format!("SELECT * FROM {} WHERE {} = ?1", table_name(table), ident(&t.columns[0]));
        let n = t.columns.len();
        self.c.prepare_cached(&sql).map_err(err)?.query_row(params![key], |r| read_row(r, n)).optional().map_err(err)
    }
    fn find(&self, table: &str, column: &str, value: &Cell) -> Result<Vec<Row>> {
        let t = self.table(table)?;
        let sql = format!("SELECT * FROM {} WHERE {} = ?1", table_name(table), self.column(t, column)?);
        let n = t.columns.len();
        let mut st = self.c.prepare_cached(&sql).map_err(err)?;
        let rows = st.query_map([C(value)], |r| read_row(r, n)).map_err(err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
    }
    fn all(&self, table: &str) -> Result<Vec<Row>> {
        let t = self.table(table)?;
        let sql = format!("SELECT * FROM {}", table_name(table));
        let n = t.columns.len();
        let mut st = self.c.prepare_cached(&sql).map_err(err)?;
        let rows = st.query_map([], |r| read_row(r, n)).map_err(err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
    }
    fn meta_get(&self, key: &str) -> Result<Option<String>> {
        self.c.query_row("SELECT value FROM _meta WHERE key = ?1", params![key], |r| r.get(0)).optional().map_err(err)
    }
    fn meta_put(&mut self, key: &str, value: &str) -> Result<()> {
        self.c
            .execute("INSERT OR REPLACE INTO _meta (key, value) VALUES (?1, ?2)", params![key, value])
            .map_err(err)?;
        Ok(())
    }
    fn put_passages(&mut self, record: &str, passages: &[Passage]) -> Result<()> {
        self.delete_passages(record)?;
        let mut st = self
            .c
            .prepare_cached(
                "INSERT INTO passages (title, body, record, kind, ordinal, offset) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .map_err(err)?;
        for p in passages {
            st.execute(params![p.title, p.body, p.record, p.kind, p.ordinal, p.offset]).map_err(err)?;
        }
        Ok(())
    }
    fn delete_passages(&mut self, record: &str) -> Result<()> {
        if !self.spec.text {
            return Ok(());
        }
        self.c
            .prepare_cached("DELETE FROM passages WHERE record = ?1")
            .map_err(err)?
            .execute(params![record])
            .map_err(err)?;
        Ok(())
    }
    fn search(&self, q: &TextQuery) -> Result<Vec<TextHit>> {
        let Some(expr) = fts_query(&q.text) else { return Ok(vec![]) };
        let mut sql = String::from(
            "SELECT record, kind, ordinal, offset, title, snippet(passages, 1, char(2), char(3), '…', 24), bm25(passages, 10.0, 1.0) AS rank \
             FROM passages WHERE passages MATCH ?1",
        );
        let mut args: Vec<String> = vec![expr];
        if !q.kinds.is_empty() {
            let marks: Vec<String> = (0..q.kinds.len()).map(|i| format!("?{}", i + 2)).collect();
            sql.push_str(&format!(" AND kind IN ({})", marks.join(", ")));
            args.extend(q.kinds.iter().cloned());
        }
        sql.push_str(&format!(" ORDER BY rank LIMIT {}", q.limit.max(1)));
        let mut st = self.c.prepare_cached(&sql).map_err(err)?;
        let rows = st
            .query_map(params_from_iter(args.iter()), |r| {
                Ok(TextHit {
                    record: r.get(0)?,
                    kind: r.get(1)?,
                    ordinal: r.get(2)?,
                    offset: r.get(3)?,
                    title: r.get(4)?,
                    snippet: r.get(5)?,
                    score: -r.get::<_, f64>(6)?,
                })
            })
            .map_err(err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
    }
    fn finish_rebuild(mut self: Box<Self>) -> Result<Box<dyn ViewIndex>> {
        self.commit()?;
        let Some((tmp, path)) = self.rebuild.take() else { return Ok(self) };
        self.c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").map_err(err)?;
        let spec = self.spec.clone();
        let SqliteView { c, .. } = *self;
        c.close().map_err(|(_, e)| err(e))?;
        remove_db(&path);
        std::fs::rename(&tmp, &path).map_err(err)?;
        for s in ["-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{}", tmp.display(), s));
        }
        let c = connect(Some(&path))?;
        Ok(Box::new(SqliteView::new(c, spec, None)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_memory_passes_the_shared_suite() {
        librarium_testkit::suites::index::run(&SqliteIndex::in_memory(), false);
    }

    #[test]
    fn files_pass_the_shared_suite_and_persist() {
        let dir = std::env::temp_dir().join(format!("librarium-idx-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        librarium_testkit::suites::index::run(&SqliteIndex::new(&dir), true);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn query_translation() {
        assert_eq!(fts_query("ellul tech").unwrap(), "\"ellul\"* \"tech\"*");
        assert_eq!(
            fts_query("\"the technological society\" -bad").unwrap(),
            "\"the technological society\" NOT \"bad\""
        );
        assert_eq!(fts_query("-only"), None);
        assert_eq!(fts_query("a\"b OR c").unwrap(), "\"a b\" \"OR\"* \"c\"*");
    }
}
