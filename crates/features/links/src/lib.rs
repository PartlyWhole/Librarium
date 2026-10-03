//! Links: references between records. Everything lists what points to it (backlinks).
//!
//! - The `links` view keeps every reference (source → target, with its label and context) and
//!   every unresolved link (no usable ID).
//! - The `links.repair` job keeps labels fresh (a label is a cache of the target's title; a
//!   stale label is never an error) and restores a missing ID from the label only when exactly
//!   one record has that title. It writes only through the writer's background lane, with a
//!   version check, when the folder is quiet, and never into a note with unsaved text.

use librarium_contracts::api::{Backlink, Unresolved};
use librarium_contracts::events::{Change, ChangeOp};
use librarium_contracts::ports::{Cell, TableSpec, ViewIndex, ViewSpec};
use librarium_contracts::{BackendError, ErrorCode, Id, Result};
use librarium_kernel::jobs::{JobCtx, JobKind};
use librarium_kernel::links::{format_link, parse_links};
use librarium_kernel::methods::{ApiMethod, MethodCtx};
use librarium_kernel::registry::{DuplicateId, Registry};
use librarium_kernel::store::Store;
use librarium_kernel::views::{DerivedView, ViewRecord};
use librarium_kernel::writer::Lane;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

pub const ID: &str = "links";
pub const VIEW: &str = "links";
const REFS: &str = "refs";
const UNRESOLVED: &str = "unresolved";

/// The line holding a link, with links shown as labels, shortened around it.
fn context(text: &str, range: std::ops::Range<usize>) -> String {
    let start = text[..range.start].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let end = text[range.end..].find('\n').map(|i| range.end + i).unwrap_or(text.len());
    let line = &text[start..end];
    let mut out = String::new();
    let mut last = 0;
    for l in parse_links(line) {
        out.push_str(&line[last..l.range.start]);
        out.push_str(&l.label);
        last = l.range.end;
    }
    out.push_str(&line[last..]);
    let out = out.trim().trim_start_matches(['#', '>', '-', '*', ' ']).trim().to_string();
    if out.chars().count() > 200 {
        out.chars().take(199).collect::<String>() + "…"
    } else {
        out
    }
}

pub struct LinksView;

impl DerivedView for LinksView {
    fn spec(&self) -> ViewSpec {
        ViewSpec {
            name: VIEW.into(),
            schema_version: 1,
            tables: vec![
                TableSpec {
                    name: REFS.into(),
                    columns: ["key", "source", "target", "label", "embed", "context"].map(String::from).to_vec(),
                    indexed: vec!["source".into(), "target".into()],
                },
                TableSpec {
                    name: UNRESOLVED.into(),
                    columns: ["key", "source", "label"].map(String::from).to_vec(),
                    indexed: vec!["source".into(), "label".into()],
                },
            ],
            text: false,
        }
    }
    fn apply(&self, idx: &mut dyn ViewIndex, rec: &ViewRecord) -> Result<()> {
        let src = rec.entry.id.to_string();
        self.remove(idx, rec.entry.id)?;
        for (n, l) in parse_links(rec.text).into_iter().enumerate() {
            let key = format!("{src}:{n}");
            match l.id {
                Some(t) => idx.put(
                    REFS,
                    vec![
                        key.into(),
                        src.clone().into(),
                        t.to_string().into(),
                        l.label.clone().into(),
                        Cell::Int(l.embed as i64),
                        context(rec.text, l.range.clone()).into(),
                    ],
                )?,
                None => idx.put(UNRESOLVED, vec![key.into(), src.clone().into(), l.label.into()])?,
            }
        }
        Ok(())
    }
    fn remove(&self, idx: &mut dyn ViewIndex, id: Id) -> Result<()> {
        let src = Cell::from(id.to_string());
        idx.delete_where(REFS, "source", &src)?;
        idx.delete_where(UNRESOLVED, "source", &src)
    }
}

fn views<'a>(ctx: &'a MethodCtx) -> Result<&'a librarium_kernel::views::ViewHost> {
    ctx.views.ok_or_else(|| BackendError::new(ErrorCode::NotReady, "The index is starting."))
}

/// Every record linking to `target`.
pub fn backlinks(store: &Store, v: &librarium_kernel::views::ViewHost, target: Id) -> Result<Vec<Backlink>> {
    let rows = v.query(VIEW, |idx| idx.find(REFS, "target", &Cell::from(target.to_string())))?;
    let mut out: Vec<Backlink> = rows
        .iter()
        .filter_map(|r| {
            let source: Id = r.get(1)?.text()?.parse().ok()?;
            let e = store.get(source)?;
            Some(Backlink {
                source,
                title: e.title,
                kind: e.kind,
                context: r.get(5)?.text().unwrap_or("").to_string(),
                embed: r.get(4)?.int() == Some(1),
            })
        })
        .collect();
    out.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    Ok(out)
}

pub fn unresolved(store: &Store, v: &librarium_kernel::views::ViewHost, source: Option<Id>) -> Result<Vec<Unresolved>> {
    let rows = v.query(VIEW, |idx| match source {
        Some(s) => idx.find(UNRESOLVED, "source", &Cell::from(s.to_string())),
        None => idx.all(UNRESOLVED),
    })?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let source: Id = r.get(1)?.text()?.parse().ok()?;
            Some(Unresolved {
                source,
                title: store.get(source).map(|e| e.title).unwrap_or_default(),
                label: r.get(2)?.text()?.to_string(),
            })
        })
        .collect())
}

#[derive(Deserialize)]
struct IdParam {
    #[serde(default)]
    id: Option<Id>,
}

pub fn contribute_views(v: &mut Vec<(String, Arc<dyn librarium_kernel::views::DerivedView>)>) {
    v.push((ID.into(), Arc::new(LinksView)));
}

pub fn contribute_methods(r: &mut Registry<ApiMethod>) -> Result<(), DuplicateId> {
    r.add(
        ID,
        "links.backlinks",
        Arc::new(|ctx: &MethodCtx, p: Value| {
            let p: IdParam = serde_json::from_value(p).map_err(|e| BackendError::invalid(e.to_string()))?;
            let id = p.id.ok_or_else(|| BackendError::invalid("id is required"))?;
            Ok(serde_json::to_value(backlinks(&ctx.library.store, views(ctx)?, id)?).unwrap())
        }),
    )?;
    r.add(
        ID,
        "links.unresolved",
        Arc::new(|ctx: &MethodCtx, p: Value| {
            let p: IdParam = serde_json::from_value(p).map_err(|e| BackendError::invalid(e.to_string()))?;
            Ok(serde_json::to_value(unresolved(&ctx.library.store, views(ctx)?, p.id)?).unwrap())
        }),
    )?;
    contribute_resolve(r)
}

/// Rewrites one source's links: stale labels of links to `target`, and missing IDs whose
/// label names exactly one record. Returns whether it wrote.
fn repair_source(ctx: &JobCtx, source: Id, refresh_target: Option<Id>) -> Result<bool> {
    let lib = ctx.library;
    let store = &lib.store;
    let Some(e) = store.get(source) else { return Ok(false) };
    if e.read_only.is_some() || lib.drafts.get(source).is_some() {
        return Ok(false);
    }
    let version = e.hash.clone();
    let store2 = lib.store.clone();
    let resolve = move |label: &str| -> Option<Id> {
        let hits = store2.find_by_title(label);
        (hits.len() == 1).then(|| hits[0].id)
    };
    let target_title = refresh_target.and_then(|t| store.get(t).map(|e| (t, e.title)));
    lib.write(Lane::Background, move |tx| {
        tx.repair_body(source, &version, |body| {
            let mut out = body.to_string();
            let mut changed = false;
            for l in parse_links(body).into_iter().rev() {
                let replacement = match (l.id, &target_title) {
                    (Some(id), Some((t, title))) if id == *t && !l.embed && l.label != *title && !title.is_empty() => {
                        Some(format_link(title, id, false))
                    }
                    (None, _) if !l.label.is_empty() => resolve(&l.label).map(|id| format_link(&l.label, id, l.embed)),
                    _ => None,
                };
                if let Some(r) = replacement {
                    out.replace_range(l.range.clone(), &r);
                    changed = true;
                }
            }
            changed.then_some(out)
        })
    })
    .or_else(|e| if e.code == ErrorCode::Conflict { Ok(false) } else { Err(e) })
}

fn repair(ctx: &JobCtx, p: &Value) -> Result<()> {
    let id: Id = p["id"].as_str().and_then(|s| s.parse().ok()).ok_or_else(|| BackendError::invalid("no id"))?;
    let seq = p["seq"].as_u64().unwrap_or(0);
    // Work from an index that has seen the change.
    ctx.views.wait_applied(seq, Duration::from_secs(30));
    // Only when the folder is quiet (no outside edits, no git operation in progress).
    for _ in 0..100 {
        if ctx.library.store.quiet() {
            break;
        }
        ctx.check_cancelled()?;
        std::thread::sleep(Duration::from_millis(100));
    }
    if !ctx.library.store.quiet() {
        return Ok(()); // labels are only a cache; a later change tries again
    }
    let store = &ctx.library.store;
    let Some(e) = store.get(id) else { return Ok(()) };
    if p["title_changed"].as_bool() == Some(true) {
        // Labels of links to this record.
        for b in backlinks(store, ctx.views, id)? {
            if !b.embed {
                repair_source(ctx, b.source, Some(id))?;
            }
        }
        // Unresolved links elsewhere that this record's title now resolves.
        let waiting: Vec<Id> = ctx
            .views
            .query(VIEW, |idx| idx.find(UNRESOLVED, "label", &Cell::from(e.title.clone())))?
            .iter()
            .filter_map(|r| r.get(1)?.text()?.parse().ok())
            .collect();
        for source in waiting {
            repair_source(ctx, source, None)?;
        }
    }
    // Unresolved links in this record.
    if !unresolved(store, ctx.views, Some(id))?.is_empty() {
        repair_source(ctx, id, None)?;
    }
    Ok(())
}

pub fn contribute_jobs(r: &mut Registry<JobKind>) -> Result<(), DuplicateId> {
    r.add(
        ID,
        "links.repair",
        JobKind {
            kind: "links.repair".into(),
            title: "Refreshing link labels".into(),
            noun: "link repairs".into(),
            resumable: false,
            one_at_a_time: false,
            run: Arc::new(repair),
            trigger: Some({
                // Last known titles, to tell when labels need refreshing.
                let titles: std::sync::Mutex<std::collections::HashMap<Id, String>> = Default::default();
                Arc::new(move |c: &Change, store: &Store| {
                    let mut t = titles.lock().unwrap();
                    if c.op == ChangeOp::Removed {
                        t.remove(&c.id);
                        return None;
                    }
                    let e = store.get(c.id)?;
                    let title_changed = t.insert(c.id, e.title.clone()).is_none_or(|old| old != e.title);
                    Some((c.id.to_string(), json!({ "id": c.id, "seq": c.seq, "title_changed": title_changed })))
                })
            }),
        },
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn context_shows_labels() {
        let t = "intro\n- See [[Weil|0192f3a4-7c1e-7b2a-9f00-3e5d8c1a2b44]] and [[Ellul|0192f3a4-7c1e-7b2a-9f00-3e5d8c1a2b45]].\nnext";
        let l = &librarium_kernel::links::parse_links(t)[0];
        assert_eq!(super::context(t, l.range.clone()), "See Weil and Ellul.");
    }
}

#[derive(Deserialize)]
struct ResolveParams {
    source: Id,
    label: String,
    target: Id,
}

/// The user chose the target of an unresolved link: `[[label]]` becomes `[[label|target]]`.
pub fn contribute_resolve(r: &mut Registry<ApiMethod>) -> Result<(), DuplicateId> {
    r.add(
        ID,
        "links.resolve",
        Arc::new(|ctx: &MethodCtx, p: Value| {
            let p: ResolveParams = serde_json::from_value(p).map_err(|e| BackendError::invalid(e.to_string()))?;
            let lib = ctx.library;
            let e = lib.store.get(p.source).ok_or_else(|| BackendError::not_found("no such record"))?;
            if lib.store.get(p.target).is_none() {
                return Err(BackendError::not_found("no such target"));
            }
            let version = e.hash;
            let wrote = lib.write(Lane::Interactive, move |tx| {
                tx.repair_body(p.source, &version, |body| {
                    let mut out = body.to_string();
                    let mut changed = false;
                    for l in parse_links(body).into_iter().rev() {
                        if l.id.is_none() && l.label == p.label {
                            out.replace_range(l.range.clone(), &format_link(&l.label, p.target, l.embed));
                            changed = true;
                        }
                    }
                    changed.then_some(out)
                })
            })?;
            Ok(json!({ "changed": wrote }))
        }),
    )
}
