//! The one IPC command, `call(method, params)`, and its dispatcher: each arm reads its
//! parameters, calls a module and returns the result as JSON.

use crate::app::{self, App};
use crate::error::{Error, Result};
use crate::store::{folders, record, relocate, save, Library};
use crate::types::*;
use crate::util::now_ms;
use crate::{archive, boards, captures, daily, history, library, links, notes, websave};
use base64::Engine as _;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;

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
        "records.save" => {
            let s: SaveParams = p(params)?;
            let r = save::save_body(&lib.write(), s.id, &s.base_version, s.base_body.as_deref(), &s.body)?;
            // The draft is kept until its save succeeds (and more typing since keeps it).
            if !matches!(r, SaveResult::Conflict { .. }) {
                lib.drafts.settle(s.id, &s.body);
            }
            ok(r)
        }
        "records.relocate" => {
            let r: RelocateParams = p(params)?;
            let w = lib.write();
            let sub = r.subfolder.as_ref().map(|s| s.as_deref());
            let e = relocate::relocate(&w, r.id, r.base_version.as_deref(), r.title.as_deref(), sub)?;
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
        "archive.archive" => {
            let a: ArchiveParams = p(params)?;
            ok(archive::archive(lib, a.id, a.base_version.as_deref())?)
        }
        "archive.restore" => {
            let a: ArchiveParams = p(params)?;
            ok(archive::restore(lib, a.id, a.base_version.as_deref())?)
        }
        "archive.prepareDelete" => ok(archive::prepare_delete(lib, &p::<IdsParams>(params)?.ids)?),
        "archive.delete" => ok(archive::delete(lib, &p::<TokenParams>(params)?.token)?),
        "library.import" => {
            let i: ImportParams = p(params)?;
            ok(library::import::import_paths(lib, &i.paths, i.folder.as_deref())?)
        }
        "library.importData" => {
            let i: ImportDataParams = p(params)?;
            ok(library::import::import_data(lib, i.name.as_deref(), &i.data, i.folder.as_deref())?)
        }
        "library.text" => ok(library::stored_json(lib, &library::item(lib, p::<IdParams>(params)?.id)?)),
        "library.savePage" => ok(websave::enqueue(lib, p(params)?)?),
        "library.removeSnapshots.prepare" => {
            ok(library::snapshots::prepare(lib, &p::<RemoveSnapshotsParams>(params)?.items)?)
        }
        "library.removeSnapshots" => ok(library::snapshots::remove(lib, &p::<TokenParams>(params)?.token)?),
        "captures.create" => ok(captures::create(lib, p(params)?)?),
        "captures.update" => ok(captures::update(lib, p(params)?)?),
        "captures.anchor" => ok(captures::anchor(lib, p::<IdParams>(params)?.id)?),
        "captures.updateAnchor" => {
            let a: AnchorUpdateParams = p(params)?;
            ok(captures::update_anchor(lib, a.id, a.parts)?)
        }
        "captures.forSource" => {
            let f: ForSourceParams = p(params)?;
            ok(captures::for_source(lib, f.source, f.snapshot.as_deref()))
        }
        "captures.orphans" => ok(captures::orphans(lib)),
        "captures.region" => {
            let r: RegionParams = p(params)?;
            ok(captures::region(lib, r.id, r.n)?)
        }
        "boards.create" => {
            let b: BoardCreateParams = p(params)?;
            ok(boards::create(lib, b.title.as_deref(), b.folder.as_deref())?)
        }
        "boards.load" => ok(boards::load(lib, p::<IdParams>(params)?.id)?),
        "boards.save" => ok(boards::save(lib, p(params)?)?),
        _ => Err(Error::not_found(format!("There is no method “{method}”."))),
    }
}
