//! Removing snapshots of saved pages, with the real adapters: two steps, at least one kept, and
//! never a snapshot a capture was made from.
use librarium_app::compose::App;
use librarium_testkit::pages::FixturePages;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

fn fixture(f: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/pages").join(f)).unwrap()
}

#[test]
fn snapshots_are_removed_only_after_confirmation_and_never_from_under_a_capture() {
    let dir: PathBuf = std::env::temp_dir().join(format!("librarium-snapshots-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("lib")).unwrap();
    let url = "https://quarterly.example/on-technique";
    let pages = Arc::new(FixturePages::default().with(url, 200, &fixture("article.html")));
    let a = App::compose_with(
        librarium_testkit::binaries::worker_binary(),
        dir.join("support"),
        dir.join("logs"),
        pages.clone(),
    );
    a.api.open_library(&dir.join("lib")).unwrap();
    let call = |m: &str, p: Value| a.api.call(m, p);
    let jobs = &a.api.hosts().unwrap().jobs;
    let save = || {
        let j = call("library.savePage", json!({ "url": url })).unwrap();
        let id = j["id"].as_str().unwrap().parse().unwrap();
        let done = jobs.wait(id, Duration::from_secs(20)).unwrap();
        assert_eq!(done.state, librarium_contracts::api::JobState::Done, "{done:?}");
        std::thread::sleep(Duration::from_millis(1100)); // snapshots are named by the second
    };
    // Three snapshots of one page, each different.
    save();
    pages.put(url, 200, &fixture("article.html").replace("Technique integrates", "Technique still integrates"));
    save();
    pages.put(url, 200, &fixture("paywall-text.html"));
    save();
    let items = a.api.records_list(librarium_contracts::api::ListParams { kind: Some("item".into()) }).unwrap();
    assert_eq!(items.len(), 1);
    let item = items[0].id.to_string();
    let snaps = |id: &str| -> Vec<String> {
        call("records.get", json!({ "id": id })).unwrap()["fields"]["library.snapshots"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["at"].as_str().unwrap().to_string())
            .collect()
    };
    let all = snaps(&item);
    assert_eq!(all.len(), 3);
    let folder = |at: &str| {
        let lib = a.api.library().unwrap();
        let e = lib.store.get(item.parse().unwrap()).unwrap();
        lib.store.record_dir(&e).join("snapshots").join(at)
    };

    // A capture made from the first snapshot.
    call("captures.create", json!({ "source": item, "snapshot": all[0], "parts": [{ "quote": "Technique integrates everything.", "selector": [{ "type": "TextQuoteSelector", "exact": "Technique integrates everything." }] }] })).unwrap();

    // Step one: the older ones, except the one the capture uses.
    let p = call("library.removeSnapshots.prepare", json!({ "items": [{ "id": item }] })).unwrap();
    assert_eq!(p["items"][0]["remove"], json!([all[1]]), "{p}");
    assert_eq!(p["items"][0]["protected"][0]["at"], json!(all[0]));
    assert_eq!(p["count"], 1);
    // Nothing goes without the confirmation.
    assert!(call("library.removeSnapshots", json!({})).is_err());
    assert!(call("library.removeSnapshots", json!({ "token": "guess" })).is_err());
    assert!(folder(&all[1]).exists());

    // Step two.
    let r = call("library.removeSnapshots", json!({ "token": p["token"] })).unwrap();
    assert_eq!(r["removed"], 1, "{r}");
    assert!(!folder(&all[1]).exists());
    assert!(folder(&all[0]).exists() && folder(&all[2]).exists());
    assert_eq!(snaps(&item), vec![all[0].clone(), all[2].clone()]);
    let rec = call("records.get", json!({ "id": item })).unwrap();
    assert_eq!(rec["fields"]["library.snapshot"], json!(all[2]), "the latest stays current");
    // The token is used up.
    assert!(call("library.removeSnapshots", json!({ "token": p["token"] })).is_err());

    // Asking to remove every snapshot: the capture's stays, so the other may go; one is kept.
    let p = call("library.removeSnapshots.prepare", json!({ "items": [{ "id": item, "snapshots": snaps(&item) }] }))
        .unwrap();
    assert_eq!(p["items"][0]["remove"], json!([all[2]]), "{p}");
    assert_eq!(p["items"][0]["kept"], 1);
    // An item with one snapshot, asked to remove it, keeps it.
    call("library.removeSnapshots", json!({ "token": p["token"] })).unwrap();
    let p = call("library.removeSnapshots.prepare", json!({ "items": [{ "id": item, "snapshots": snaps(&item) }] }))
        .unwrap();
    assert_eq!(p["items"][0]["remove"], json!([]), "{p}");
    assert_eq!(snaps(&item), vec![all[0].clone()]);

    a.api.close_library();
    let _ = std::fs::remove_dir_all(&dir);
}
