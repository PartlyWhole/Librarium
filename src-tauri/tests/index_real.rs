//! Search, backlinks, label repair and index rebuilds with the real adapters (§8, milestone 4).
use librarium_app::compose::App;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("librarium-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join("lib/notes")).unwrap();
    d
}

fn app(d: &Path) -> App {
    let a = App::compose(librarium_testkit::binaries::worker_binary(), d.join("support"), d.join("logs"));
    let t = Instant::now();
    a.api.open_library(&d.join("lib")).unwrap();
    let opened = t.elapsed();
    let h = a.api.hosts().unwrap();
    assert!(h.views.wait_applied(0, Duration::from_secs(120)), "views ready");
    eprintln!("library open {opened:?}, views ready {:?}", t.elapsed());
    a
}

fn settle(a: &App) {
    let lib = a.api.library().unwrap();
    let seq = lib.store.changes.last_seq();
    assert!(a.api.hosts().unwrap().views.wait_applied(seq, Duration::from_secs(10)));
}

const WORDS: &[&str] =
    &["technique", "society", "attention", "grace", "gravity", "propaganda", "freedom", "work", "city", "reading"];

#[test]
fn search_is_fast_on_ten_thousand_notes() {
    let d = dir("search10k");
    for i in 0..10_000u32 {
        let id = format!("0192f3a4-7c1e-7b2a-9f00-{i:012x}");
        let w = |k: u32| WORDS[(k as usize) % WORDS.len()];
        let body = format!(
            "A note about {} and {}.\n\nIt mentions {} once, and {} twice: {} {}.\n",
            w(i),
            w(i / 7),
            w(i / 3),
            w(i + 1),
            w(i + 1),
            w(i + 1)
        );
        std::fs::write(
            d.join(format!("lib/notes/{id}-note-{i}.md")),
            format!("---\nid: \"{id}\"\nkind: \"note\"\ntitle: \"Note {i} on {}\"\n---\n{body}", w(i)),
        )
        .unwrap();
    }
    std::fs::write(d.join("lib/notes/0192f3a4-7c1e-7b2a-9f00-ffffffffffff-x.md"), "---\nid: \"0192f3a4-7c1e-7b2a-9f00-ffffffffffff\"\nkind: \"note\"\ntitle: \"The Technological Society\"\n---\nEllul's \"technological society\" is a book.\n").unwrap();
    let t = Instant::now();
    let a = app(&d);
    eprintln!("opened and indexed 10,000 notes in {:?}", t.elapsed());
    let mut worst = Duration::ZERO;
    for q in ["technique", "grav", "\"technological society\"", "freedom -work", "attention grace"] {
        let t = Instant::now();
        let hits = a.api.call("search.query", json!({ "text": q, "limit": 50 })).unwrap();
        worst = worst.max(t.elapsed());
        assert!(!hits.as_array().unwrap().is_empty(), "{q}");
        assert!(hits[0]["snippet"].as_str().unwrap().contains('\u{2}'), "snippets mark matches: {q}");
    }
    eprintln!("slowest search: {worst:?}");
    assert!(worst < Duration::from_millis(150), "search took {worst:?}");
    let top = a.api.call("search.query", json!({ "text": "technological", "limit": 5 })).unwrap();
    assert_eq!(top[0]["title"], "The Technological Society", "the title is weighted above the body");
    a.api.close_library();
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn backlinks_labels_rebuilds() {
    let d = dir("links");
    let a = app(&d);
    let create = |title: &str, body: &str| -> Value {
        a.api.call("notes.create", json!({ "title": title, "body": body })).unwrap()["info"].clone()
    };
    let weil = create("Simone Weil", "Attention.\n");
    let wid = weil["id"].as_str().unwrap().to_string();
    let link = format!("[[Simone Weil|{wid}]]");
    let r1 = create("Reading list", &format!("- {link} on attention\n"));
    let r2 = create("Grace", &format!("See {link}.\n\n```\n{link} in code is not a link\n```\n"));
    let _r3 = create("Unrelated", "Nothing here.\n");
    let own = create("Own words", &format!("My [[teacher|{wid}]] said so.\n"));
    let orphan = create("Orphan", "Links to [[Ellul]] who has no note yet.\n");
    settle(&a);

    // Backlinks list every linking record.
    let bl = a.api.call("links.backlinks", json!({ "id": wid })).unwrap();
    let mut sources: Vec<&str> = bl.as_array().unwrap().iter().map(|b| b["title"].as_str().unwrap()).collect();
    sources.sort();
    assert_eq!(sources, ["Grace", "Own words", "Reading list"]);
    assert_eq!(
        bl.as_array().unwrap().iter().find(|b| b["title"] == "Reading list").unwrap()["context"],
        "Simone Weil on attention"
    );
    let un = a.api.call("links.unresolved", json!({})).unwrap();
    assert_eq!(un[0]["label"], "Ellul");

    // Renaming refreshes stale labels (a repair job, when the folder is quiet).
    a.api.call("records.relocate", json!({ "id": wid, "title": "Weil, Simone" })).unwrap();
    let read =
        |id: &Value| a.api.call("records.read", json!({ "id": id })).unwrap()["body"].as_str().unwrap().to_string();
    let deadline = Instant::now() + Duration::from_secs(20);
    while !read(&r1["id"]).contains("[[Weil, Simone|") && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(read(&r1["id"]).contains(&format!("[[Weil, Simone|{wid}]] on attention")), "{}", read(&r1["id"]));
    assert!(read(&r2["id"]).contains(&format!("```\n{link} in code")), "code is left alone");
    assert!(read(&own["id"]).contains(&format!("My [[teacher|{wid}]] said so.")), "a label in one's own words stays");

    // A missing ID is restored from the label when exactly one record has that title.
    let ellul = create("Ellul", "");
    let eid = ellul["id"].as_str().unwrap().to_string();
    let deadline = Instant::now() + Duration::from_secs(20);
    while !read(&orphan["id"]).contains(&eid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(read(&orphan["id"]).contains(&format!("[[Ellul|{eid}]]")), "{}", read(&orphan["id"]));

    // Deleting the index files and restarting rebuilds everything.
    a.api.close_library();
    drop(a);
    let libs = d.join("support/libraries");
    let lib_dir = std::fs::read_dir(&libs).unwrap().flatten().next().unwrap().path();
    std::fs::remove_dir_all(lib_dir.join("index")).unwrap();
    let a = app(&d);
    assert_eq!(a.api.library().unwrap().startup.mode, "full");
    let bl = a.api.call("links.backlinks", json!({ "id": wid })).unwrap();
    assert_eq!(bl.as_array().unwrap().len(), 3, "Grace, Own words, Reading list");
    assert!(!a.api.call("search.query", json!({ "text": "attention" })).unwrap().as_array().unwrap().is_empty());

    // The visible "Rebuild index" command.
    let j = a.api.call("index.rebuild", json!({})).unwrap();
    let id = j["id"].as_str().unwrap().parse().unwrap();
    let done = a.api.hosts().unwrap().jobs.wait(id, Duration::from_secs(30)).unwrap();
    assert_eq!(done.state, librarium_contracts::api::JobState::Done);
    assert_eq!(a.api.call("links.backlinks", json!({ "id": wid })).unwrap().as_array().unwrap().len(), 3);
    a.api.close_library();
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn a_worker_killed_mid_job_is_restarted_and_the_job_retried_once() {
    use librarium_contracts::ports::WorkerHost;
    use librarium_worker_process::ProcessWorkerHost;
    use std::sync::Arc;
    let host = Arc::new(ProcessWorkerHost::new(librarium_testkit::binaries::worker_binary(), 2 << 30));
    host.call("ping", json!({}), Duration::from_secs(10)).unwrap();
    let first = host.pid().unwrap();
    // Kill the worker while it is busy.
    let h2 = host.clone();
    let killer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        unsafe { kill(h2.pid().unwrap() as i32, 9) };
    });
    let mut attempts = 0;
    let result = loop {
        attempts += 1;
        match host.call("test.sleep", json!({ "ms": 1500 }), Duration::from_secs(10)) {
            Err(e) if e.code == librarium_contracts::ErrorCode::Worker && attempts < 2 => continue,
            other => break other,
        }
    };
    killer.join().unwrap();
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(attempts, 2, "one retry");
    assert_ne!(host.pid().unwrap(), first, "a fresh worker");
}

extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}
