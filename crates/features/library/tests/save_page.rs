//! Saving web pages on the test adapters: a new item, then a snapshot; checks; provenance.
use librarium_contracts::api::JobState;
use librarium_contracts::ports::{ChangeSource, FileSystem, IndexEngine};
use librarium_kernel::hosts::{HostEvents, Hosts};
use librarium_kernel::kinds::Kinds;
use librarium_kernel::library::{IndexFactory, Library, LibraryPorts, OpenOptions};
use librarium_testkit::changes::ScriptedChanges;
use librarium_testkit::clock::FixedClock;
use librarium_testkit::ids::SequenceIds;
use librarium_testkit::memfs::MemFs;
use librarium_testkit::memindex::MemIndex;
use librarium_testkit::pages::FixturePages;
use librarium_testkit::versions::RecordingVersions;
use librarium_testkit::worker::FakeWorkerHost;
use serde_json::json;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

fn fixture(f: &str) -> String {
    std::fs::read_to_string(format!("{}/../../../tests/fixtures/pages/{f}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

#[test]
fn saving_again_adds_a_snapshot_with_its_checks() {
    let fs = Arc::new(MemFs::new());
    fs.create_dir_all(Path::new("/lib")).unwrap();
    let clock = Arc::new(FixedClock::new());
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
                clock: clock.clone(),
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
    let url = "https://quarterly.example/on-technique";
    let pages = Arc::new(FixturePages::default().with(url, 200, &fixture("article.html")));
    let mut jobs = librarium_kernel::jobs::registry();
    librarium_feature_library::contribute_page_jobs(&mut jobs, pages.clone()).unwrap();
    let hosts = Hosts::start(
        lib.clone(),
        &factory,
        Arc::new(FakeWorkerHost::new()),
        vec![],
        jobs,
        HostEvents { indexed: Box::new(|_| {}), job: Box::new(|_| {}) },
    )
    .unwrap();

    let save = || {
        let j = hosts.jobs.enqueue("library.savePage", url, json!({ "url": url })).unwrap();
        let j = hosts.jobs.wait(j.id, Duration::from_secs(10)).unwrap();
        assert_eq!(j.state, JobState::Done, "{j:?}");
    };
    save();
    let items = lib.store.list(Some("item"));
    assert_eq!(items.len(), 1);
    let item = &items[0];
    assert_eq!(item.title, "On Technique — The Quarterly");
    assert_eq!(item.fields["library.format"], "web");
    let prov = &item.fields["provenance"];
    assert_eq!(prov["source"], url);
    assert_eq!(prov["author"], "A. Writer");
    assert_eq!(prov["publication"], "The Quarterly");
    assert_eq!(prov["published"], "2026-09-30T08:00:00Z");
    assert!(prov["saved-with"].as_str().unwrap().contains("WebKit"));
    let at1 = item.field_str("library.snapshot").unwrap().to_string();
    let dir = lib.store.record_dir(item);
    assert!(fs.read(&dir.join("snapshots").join(&at1).join("page.pdf")).unwrap().starts_with(b"%PDF"));
    let t1 = lib.store.stored_text(item).unwrap();
    assert!(t1.text.contains("Technique integrates everything."));
    assert_eq!(t1.origin.unwrap()["snapshot"], at1);
    assert_eq!(item.fields["library.snapshots"][0]["checks"], json!([]));

    // The page changes (now behind a paywall); saving again adds a snapshot to the same item.
    clock.advance_ms(60_000);
    let p2 = fixture("paywall-text.html");
    let pages_again = Arc::new(FixturePages::default().with(url, 200, &p2));
    let mut jobs2 = librarium_kernel::jobs::registry();
    librarium_feature_library::contribute_page_jobs(&mut jobs2, pages_again).unwrap();
    hosts.stop();
    let hosts = Hosts::start(
        lib.clone(),
        &factory,
        Arc::new(FakeWorkerHost::new()),
        vec![],
        jobs2,
        HostEvents { indexed: Box::new(|_| {}), job: Box::new(|_| {}) },
    )
    .unwrap();
    let j = hosts.jobs.enqueue("library.savePage", url, json!({ "url": url })).unwrap();
    assert_eq!(hosts.jobs.wait(j.id, Duration::from_secs(10)).unwrap().state, JobState::Done);
    let items = lib.store.list(Some("item"));
    assert_eq!(items.len(), 1, "one item, two snapshots");
    let item = &items[0];
    let snaps = item.fields["library.snapshots"].as_array().unwrap();
    assert_eq!(snaps.len(), 2);
    assert_eq!(snaps[1]["checks"][0]["kind"], "paywall");
    let at2 = item.field_str("library.snapshot").unwrap();
    assert_ne!(at2, at1);
    // Each snapshot's text stays readable; captures keep to the one they came from.
    assert!(lib.store.stored_text_of(item, Some(&at1)).unwrap().text.contains("Technique integrates everything."));
    assert!(lib.store.stored_text(item).unwrap().text.contains("City Life"));
    hosts.stop();
}

/// A saver whose pages all end at about:blank, as when a load was lost.
struct BlankPages(FixturePages);

impl librarium_contracts::ports::PageSaver for BlankPages {
    fn save(&self, url: &str, timeout: Duration) -> librarium_contracts::Result<librarium_contracts::ports::SavedPage> {
        let mut p = self.0.save(url, timeout)?;
        p.final_url = "about:blank".into();
        Ok(p)
    }
}

#[test]
fn a_page_that_never_loaded_is_not_kept_and_matches_nothing() {
    let fs = Arc::new(MemFs::new());
    fs.create_dir_all(Path::new("/lib")).unwrap();
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
    let (a, b) = ("https://one.example/a", "https://two.example/b");
    let pages = FixturePages::default().with(a, 200, &fixture("article.html")).with(b, 200, &fixture("article.html"));
    let mut jobs = librarium_kernel::jobs::registry();
    librarium_feature_library::contribute_page_jobs(&mut jobs, Arc::new(BlankPages(pages))).unwrap();
    let hosts = Hosts::start(
        lib.clone(),
        &factory,
        Arc::new(FakeWorkerHost::new()),
        vec![],
        jobs,
        HostEvents { indexed: Box::new(|_| {}), job: Box::new(|_| {}) },
    )
    .unwrap();
    for url in [a, b] {
        let j = hosts.jobs.enqueue("library.savePage", url, json!({ "url": url })).unwrap();
        let j = hosts.jobs.wait(j.id, Duration::from_secs(10)).unwrap();
        assert_eq!(j.state, JobState::Failed, "{j:?}");
        assert!(j.error.as_deref().unwrap_or("").contains("didn’t load"), "{j:?}");
    }
    assert!(lib.store.list(Some("item")).is_empty(), "nothing is kept, so nothing can collect other pages");
    assert!(librarium_feature_library::item_for_url(&lib.store, "about:blank").is_none());
    hosts.stop();
}

#[test]
fn saving_a_page_whose_item_is_archived_makes_a_new_item() {
    let fs = Arc::new(MemFs::new());
    fs.create_dir_all(Path::new("/lib")).unwrap();
    let mut k = Kinds::new();
    librarium_feature_library::contribute_kinds(&mut k).unwrap();
    let index = MemIndex::new();
    let factory: IndexFactory = Arc::new(move |_p: &Path| Arc::new(index.clone()) as Arc<dyn IndexEngine>);
    let clock = Arc::new(FixedClock::new());
    let lib = Arc::new(
        Library::open(
            Path::new("/lib"),
            Path::new("/app"),
            LibraryPorts {
                fs: fs.clone() as Arc<dyn FileSystem>,
                clock: clock.clone(),
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
    let url = "https://quarterly.example/on-technique";
    let mut jobs = librarium_kernel::jobs::registry();
    let pages = FixturePages::default().with(url, 200, &fixture("article.html"));
    librarium_feature_library::contribute_page_jobs(&mut jobs, Arc::new(pages)).unwrap();
    let hosts = Hosts::start(
        lib.clone(),
        &factory,
        Arc::new(FakeWorkerHost::new()),
        vec![],
        jobs,
        HostEvents { indexed: Box::new(|_| {}), job: Box::new(|_| {}) },
    )
    .unwrap();
    let save = || {
        let j = hosts.jobs.enqueue("library.savePage", url, json!({ "url": url, "hide": ["archive.at"] })).unwrap();
        assert_eq!(hosts.jobs.wait(j.id, Duration::from_secs(10)).unwrap().state, JobState::Done);
    };
    save();
    let first = lib.store.list(Some("item"))[0].id;
    // The item is archived (a field the interface hides records by).
    lib.write(librarium_kernel::writer::Lane::Interactive, move |tx| {
        tx.set_fields(
            first,
            None,
            &[("archive.at".into(), Some(librarium_kernel::frontmatter::FmValue::Str("2026-10-03T18:00:00Z".into())))],
        )
    })
    .unwrap();
    clock.advance_ms(60_000);
    save();
    let items = lib.store.list(Some("item"));
    assert_eq!(items.len(), 2, "a new item, not a snapshot hidden in the archived one");
    let archived = items.iter().find(|e| e.id == first).unwrap();
    assert_eq!(archived.fields["library.snapshots"].as_array().unwrap().len(), 1, "the archived item is untouched");
    hosts.stop();
}

#[test]
fn a_page_saved_into_a_folder_lands_there_and_a_new_snapshot_stays_where_the_item_is() {
    let fs = Arc::new(MemFs::new());
    fs.create_dir_all(Path::new("/lib")).unwrap();
    let mut k = Kinds::new();
    librarium_feature_library::contribute_kinds(&mut k).unwrap();
    let index = MemIndex::new();
    let factory: IndexFactory = Arc::new(move |_p: &Path| Arc::new(index.clone()) as Arc<dyn IndexEngine>);
    let clock = Arc::new(FixedClock::new());
    let lib = Arc::new(
        Library::open(
            Path::new("/lib"),
            Path::new("/app"),
            LibraryPorts {
                fs: fs.clone() as Arc<dyn FileSystem>,
                clock: clock.clone(),
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
    let url = "https://quarterly.example/on-technique";
    let mut jobs = librarium_kernel::jobs::registry();
    let pages = FixturePages::default().with(url, 200, &fixture("article.html"));
    librarium_feature_library::contribute_page_jobs(&mut jobs, Arc::new(pages)).unwrap();
    let hosts = Hosts::start(
        lib.clone(),
        &factory,
        Arc::new(FakeWorkerHost::new()),
        vec![],
        jobs,
        HostEvents { indexed: Box::new(|_| {}), job: Box::new(|_| {}) },
    )
    .unwrap();
    let save = |folder: &str| {
        let j = hosts.jobs.enqueue("library.savePage", url, json!({ "url": url, "folder": folder })).unwrap();
        assert_eq!(hosts.jobs.wait(j.id, Duration::from_secs(10)).unwrap().state, JobState::Done);
    };
    save("Reading/Technique");
    let item = lib.store.list(Some("item"))[0].clone();
    assert!(item.path.starts_with("items/Reading/Technique/"), "{}", item.path);
    assert_eq!(item.fields["library.folder"], "Reading/Technique");
    let snap = item.fields["library.snapshot"].as_str().unwrap().to_string();
    assert!(fs
        .read(&Path::new("/lib").join(item.path.replace("record.json", &format!("snapshots/{snap}/page.pdf"))))
        .is_ok());
    // Saved again from another folder: it is the same page, so the item stays where it is.
    clock.advance_ms(60_000);
    save("Elsewhere");
    let items = lib.store.list(Some("item"));
    assert_eq!(items.len(), 1);
    assert!(items[0].path.starts_with("items/Reading/Technique/"), "it stays in its folder");
    assert!(lib.store.folders("item").iter().all(|f| !f.starts_with("Elsewhere")), "{:?}", lib.store.folders("item"));
}
