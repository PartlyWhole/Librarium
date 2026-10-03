//! Archive and permanent deletion with the real adapters (§8, milestone 9): nothing is deleted
//! without the two-step confirmation.
use librarium_app::compose::App;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

struct T {
    a: App,
    dir: PathBuf,
}

impl Drop for T {
    fn drop(&mut self) {
        self.a.api.close_library();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn open(name: &str) -> T {
    let dir = std::env::temp_dir().join(format!("librarium-archive-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("lib")).unwrap();
    let a = App::compose(librarium_testkit::binaries::worker_binary(), dir.join("support"), dir.join("logs"));
    a.api.open_library(&dir.join("lib")).unwrap();
    T { a, dir }
}

fn call(t: &T, m: &str, p: Value) -> Result<Value, librarium_contracts::BackendError> {
    t.a.api.call(m, p)
}

/// Every file under the library, except the app's own folder.
fn files(root: &Path) -> Vec<String> {
    let mut out = vec![];
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap().flatten() {
            let p = e.path();
            if p.file_name().unwrap() == ".librarium" {
                continue;
            }
            if p.is_dir() {
                stack.push(p);
            } else {
                out.push(p.strip_prefix(root).unwrap().display().to_string());
            }
        }
    }
    out.sort();
    out
}

fn note(t: &T, title: &str, body: &str) -> Value {
    let w = call(t, "notes.create", json!({ "title": title })).unwrap();
    let id = w["info"]["id"].clone();
    let v = w["info"]["version"].clone();
    call(t, "records.save", json!({ "id": id, "body": body, "base_version": v })).unwrap();
    call(t, "records.get", json!({ "id": id })).unwrap()
}

#[test]
fn nothing_is_deleted_without_both_steps() {
    let t = open("steps");
    let lib = t.dir.join("lib");
    let n = note(&t, "Keep me", "Some words about gravity.");
    let id = n["id"].clone();
    let before = files(&lib);

    // Without archiving first, deletion can't even be prepared.
    let e = call(&t, "archive.prepareDelete", json!({ "ids": [id] })).unwrap_err();
    assert!(e.message.contains("Archive it first"), "{}", e.message);
    // No token, a made-up token: nothing happens.
    assert!(call(&t, "archive.delete", json!({})).is_err());
    assert!(call(&t, "archive.delete", json!({ "token": "guess" })).is_err());
    assert_eq!(files(&lib), before);

    // Step one: archive. The file stays (with `archive.at`), hidden from search.
    let w = call(&t, "archive.archive", json!({ "id": id })).unwrap();
    assert!(w["info"]["fields"]["archive.at"].is_string());
    assert_eq!(files(&lib), before);
    let listed = call(&t, "archive.list", json!({})).unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);
    let hosts = t.a.api.hosts().unwrap();
    assert!(hosts.views.wait_applied(w["seq"].as_u64().unwrap(), Duration::from_secs(20)));
    let hidden = call(&t, "search.query", json!({ "text": "gravity", "hide": ["archive.at"] })).unwrap();
    assert_eq!(hidden, json!([]));
    let shown = call(&t, "search.query", json!({ "text": "gravity" })).unwrap();
    assert_eq!(shown.as_array().unwrap().len(), 1);

    // Step two, part one: a preview with a token. Still nothing deleted.
    let p = call(&t, "archive.prepareDelete", json!({ "ids": [id] })).unwrap();
    assert_eq!(p["files"], 1);
    assert_eq!(files(&lib), before);

    // The record changes after the preview: the confirmation no longer covers it.
    let cur = call(&t, "records.get", json!({ "id": id })).unwrap();
    call(&t, "records.save", json!({ "id": id, "body": "Changed my mind.\n", "base_version": cur["version"] }))
        .unwrap();
    let r = call(&t, "archive.delete", json!({ "token": p["token"] })).unwrap();
    assert_eq!(r["deleted"], json!([]));
    assert_eq!(r["skipped"].as_array().unwrap().len(), 1);
    assert!(call(&t, "records.get", json!({ "id": id })).is_ok());
    // The token is used up.
    assert!(call(&t, "archive.delete", json!({ "token": p["token"] })).is_err());

    // A fresh preview, confirmed: now it's gone, from disk and from the records.
    let p = call(&t, "archive.prepareDelete", json!({ "ids": [id] })).unwrap();
    let r = call(&t, "archive.delete", json!({ "token": p["token"] })).unwrap();
    assert_eq!(r["deleted"], json!([id]));
    assert!(files(&lib).iter().all(|f| !f.starts_with("notes/")), "{:?}", files(&lib));
    assert!(call(&t, "records.get", json!({ "id": id })).is_err());
    assert_eq!(call(&t, "archive.list", json!({})).unwrap(), json!([]));
}

#[test]
fn restore_is_undoable_and_refuses_after_outside_changes() {
    let t = open("restore");
    let n = note(&t, "Back again", "Text.");
    let id = n["id"].clone();
    let a = call(&t, "archive.archive", json!({ "id": id })).unwrap();
    // Undo of archive: restore expecting the archived version.
    let r = call(&t, "archive.restore", json!({ "id": id, "base_version": a["info"]["version"] })).unwrap();
    assert!(r["info"]["fields"].get("archive.at").is_none());
    // An undo that expects an older version is refused.
    let e = call(&t, "archive.archive", json!({ "id": id, "base_version": a["info"]["version"] })).unwrap_err();
    assert_eq!(e.code, librarium_contracts::ErrorCode::Conflict);
    // Archiving and restoring leave the body alone.
    let path = t.dir.join("lib").join(r["info"]["path"].as_str().unwrap());
    assert!(std::fs::read_to_string(path).unwrap().contains("\nText."));
}

#[test]
fn deleting_an_item_removes_its_whole_folder_and_its_sidecars_only() {
    let t = open("item");
    let lib = t.dir.join("lib");
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/library/short.pdf");
    let r = call(&t, "library.import", json!({ "paths": [fixture.display().to_string()] })).unwrap();
    let item = r["imported"][0]["info"]["id"].clone();
    // A capture of it, with a region sidecar, and an unrelated note.
    let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    let c = call(
        &t,
        "captures.create",
        json!({ "source": item, "parts": [{ "quote": "", "selector": [{"type":"FragmentSelector","value":"page=1"}], "region_png": png }] }),
    )
    .unwrap();
    let cap = c["info"]["id"].clone();
    note(&t, "Unrelated", "Stays.");
    let jobs = &t.a.api.hosts().unwrap().jobs;
    for _ in 0..600 {
        if jobs.list().running.is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    for id in [&item, &cap] {
        call(&t, "archive.archive", json!({ "id": id })).unwrap();
    }
    let before = files(&lib);
    let p = call(&t, "archive.prepareDelete", json!({ "ids": [item, cap] })).unwrap();
    let listed: usize = p["records"].as_array().unwrap().iter().map(|r| r["files"].as_array().unwrap().len()).sum();
    assert_eq!(p["files"].as_u64().unwrap() as usize, listed);
    let r = call(&t, "archive.delete", json!({ "token": p["token"] })).unwrap();
    assert_eq!(r["deleted"].as_array().unwrap().len(), 2, "{r}");
    let after = files(&lib);
    let gone: Vec<_> = before.iter().filter(|f| !after.contains(f)).collect();
    assert_eq!(gone.len(), listed, "deleted exactly what the preview listed: {gone:?}");
    assert!(after.iter().any(|f| f.starts_with("notes/")), "the unrelated note stays");
    assert!(!lib.join("items").read_dir().unwrap().any(|_| true), "no empty item folder is left");
    assert!(after.iter().all(|f| !f.starts_with("captures/")), "{after:?}");
}
