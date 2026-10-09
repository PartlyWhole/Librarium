//! The one IPC command, `call(method, params)`, and its dispatcher: each arm reads its
//! parameters, calls a module and returns the result as JSON.

use crate::app::{self, App};
use crate::error::{Error, Result};
use crate::store::frontmatter::FmValue;
use crate::store::{folders, record, Library};
use crate::types::*;
use crate::util::now_ms;
use crate::{archive, daily, history, links, notes};
use base64::Engine as _;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;

/// Every method, for `app.info`.
#[rustfmt::skip]
pub const METHODS: &[&str] = &[
    "app.info", "app.quit", "app.log", "app.openUrl", "app.revealLogs",
    "folder.status", "folder.open", "folder.close", "folder.inspect", "folder.reveal",
    "records.list", "records.get", "records.read", "records.text", "records.create", "records.save",
    "records.setFields", "records.relocate", "records.move",
    "folders.list", "folders.create", "folders.move", "folders.remove", "folders.setOrder",
    "settings.get", "settings.set",
    "drafts.put", "drafts.get", "drafts.list", "drafts.discard",
    "jobs.list", "jobs.retry", "jobs.cancel", "jobs.dismiss",
    "index.rebuild", "index.status",
    "export.write",
    "history.versions", "history.read", "history.diff", "history.restore", "history.deleted", "history.bringBack",
    "search.query",
    "links.backlinks", "links.unresolved", "links.resolve",
    "notes.create", "notes.folders",
    "daily.today",
    "archive.archive", "archive.restore", "archive.list", "archive.prepareDelete", "archive.delete",
];

/// Calls a method off the main thread. `app.quit` is answered here: the interface has saved
/// its work, so the library is closed and the app exits.
#[tauri::command]
pub async fn call(
    handle: tauri::AppHandle,
    app: tauri::State<'_, Arc<App>>,
    method: String,
    params: Option<Value>,
) -> Result<Value> {
    if method == "app.quit" {
        crate::quit(&handle);
        return Ok(Value::Null);
    }
    let app = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || dispatch(&app, &method, params.unwrap_or_default()))
        .await
        .map_err(|e| Error::io(format!("the call stopped: {e}")))?
}

fn p<T: DeserializeOwned>(v: Value) -> Result<T> {
    let v = if v.is_null() { json!({}) } else { v };
    serde_json::from_value(v).map_err(|e| Error::invalid(format!("bad parameters: {e}")))
}

fn ok<T: Serialize>(v: T) -> Result<Value> {
    serde_json::to_value(v).map_err(|e| Error::io(e.to_string()))
}

fn written(lib: &Library, e: &record::Entry, seq: u64) -> Written {
    Written { info: record::info(lib, e), seq }
}

/// Answers one call.
pub fn dispatch(app: &App, method: &str, params: Value) -> Result<Value> {
    let lib = || app.library();
    match method {
        "app.info" => ok(AppInfo {
            name: "Librarium".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            api_methods: METHODS.iter().map(|m| m.to_string()).collect(),
        }),
        "app.log" => {
            let l: LogParams = p(params)?;
            let msg: String = l.message.chars().take(4000).collect();
            match l.level.as_str() {
                "error" => log::error!(target: "interface", "{msg}"),
                "warn" => log::warn!(target: "interface", "{msg}"),
                _ => log::info!(target: "interface", "{msg}"),
            }
            ok(())
        }
        "app.openUrl" => ok(app::open_url(&p::<UrlParams>(params)?.url)?),
        "app.revealLogs" => {
            std::fs::create_dir_all(&app.logs)?;
            ok(app::reveal(&app.logs)?)
        }
        "folder.status" => ok(app.status()),
        "folder.open" => ok(app.open(Path::new(&p::<PathParams>(params)?.path))?),
        "folder.close" => {
            app.close();
            ok(app.status())
        }
        "folder.inspect" => ok(app::inspect(Path::new(&p::<PathParams>(params)?.path))),
        "folder.reveal" => ok(app::reveal(&lib()?.root)?),
        "settings.get" => ok(app.settings.all()),
        "settings.set" => ok(app.set_settings(p::<SettingsParams>(params)?.values)?),
        "export.write" => {
            let e: ExportParams = p(params)?;
            let bytes = match &e.data {
                Some(b64) => base64::engine::general_purpose::STANDARD
                    .decode(b64)
                    .map_err(|err| Error::invalid(format!("not base64: {err}")))?,
                None => e.text.into_bytes(),
            };
            ok(app.export(Path::new(&e.path), &bytes)?)
        }
        "daily.today" => {
            let start = app.settings.get("daily.dayStart").and_then(|v| v.as_u64()).map(|h| h as u32);
            ok(daily::today(&*lib()?, start)?)
        }
        _ => library_call(&*lib()?, method, params),
    }
}

/// Methods on the open library.
fn library_call(lib: &Library, method: &str, params: Value) -> Result<Value> {
    let get = |id| lib.index.get(id).ok_or_else(|| Error::not_found("That record can’t be found."));
    match method {
        "records.list" => {
            let l: ListParams = p(params)?;
            let mut v: Vec<RecordInfo> =
                lib.index.list(l.kind.as_deref())?.iter().map(|e| record::info(lib, e)).collect();
            v.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()).then(a.id.cmp(&b.id)));
            ok(v)
        }
        "records.get" => ok(record::info(lib, &get(p::<IdParams>(params)?.id)?)),
        "records.read" => ok(record::read_text(lib, p::<IdParams>(params)?.id)?),
        "records.text" => {
            let t: TextParams = p(params)?;
            ok(record::stored_text(lib, &get(t.id)?, t.part.as_deref()))
        }
        "records.create" => {
            let c: CreateParams = p(params)?;
            let mut fields = vec![];
            for (k, v) in c.fields.iter().filter(|(_, v)| !v.is_null()) {
                fields.push((k.clone(), field_value(k, v)?));
            }
            let w = lib.write();
            let e = record::create(&w, &c.kind, &c.title, fields, &c.body, c.subfolder.as_deref())?;
            ok(written(lib, &e, w.seq()))
        }
        "records.save" => {
            let s: SaveParams = p(params)?;
            let r = record::save_body(&lib.write(), s.id, &s.base_version, s.base_body.as_deref(), &s.body)?;
            // The draft is kept until its save succeeds (and more typing since keeps it).
            if !matches!(r, SaveResult::Conflict { .. }) {
                lib.drafts.settle(s.id, &s.body);
            }
            ok(r)
        }
        "records.setFields" => {
            let s: SetFieldsParams = p(params)?;
            let mut edits = vec![];
            for (k, v) in &s.fields {
                edits.push((k.clone(), if v.is_null() { None } else { Some(field_value(k, v)?) }));
            }
            let w = lib.write();
            let e = record::set_fields(&w, s.id, s.base_version.as_deref(), &edits)?;
            ok(written(lib, &e, w.seq()))
        }
        "records.relocate" => {
            let r: RelocateParams = p(params)?;
            let w = lib.write();
            let sub = r.subfolder.as_ref().map(|s| s.as_deref());
            let e = record::relocate(&w, r.id, r.base_version.as_deref(), r.title.as_deref(), sub)?;
            ok(written(lib, &e, w.seq()))
        }
        "records.move" => {
            let m: MoveRecordsParams = p(params)?;
            let spaces: std::collections::BTreeSet<_> = m
                .ids
                .iter()
                .filter_map(|id| lib.index.get(*id))
                .filter_map(|e| record::kind(&e.kind))
                .map(|k| k.folder)
                .collect();
            if spaces.len() > 1 {
                return Err(Error::invalid("Notes and library items can’t be moved together."));
            }
            let folder = m.folder.as_deref().map(|f| f.trim().trim_matches('/')).filter(|f| !f.is_empty());
            let w = lib.write();
            let mut out = MovedRecords { moved: vec![], failed: vec![] };
            for id in m.ids {
                match folders::move_to_folder(&w, id, folder) {
                    Ok(e) => out.moved.push(written(lib, &e, w.seq())),
                    Err(e) => out.failed.push(MoveFailure { id, error: e.message }),
                }
            }
            ok(out)
        }
        "folders.list" => ok(folders::list(lib)?),
        "folders.create" => {
            let f: FolderPathParams = p(params)?;
            ok(FolderMoved { path: folders::create(&lib.write(), &f.kind, &f.path)?, moved: 0 })
        }
        "folders.move" => {
            let f: FolderMoveParams = p(params)?;
            let moved = folders::move_folder(&lib.write(), &f.kind, &f.from, &f.to)?;
            ok(FolderMoved { path: folders::clean_folder(&f.to)?, moved: moved as u64 })
        }
        "folders.remove" => {
            let f: FolderPathParams = p(params)?;
            ok(folders::remove(&lib.write(), &f.kind, &f.path)?)
        }
        "folders.setOrder" => {
            let f: FolderOrderParams = p(params)?;
            ok(folders::set_order(&lib.write(), &f.kind, &f.path, f.order)?)
        }
        "drafts.put" => {
            let mut d: Draft = p(params)?;
            d.updated_ms = now_ms();
            ok(lib.drafts.put(&d)?)
        }
        "drafts.get" => ok(lib.drafts.get(p::<IdParams>(params)?.id)),
        "drafts.list" => {
            // Drafts whose text differs from their record's file; the others are done with.
            let mut out = vec![];
            for d in lib.drafts.all() {
                match record::read_text(lib, d.id) {
                    Ok(t) if t.body == d.body => lib.drafts.remove(d.id),
                    _ => out.push(d),
                }
            }
            ok(out)
        }
        "drafts.discard" => {
            lib.drafts.remove(p::<IdParams>(params)?.id);
            ok(())
        }
        "jobs.list" => ok(lib.jobs.list()),
        "jobs.retry" => ok(lib.jobs.retry(lib, p::<IdParams>(params)?.id)?),
        "jobs.cancel" => ok(lib.jobs.cancel(lib, p::<IdParams>(params)?.id)?),
        "jobs.dismiss" => ok(lib.jobs.dismiss(p::<IdParams>(params)?.id)?),
        "index.rebuild" => ok(lib.jobs.enqueue(lib, "index.rebuild", "all", Value::Null)),
        "index.status" => ok(IndexStatus {
            ready: true,
            applied: lib.seq(),
            progress: None,
            views: vec!["records".into(), "links".into(), "search".into()],
        }),
        "history.versions" => ok(history::versions(lib, p::<IdParams>(params)?.id)),
        "history.read" => {
            let h: HistoryParams = p(params)?;
            ok(history::text(lib, h.id, &h.hash)?)
        }
        "history.diff" => {
            let h: HistoryParams = p(params)?;
            ok(history::diff(lib, h.id, &h.hash)?)
        }
        "history.restore" => {
            let h: HistoryParams = p(params)?;
            let base = h.base_version.ok_or_else(|| Error::invalid("base_version is required"))?;
            ok(history::restore(lib, h.id, &h.hash, &base)?)
        }
        "history.deleted" => ok(history::deleted(lib)),
        "history.bringBack" => ok(history::bring_back(lib, p::<IdParams>(params)?.id)?),
        "search.query" => {
            let s: SearchParams = p(params)?;
            ok(lib.index.search(&s.text, &s.kinds, s.limit.unwrap_or(50).min(500))?)
        }
        "links.backlinks" => ok(lib.index.backlinks(p::<IdParams>(params)?.id)?),
        "links.unresolved" => ok(lib.index.unresolved(p::<UnresolvedParams>(params)?.id)?),
        "links.resolve" => ok(links::resolve(lib, p(params)?)?),
        "notes.create" => ok(notes::create(lib, p(params)?)?),
        "notes.folders" => ok(notes::folders(lib)?),
        "archive.archive" => {
            let a: ArchiveParams = p(params)?;
            ok(archive::archive(lib, a.id, a.base_version.as_deref())?)
        }
        "archive.restore" => {
            let a: ArchiveParams = p(params)?;
            ok(archive::restore(lib, a.id, a.base_version.as_deref())?)
        }
        "archive.list" => ok(archive::list(lib)?),
        "archive.prepareDelete" => ok(archive::prepare_delete(lib, &p::<IdsParams>(params)?.ids)?),
        "archive.delete" => ok(archive::delete(lib, &p::<TokenParams>(params)?.token)?),
        _ => Err(Error::not_found(format!("There is no method “{method}”."))),
    }
}

/// A field value the app can write: a string, number, boolean, or a list of these.
fn field_value(key: &str, v: &Value) -> Result<FmValue> {
    FmValue::from_json(v)
        .ok_or_else(|| Error::invalid(format!("field “{key}” must be a string, number, boolean or list of these")))
}
