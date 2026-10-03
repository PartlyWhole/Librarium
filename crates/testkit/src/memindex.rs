//! A plain in-memory IndexEngine for the kernel's own tests (the kernel may not depend on the
//! SQLite adapter). It passes the same shared suite; its ranking is simpler.

use librarium_contracts::ports::{Cell, IndexEngine, OpenState, Passage, Row, TextHit, TextQuery, ViewIndex, ViewSpec};
use librarium_contracts::{BackendError, Result};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

#[derive(Default, Clone)]
struct Data {
    version: u32,
    tables: BTreeMap<String, BTreeMap<String, Row>>,
    meta: BTreeMap<String, String>,
    passages: Vec<Passage>,
}

/// Views persist across opens of the same engine (like files), until dropped.
type Views = Arc<Mutex<HashMap<String, Arc<Mutex<Data>>>>>;

#[derive(Default, Clone)]
pub struct MemIndex {
    views: Views,
}

impl MemIndex {
    pub fn new() -> Self {
        Self::default()
    }
}

struct View {
    spec: ViewSpec,
    data: Arc<Mutex<Data>>,
    rebuild_into: Option<Views>,
}

fn fresh(spec: &ViewSpec) -> Data {
    Data {
        version: spec.schema_version,
        tables: spec.tables.iter().map(|t| (t.name.clone(), BTreeMap::new())).collect(),
        ..Default::default()
    }
}

impl IndexEngine for MemIndex {
    fn open(&self, spec: &ViewSpec) -> Result<(Box<dyn ViewIndex>, OpenState)> {
        let mut views = self.views.lock().unwrap();
        if let Some(d) = views.get(&spec.name) {
            if d.lock().unwrap().version == spec.schema_version {
                return Ok((
                    Box::new(View { spec: spec.clone(), data: d.clone(), rebuild_into: None }),
                    OpenState::Ready,
                ));
            }
            let empty = Arc::new(Mutex::new(fresh(spec)));
            return Ok((Box::new(View { spec: spec.clone(), data: empty, rebuild_into: None }), OpenState::Empty));
        }
        let d = Arc::new(Mutex::new(fresh(spec)));
        views.insert(spec.name.clone(), d.clone());
        Ok((Box::new(View { spec: spec.clone(), data: d, rebuild_into: None }), OpenState::Empty))
    }
    fn rebuild(&self, spec: &ViewSpec) -> Result<Box<dyn ViewIndex>> {
        Ok(Box::new(View {
            spec: spec.clone(),
            data: Arc::new(Mutex::new(fresh(spec))),
            rebuild_into: Some(self.views.clone()),
        }))
    }
    fn drop_view(&self, name: &str) -> Result<()> {
        self.views.lock().unwrap().remove(name);
        Ok(())
    }
}

fn words(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_lowercase).collect()
}

enum Term {
    Prefix(String),
    Phrase(Vec<String>),
}

fn parse(q: &str) -> (Vec<Term>, Vec<Vec<String>>) {
    let (mut pos, mut neg) = (vec![], vec![]);
    let mut rest = q.trim();
    while !rest.is_empty() {
        let negated = rest.starts_with('-');
        if negated {
            rest = &rest[1..];
        }
        let (term, phrase, next) = if let Some(r) = rest.strip_prefix('"') {
            let end = r.find('"').unwrap_or(r.len());
            (&r[..end], true, r.get(end + 1..).unwrap_or(""))
        } else {
            let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
            (&rest[..end], false, &rest[end..])
        };
        let w = words(term);
        if !w.is_empty() {
            if negated {
                neg.push(w);
            } else if phrase || w.len() > 1 {
                pos.push(Term::Phrase(w));
            } else {
                pos.push(Term::Prefix(w[0].clone()));
            }
        }
        rest = next.trim_start();
    }
    (pos, neg)
}

fn contains_seq(hay: &[String], needle: &[String]) -> bool {
    needle.is_empty() || hay.windows(needle.len()).any(|w| w == needle)
}

impl View {
    fn cols(&self, table: &str) -> Result<Vec<String>> {
        self.spec
            .tables
            .iter()
            .find(|t| t.name == table)
            .map(|t| t.columns.clone())
            .ok_or_else(|| BackendError::internal(format!("no table {table}")))
    }
}

impl ViewIndex for View {
    fn begin(&mut self) -> Result<()> {
        Ok(())
    }
    fn commit(&mut self) -> Result<()> {
        Ok(())
    }
    fn put(&mut self, table: &str, row: Row) -> Result<()> {
        let cols = self.cols(table)?;
        if row.len() != cols.len() {
            return Err(BackendError::internal("wrong row length"));
        }
        let key = match &row[0] {
            Cell::Text(s) => s.clone(),
            Cell::Int(i) => i.to_string(),
            Cell::Null => return Err(BackendError::internal("null key")),
        };
        self.data.lock().unwrap().tables.get_mut(table).unwrap().insert(key, row);
        Ok(())
    }
    fn delete(&mut self, table: &str, key: &str) -> Result<()> {
        self.cols(table)?;
        self.data.lock().unwrap().tables.get_mut(table).unwrap().remove(key);
        Ok(())
    }
    fn delete_where(&mut self, table: &str, column: &str, value: &Cell) -> Result<()> {
        let i =
            self.cols(table)?.iter().position(|c| c == column).ok_or_else(|| BackendError::internal("no column"))?;
        self.data.lock().unwrap().tables.get_mut(table).unwrap().retain(|_, r| &r[i] != value);
        Ok(())
    }
    fn get(&self, table: &str, key: &str) -> Result<Option<Row>> {
        self.cols(table)?;
        Ok(self.data.lock().unwrap().tables[table].get(key).cloned())
    }
    fn find(&self, table: &str, column: &str, value: &Cell) -> Result<Vec<Row>> {
        let i =
            self.cols(table)?.iter().position(|c| c == column).ok_or_else(|| BackendError::internal("no column"))?;
        Ok(self.data.lock().unwrap().tables[table].values().filter(|r| &r[i] == value).cloned().collect())
    }
    fn all(&self, table: &str) -> Result<Vec<Row>> {
        self.cols(table)?;
        Ok(self.data.lock().unwrap().tables[table].values().cloned().collect())
    }
    fn meta_get(&self, key: &str) -> Result<Option<String>> {
        Ok(self.data.lock().unwrap().meta.get(key).cloned())
    }
    fn meta_put(&mut self, key: &str, value: &str) -> Result<()> {
        self.data.lock().unwrap().meta.insert(key.into(), value.into());
        Ok(())
    }
    fn put_passages(&mut self, record: &str, passages: &[Passage]) -> Result<()> {
        let mut d = self.data.lock().unwrap();
        d.passages.retain(|p| p.record != record);
        d.passages.extend(passages.iter().cloned());
        Ok(())
    }
    fn delete_passages(&mut self, record: &str) -> Result<()> {
        self.data.lock().unwrap().passages.retain(|p| p.record != record);
        Ok(())
    }
    fn search(&self, q: &TextQuery) -> Result<Vec<TextHit>> {
        let (pos, neg) = parse(&q.text);
        if pos.is_empty() {
            return Ok(vec![]);
        }
        let d = self.data.lock().unwrap();
        let mut hits = vec![];
        for p in &d.passages {
            if !q.kinds.is_empty() && !q.kinds.contains(&p.kind) {
                continue;
            }
            let (tw, bw) = (words(&p.title), words(&p.body));
            let all: Vec<String> = tw.iter().chain(bw.iter()).cloned().collect();
            let matches = |t: &Term, ws: &[String]| match t {
                Term::Prefix(w) => ws.iter().any(|x| x.starts_with(w.as_str())),
                Term::Phrase(seq) => contains_seq(ws, seq),
            };
            if !pos.iter().all(|t| matches(t, &all)) || neg.iter().any(|n| contains_seq(&all, n)) {
                continue;
            }
            let score: f64 = pos
                .iter()
                .map(|t| if matches(t, &tw) { 10.0 } else { 0.0 } + if matches(t, &bw) { 1.0 } else { 0.0 })
                .sum();
            let snippet = p
                .body
                .split(' ')
                .map(|w| {
                    let lw = words(w);
                    if pos.iter().any(|t| matches(t, &lw)) {
                        format!("\u{2}{w}\u{3}")
                    } else {
                        w.to_string()
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");
            hits.push(TextHit {
                record: p.record.clone(),
                kind: p.kind.clone(),
                ordinal: p.ordinal,
                offset: p.offset,
                title: p.title.clone(),
                snippet,
                score,
            });
        }
        hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
        hits.truncate(q.limit.max(1) as usize);
        Ok(hits)
    }
    fn finish_rebuild(self: Box<Self>) -> Result<Box<dyn ViewIndex>> {
        if let Some(views) = &self.rebuild_into {
            views.lock().unwrap().insert(self.spec.name.clone(), self.data.clone());
        }
        Ok(Box::new(View { spec: self.spec, data: self.data, rebuild_into: None }))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn passes_the_shared_suite() {
        crate::suites::index::run(&super::MemIndex::new(), true);
    }
}
