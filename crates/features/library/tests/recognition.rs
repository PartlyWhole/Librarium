//! Recognition runs once, is stored, and an index rebuild reads the stored result.
use librarium_contracts::ports::{ChangeSource, FileSystem, IndexEngine};
use librarium_kernel::hosts::{HostEvents, Hosts};
use librarium_kernel::kinds::Kinds;
use librarium_kernel::library::{IndexFactory, Library, LibraryPorts, OpenOptions};
use librarium_kernel::methods::MethodCtx;
use librarium_testkit::changes::ScriptedChanges;
use librarium_testkit::clock::FixedClock;
use librarium_testkit::ids::SequenceIds;
use librarium_testkit::memfs::MemFs;
use librarium_testkit::memindex::MemIndex;
use librarium_testkit::recognizer::StoredRecognitions;
use librarium_testkit::versions::RecordingVersions;
use librarium_testkit::worker::FakeWorkerHost;
use serde_json::json;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

#[test]
fn recognition_is_stored_and_never_rerun_by_a_rebuild() {
    let fs = Arc::new(MemFs::new());
    fs.create_dir_all(Path::new("/lib")).unwrap();
    let png = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../tests/fixtures/library/words.png")).unwrap();
    fs.write_outside(Path::new("/outside/words.png"), &png);
    let mut k = Kinds::new();
    librarium_feature_library::contribute_kinds(&mut k).unwrap();
    let index = MemIndex::new();
    let factory: IndexFactory = Arc::new(move |_p: &Path| Arc::new(index.clone()) as Arc<dyn IndexEngine>);
    let lib = Arc::new(
        Library::open(
            Path::new("/lib"),
            Path::new("/app"),
            LibraryPorts {
                fs: fs.clone() as Arc<dyn FileSystem>,
                clock: Arc::new(FixedClock::new()),
                ids: Arc::new(SequenceIds::new()),
                versions: Arc::new(RecordingVersions::default()),
                index: factory.clone(),
                changes: Arc::new(ScriptedChanges::new()) as Arc<dyn ChangeSource>,
            },
            k,
            OpenOptions { tick: Duration::from_secs(3600), ..Default::default() },
        )
        .unwrap(),
    );
    let rec = Arc::new(
        StoredRecognitions::default()
            .with("words.png", &["Gravity and grace are two forces.\nAttention is the rarest form of generosity."]),
    );
    let worker = Arc::new(FakeWorkerHost::new().with("image.info", |_| Ok(json!({ "width": 1400, "height": 520 }))));
    let mut jobs = librarium_kernel::jobs::registry();
    librarium_feature_library::contribute_jobs(&mut jobs, rec.clone()).unwrap();
    // A minimal text view (this test may not depend on the Search feature).
    struct Text;
    impl librarium_kernel::views::DerivedView for Text {
        fn spec(&self) -> librarium_contracts::ports::ViewSpec {
            librarium_contracts::ports::ViewSpec {
                name: "search".into(),
                schema_version: 1,
                tables: vec![],
                text: true,
            }
        }
        fn apply(
            &self,
            idx: &mut dyn librarium_contracts::ports::ViewIndex,
            rec: &librarium_kernel::views::ViewRecord,
        ) -> librarium_contracts::Result<()> {
            let id = rec.entry.id.to_string();
            idx.put_passages(
                &id,
                &[librarium_contracts::ports::Passage {
                    record: id.clone(),
                    kind: rec.entry.kind.clone(),
                    ordinal: 0,
                    title: rec.entry.title.clone(),
                    body: rec.text.to_string(),
                    offset: 0,
                }],
            )
        }
        fn remove(
            &self,
            idx: &mut dyn librarium_contracts::ports::ViewIndex,
            id: librarium_contracts::Id,
        ) -> librarium_contracts::Result<()> {
            idx.delete_passages(&id.to_string())
        }
    }
    let views: Vec<Arc<dyn librarium_kernel::views::DerivedView>> = vec![Arc::new(Text)];
    let hosts = Hosts::start(
        lib.clone(),
        &factory,
        worker,
        views,
        jobs,
        HostEvents { indexed: Box::new(|_| {}), job: Box::new(|_| {}) },
    )
    .unwrap();
    let get = |_: &str| None;
    let ctx = MethodCtx { library: &lib, setting: &get, views: Some(&hosts.views), jobs: Some(&hosts.jobs) };
    librarium_feature_library::import(&ctx, Path::new("/outside/words.png")).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !hosts.jobs.list().running.is_empty() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(rec.calls(), 1);
    let seq = lib.store.changes.last_seq();
    assert!(hosts.views.wait_applied(seq, Duration::from_secs(5)));
    let find = || {
        hosts
            .views
            .query("search", |i| {
                i.search(&librarium_contracts::ports::TextQuery { text: "generosity".into(), kinds: vec![], limit: 5 })
            })
            .unwrap()
    };
    assert_eq!(find().len(), 1, "the recognised words are found");
    hosts.views.rebuild_all(&|_, _| {}).unwrap();
    assert_eq!(find().len(), 1, "still found after a rebuild");
    assert_eq!(rec.calls(), 1, "recognition did not run again");
    hosts.stop();
}
