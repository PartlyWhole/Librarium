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
                    subfolder_field: None,
                },
            )
            .unwrap();
            k
        }),
        app_support: PathBuf::from("/app"),
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
    let a2 = api_with(fs);
    a.close_library();
    a2.open_saved_library();
    assert_eq!(a2.library_status().state, LibraryState::Open);
    assert_eq!(a2.records_list(Default::default()).unwrap().len(), 1);
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
