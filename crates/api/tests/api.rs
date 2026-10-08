//! The API driven directly, on the test adapters.
use librarium_api::{Api, Deps, Handler};
use librarium_contracts::api::{LibraryState, SaveResult};
use librarium_contracts::ports::{ChangeSource, FileSystem, IndexEngine};
use librarium_contracts::rpc::{NotificationSink, RpcHandler, RpcNotification, RpcRequest, METHOD_NOT_FOUND};
use librarium_kernel::kinds::{Format, Kinds, RecordKindDef};
use librarium_kernel::library::OpenOptions;
use librarium_testkit::changes::ScriptedChanges;
use librarium_testkit::clock::FixedClock;
use librarium_testkit::ids::SequenceIds;
use librarium_testkit::memfs::MemFs;
use librarium_testkit::memindex::MemIndex;
use librarium_testkit::versions::RecordingVersions;
use librarium_testkit::worker::FakeWorkerHost;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn api_with(fs: Arc<MemFs>) -> Arc<Api> {
    api_with_desktop(fs, Arc::new(librarium_testkit::desktop::RecordingDesktop::default()))
}

fn api_with_desktop(fs: Arc<MemFs>, desktop: Arc<librarium_testkit::desktop::RecordingDesktop>) -> Arc<Api> {
    let index = MemIndex::new();
    let src = Arc::new(ScriptedChanges::new());
    Arc::new(Api::new(Deps {
        worker: Arc::new(FakeWorkerHost::new()),
        fs: fs as Arc<dyn FileSystem>,
        clock: Arc::new(FixedClock::new()),
        ids: Arc::new(SequenceIds::new()),
        versions: Arc::new(RecordingVersions::default()),
        index: Arc::new(move |_p: &Path| Arc::new(index.clone()) as Arc<dyn IndexEngine>),
        changes: Arc::new(move || src.clone() as Arc<dyn ChangeSource>),
        kinds: Arc::new(|| {
            let mut k = Kinds::new();
            k.add(
                "test",
                RecordKindDef {
                    kind: "page".into(),
                    version: 1,
                    format: Format::Markdown,
                    folder: "pages".into(),
                    slugged: true,
                    subfolder_field: Some("test.folder".into()),
                },
            )
            .unwrap();
            k
        }),
        app_support: PathBuf::from("/app"),
        logs_dir: PathBuf::from("/logs"),
        desktop,
        methods: librarium_kernel::methods::registry(),
        views: Arc::new(Vec::new),
        job_kinds: Arc::new(librarium_kernel::jobs::registry),
        open_options: OpenOptions { tick: Duration::from_secs(3600), ..Default::default() },
    }))
}

fn api() -> (Arc<Api>, Arc<MemFs>) {
    let fs = Arc::new(MemFs::new());
    fs.create_dir_all(Path::new("/lib")).unwrap();
    (api_with(fs.clone()), fs)
}

#[derive(Default)]
struct Sink(Mutex<Vec<RpcNotification>>);
impl NotificationSink for Sink {
    fn notify(&self, n: RpcNotification) {
        self.0.lock().unwrap().push(n);
    }
}

#[test]
fn pings_the_worker() {
    assert_eq!(api().0.worker_ping().unwrap().worker_version, "fake");
}

#[test]
fn speaks_json_rpc() {
    let (a, _) = api();
    let h = Handler(a);
    let r = h.handle(RpcRequest::new(7, "app.info", json!(null)));
    assert_eq!(r.id, 7);
    assert_eq!(r.result.unwrap()["name"], "Librarium");
    let e = h.handle(RpcRequest::new(8, "nope", json!(null))).error.unwrap();
    assert_eq!(e.code, METHOD_NOT_FOUND);
    assert_eq!(e.data.unwrap().code, librarium_contracts::ErrorCode::NotFound);
    let e = h.handle(RpcRequest::new(9, "records.get", json!({ "id": "not-a-uuid" }))).error.unwrap();
    assert_eq!(e.code, librarium_contracts::rpc::INVALID_PARAMS);
}

#[test]
fn first_run_then_open_create_save_and_events() {
    let (a, fs) = api();
    assert_eq!(a.library_status().state, LibraryState::None);
    let err = a.call("records.list", json!({})).unwrap_err();
    assert_eq!(err.code, librarium_contracts::ErrorCode::NotReady);

    let sink = Arc::new(Sink::default());
    a.set_sink(sink.clone());
    let st = a.call("folder.open", json!({ "path": "/lib" })).unwrap();
    assert_eq!(st["state"], "open");

    let w = a
        .call(
            "records.create",
            json!({ "kind": "page", "title": "Hello", "body": "first\n", "fields": { "x.tags": ["a", "b"] } }),
        )
        .unwrap();
    let id = w["info"]["id"].as_str().unwrap().to_string();
    let version = w["info"]["version"].as_str().unwrap().to_string();
    let r = a.call("records.save", json!({ "id": id, "base_version": version, "body": "second\n" })).unwrap();
    let r: SaveResult = serde_json::from_value(r).unwrap();
    assert!(matches!(r, SaveResult::Saved { .. }));
    let t = a.call("records.read", json!({ "id": id })).unwrap();
    assert_eq!(t["body"], "second\n");
    assert!(t["frontmatter"].as_str().unwrap().contains("x.tags: [\"a\", \"b\"]"));

    let w = a.call("records.relocate", json!({ "id": id, "title": "Hello again", "subfolder": "Sub" })).unwrap();
    assert!(w["info"]["path"].as_str().unwrap().starts_with("pages/Sub/"));
    let w = a.call("records.setFields", json!({ "id": id, "fields": { "x.tags": null, "x.n": 3 } })).unwrap();
    assert_eq!(w["info"]["fields"]["x.n"], 3);
    assert!(w["info"]["fields"].get("x.tags").is_none());

    let events: Vec<String> = sink.0.lock().unwrap().iter().map(|n| n.method.clone()).collect();
    assert!(events.contains(&"event.status".to_string()));
    assert_eq!(events.iter().filter(|m| *m == "event.change").count(), 4, "{events:?}");
    let change = sink.0.lock().unwrap().iter().find(|n| n.method == "event.change").unwrap().params.clone();
    assert!(
        change.get("seq").is_some() && change.get("id").is_some() && change.get("body").is_none(),
        "events carry IDs, never bodies"
    );

    // The choice is remembered.
    let a2 = api_with(fs.clone());
    let fs2 = fs;
    a.close_library();
    a2.open_saved_library();
    assert_eq!(a2.library_status().state, LibraryState::Open);
    assert_eq!(a2.records_list(Default::default()).unwrap().len(), 1);

    // At start-up it opens on another thread, and says "opening" from the start, never
    // "missing" (R-072: the interface then asked for the folder again).
    a2.close_library();
    let a3 = api_with(fs2);
    a3.open_saved_library_soon();
    assert_ne!(a3.library_status().state, LibraryState::Missing);
    assert_ne!(a3.library_status().state, LibraryState::None);
    let t = std::time::Instant::now();
    while a3.library_status().state != LibraryState::Open && t.elapsed() < std::time::Duration::from_secs(10) {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(a3.library_status().state, LibraryState::Open);
}

#[test]
fn a_missing_folder_is_reported_calmly() {
    let (a, _) = api();
    assert!(a.open_library(Path::new("/nowhere")).is_err());
    let st = a.library_status();
    assert_eq!(st.state, LibraryState::Missing);
    assert!(st.error.unwrap().contains("can't be found"));
}

#[test]
fn icloud_is_recognised() {
    assert!(librarium_api::in_icloud(Path::new("/Users/me/Library/Mobile Documents/com~apple~CloudDocs/Notes")));
    assert!(!librarium_api::in_icloud(Path::new("/Users/me/Documents/Notes")));
}

#[test]
fn inspects_folders_for_first_run() {
    let (a, fs) = api();
    let info = a.folder_inspect(Path::new("/lib"));
    assert!(info.exists && info.empty && !info.is_library);
    fs.write_outside(Path::new("/lib/Notes/a.md"), b"# a");
    fs.write_outside(Path::new("/lib/b.md"), b"# b");
    fs.write_outside(Path::new("/lib/.hidden"), b"");
    let info = a.folder_inspect(Path::new("/lib"));
    assert!(!info.empty);
    assert_eq!(info.markdown_files, 2);
    a.open_library(Path::new("/lib")).unwrap();
    assert!(a.folder_inspect(Path::new("/lib")).is_library);
    assert!(!a.folder_inspect(Path::new("/nope")).exists);
}

#[test]
fn a_save_to_a_read_only_file_fails_and_its_draft_survives() {
    let (a, fs) = api();
    a.open_library(Path::new("/lib")).unwrap();
    let w = a.call("records.create", json!({ "kind": "page", "title": "Locked", "body": "v1\n" })).unwrap();
    let id = w["info"]["id"].as_str().unwrap().to_string();
    let path = Path::new("/lib").join(w["info"]["path"].as_str().unwrap());
    let version = w["info"]["version"].as_str().unwrap().to_string();
    a.call("drafts.put", json!({ "id": id, "base_version": version, "base_body": "v1\n", "body": "v2 typed\n" }))
        .unwrap();
    fs.set_read_only(&path, true);
    let err = a.call("records.save", json!({ "id": id, "base_version": version, "body": "v2 typed\n" })).unwrap_err();
    assert!(err.data.unwrap()["read_only_file"].as_bool().unwrap());
    assert!(err.message.contains("read-only"));
    let drafts = a.call("drafts.list", json!({})).unwrap();
    assert_eq!(drafts[0]["body"], "v2 typed\n", "the draft survives the failed save");
    // Writable again: the retry succeeds and settles the draft.
    fs.set_read_only(&path, false);
    a.call("records.save", json!({ "id": id, "base_version": version, "body": "v2 typed\n" })).unwrap();
    assert_eq!(a.call("drafts.list", json!({})).unwrap(), json!([]));
}

#[test]
fn undoing_a_rename_refuses_if_the_note_changed() {
    let (a, _) = api();
    a.open_library(Path::new("/lib")).unwrap();
    let w = a.call("records.create", json!({ "kind": "page", "title": "Before", "body": "x\n" })).unwrap();
    let id = w["info"]["id"].as_str().unwrap().to_string();
    let renamed = a.call("records.relocate", json!({ "id": id, "title": "After" })).unwrap();
    let v = renamed["info"]["version"].as_str().unwrap().to_string();
    a.call("records.save", json!({ "id": id, "base_version": v, "body": "edited\n" })).unwrap();
    let err = a.call("records.relocate", json!({ "id": id, "title": "Before", "base_version": v })).unwrap_err();
    assert_eq!(err.code, librarium_contracts::ErrorCode::Conflict);
}

#[test]
fn renaming_a_note_keeps_every_link_working() {
    let (a, _) = api();
    a.open_library(Path::new("/lib")).unwrap();
    let b =
        a.call("records.create", json!({ "kind": "page", "title": "Simone Weil", "subfolder": "Thinkers" })).unwrap();
    let bid = b["info"]["id"].as_str().unwrap().to_string();
    let link = librarium_kernel::links::format_link("Simone Weil", bid.parse().unwrap(), false);
    let a1 = a
        .call("records.create", json!({ "kind": "page", "title": "Reading", "body": format!("See {link}.\n") }))
        .unwrap();
    let aid = a1["info"]["id"].as_str().unwrap().to_string();
    a.call("records.relocate", json!({ "id": bid, "title": "Weil, Simone", "subfolder": "Elsewhere" })).unwrap();
    let body = a.call("records.read", json!({ "id": aid })).unwrap()["body"].as_str().unwrap().to_string();
    let links = librarium_kernel::links::parse_links(&body);
    let target = a.call("records.get", json!({ "id": links[0].id.unwrap().to_string() })).unwrap();
    assert_eq!(target["title"], "Weil, Simone", "the link resolves by ID after the rename and move");
}

#[test]
fn folders_are_listed_made_moved_and_removed() {
    let (a, _fs) = api();
    a.call("folder.open", json!({ "path": "/lib" })).unwrap();
    let w = a.call("records.create", json!({ "kind": "page", "title": "One", "body": "" })).unwrap();
    let id = w["info"]["id"].as_str().unwrap().to_string();
    a.call("folders.create", json!({ "kind": "page", "path": "Reading" })).unwrap();
    let l = a.call("folders.list", json!({})).unwrap();
    assert_eq!(l, json!({ "spaces": [{ "kind": "page", "kinds": ["page"], "folders": ["Reading"], "order": {} }] }));
    // An arrangement is kept, and follows the folder when it moves.
    a.call("folders.setOrder", json!({ "kind": "page", "path": "", "order": ["folder:Reading", id] })).unwrap();
    a.call("folders.setOrder", json!({ "kind": "page", "path": "Reading", "order": [id] })).unwrap();
    let m = a.call("records.move", json!({ "ids": [id], "folder": "Reading" })).unwrap();
    assert!(m["moved"][0]["info"]["path"].as_str().unwrap().starts_with("pages/Reading/"), "{m}");
    assert_eq!(m["failed"], json!([]));
    let r = a.call("folders.move", json!({ "kind": "page", "from": "Reading", "to": "Done/Reading" })).unwrap();
    assert_eq!(r, json!({ "path": "Done/Reading", "moved": 1 }));
    let order = &a.call("folders.list", json!({})).unwrap()["spaces"][0]["order"];
    assert_eq!(order[""], json!([id]), "moved away: no longer placed at the top level");
    assert_eq!(order["Done/Reading"], json!([id]), "{order}");
    let e = a.call("folders.remove", json!({ "kind": "page", "path": "Done" })).unwrap_err();
    assert!(e.message.contains("isn’t empty"), "{}", e.message);
    a.call("records.move", json!({ "ids": [id], "folder": null })).unwrap();
    a.call("folders.remove", json!({ "kind": "page", "path": "Done" })).unwrap();
    assert_eq!(a.call("folders.list", json!({})).unwrap()["spaces"][0]["folders"], json!([]));
}

#[test]
fn only_web_and_mail_addresses_are_opened_in_the_browser() {
    let fs = Arc::new(MemFs::new());
    let desktop = Arc::new(librarium_testkit::desktop::RecordingDesktop::default());
    let a = api_with_desktop(fs, desktop.clone());
    a.call("app.openUrl", json!({ "url": "https://example.org/a?b=c" })).unwrap();
    a.call("app.openUrl", json!({ "url": "mailto:someone@example.org" })).unwrap();
    for bad in
        ["file:///etc/passwd", "javascript:alert(1)", "-a Calculator", "https://x.org/a b", "tauri://localhost", ""]
    {
        assert!(a.call("app.openUrl", json!({ "url": bad })).is_err(), "{bad:?} refused");
    }
    assert_eq!(*desktop.opened.lock().unwrap(), ["https://example.org/a?b=c", "mailto:someone@example.org"]);
}

#[test]
fn a_note_keeps_versions_that_compare_and_restore() {
    let (a, _fs) = api();
    a.call("folder.open", json!({ "path": "/lib" })).unwrap();
    let w = a
        .call("records.create", json!({ "kind": "page", "title": "Draft", "body": "first line\nsecond line\n" }))
        .unwrap();
    let id = w["info"]["id"].as_str().unwrap().to_string();
    let first = a.call("history.versions", json!({ "id": id })).unwrap();
    assert_eq!(first.as_array().unwrap().len(), 1);
    assert_eq!(first[0]["current"], true);
    let hash = first[0]["hash"].as_str().unwrap().to_string();
    let v = w["info"]["version"].as_str().unwrap().to_string();
    a.call("records.save", json!({ "id": id, "base_version": v, "body": "first line\nchanged\n" })).unwrap();
    // The comparison: the old line removed, the new one added, bodies only.
    let diff = a.call("history.diff", json!({ "id": id, "hash": hash })).unwrap();
    let ops: Vec<(String, String)> = diff
        .as_array()
        .unwrap()
        .iter()
        .map(|l| (l["op"].as_str().unwrap().into(), l["text"].as_str().unwrap().into()))
        .collect();
    assert_eq!(
        ops,
        [
            ("equal".into(), "first line".into()),
            ("delete".into(), "second line".into()),
            ("insert".into(), "changed".into())
        ]
    );
    // Restoring needs the version shown, keeps the text before, and brings the text back.
    let now = a.call("records.get", json!({ "id": id })).unwrap()["version"].as_str().unwrap().to_string();
    let e = a.call("history.restore", json!({ "id": id, "hash": hash, "base_version": "stale" })).unwrap_err();
    assert_eq!(e.code, librarium_contracts::ErrorCode::Conflict);
    a.call("history.restore", json!({ "id": id, "hash": hash, "base_version": now })).unwrap();
    assert!(a.call("records.read", json!({ "id": id })).unwrap()["body"].as_str().unwrap().ends_with("second line\n"));
    let vs = a.call("history.versions", json!({ "id": id })).unwrap();
    let origins: Vec<&str> = vs.as_array().unwrap().iter().map(|v| v["origin"].as_str().unwrap()).collect();
    assert_eq!(origins, ["restore", "before-restore", "app"]);
    // Another record's version can't be read through this one.
    let other = a.call("records.create", json!({ "kind": "page", "title": "Other", "body": "x\n" })).unwrap();
    let oid = other["info"]["id"].as_str().unwrap();
    assert!(a.call("history.read", json!({ "id": oid, "hash": hash })).is_err());
}

#[test]
fn exports_write_text_or_bytes_outside_the_library() {
    let (a, fs) = api();
    a.call("folder.open", json!({ "path": "/lib" })).unwrap();
    fs.create_dir_all(std::path::Path::new("/out")).unwrap();
    a.call("export.write", json!({ "path": "/out/board.svg", "text": "<svg/>" })).unwrap();
    assert_eq!(fs.read(std::path::Path::new("/out/board.svg")).unwrap(), b"<svg/>");
    // A picture: bytes, given in base64 ("\x89PNG" here).
    a.call("export.write", json!({ "path": "/out/board.png", "data": "iVBORw==" })).unwrap();
    assert_eq!(fs.read(std::path::Path::new("/out/board.png")).unwrap(), b"\x89PNG");
    assert!(a.call("export.write", json!({ "path": "/out/bad.png", "data": "not base64!" })).is_err());
    assert!(
        a.call("export.write", json!({ "path": "/lib/notes/x.png", "data": "iVBORw==" })).is_err(),
        "never into the library"
    );
}
