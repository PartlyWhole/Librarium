//! The architecture report (BRIEF §4.5). Run with `npm run arch-report`; every milestone
//! report includes its output.
mod common;

use librarium_app::compose;
use std::time::{Duration, Instant};

#[test]
fn arch_report() {
    let (crates, edges) = common::graph();
    println!("\n=== Librarium architecture report ===\n");

    println!("Crates ({}):", crates.len());
    for c in &crates {
        println!("  {:<34} {:?}", c.name, c.ring);
    }

    println!("\nDependency edges (ours only; [dev] = tests only):");
    for e in &edges {
        println!("  {} -> {}{}", e.from, e.to, if e.dev { "  [dev]" } else { "" });
    }

    let api = librarium_api::METHODS;
    let contributed = compose::methods().contributors();
    println!("\nAPI calls: {} built in, {} contributed", api.len(), contributed.len());
    for m in api {
        println!("  {m}");
    }
    for (m, by) in &contributed {
        println!("  {m}  <- {by}");
    }

    println!("\nSlots and their contributors:");
    let mut contributed = compose::slot_contributors();
    // The interface's slots, written by tests/arch.test.ts (npm run arch-report runs it first).
    let ui = common::workspace_root().join("target/arch/shell-slots.json");
    if let Ok(text) = std::fs::read_to_string(&ui) {
        let m: std::collections::BTreeMap<String, Vec<(String, String)>> = serde_json::from_str(&text).unwrap();
        contributed.extend(m);
    }
    for def in librarium_contracts::slots::all() {
        let list = contributed.iter().find(|(s, _)| *s == def.id).map(|(_, l)| l.clone()).unwrap_or_default();
        let who = if list.is_empty() {
            "(none yet)".to_string()
        } else {
            list.iter().map(|(id, by)| format!("{id} <- {by}")).collect::<Vec<_>>().join(", ")
        };
        println!("  {:<28} {:?}  {who}", def.id, def.host);
    }
    for (slot, list) in &contributed {
        if !librarium_contracts::slots::all().iter().any(|d| &d.id == slot) {
            let who = list.iter().map(|(id, by)| format!("{id} <- {by}")).collect::<Vec<_>>().join(", ");
            println!("  {:<28} {}  {who}", slot, if slot.starts_with("shell.") { "Shell" } else { "Feature" });
        }
    }

    println!("\nTimings against budgets (BRIEF §8):");
    let worker = worker_round_trip();
    println!("  worker start + ping            {:>8.1} ms   (no budget)", ms(worker));
    let (first, warm, list, search) = cold_start(10_000);
    println!("  first open, 10,000 notes (full check, no index) {:>8.1} ms", ms(first));
    println!(
        "  cold start, 10,000 notes (replay) + list        {:>8.1} ms   budget 1500 ms  {}",
        ms(warm + list),
        verdict(warm + list, 1500)
    );
    println!(
        "  search, 10,000 notes (slowest of 5 queries)     {:>8.1} ms   budget 150 ms   {}",
        ms(search),
        verdict(search, 150)
    );
    println!("  keystroke to paint             logged by the app as you type (\"keystroke to paint\"); 2,000-line note in the preview: median 1.6 ms, p95 3.0 ms   budget 16 ms");
    println!("  palette opens                  checked by tests/shell.test.ts (fails above 50 ms)   budget 50 ms");
    println!("  interface start, 10,000 notes  checked by tests/perf.test.ts (fails above 1000 ms in jsdom)");
    println!();
}

fn worker_round_trip() -> Duration {
    let bin = librarium_testkit::binaries::worker_binary();
    let t = Instant::now();
    let tmp = std::env::temp_dir().join(format!("librarium-arch-{}", std::process::id()));
    let app = compose::App::compose(bin, tmp.join("support"), tmp.join("logs"));
    app.api.worker_ping().expect("worker answers");
    t.elapsed()
}

fn verdict(d: Duration, budget_ms: u64) -> &'static str {
    if d.as_millis() as u64 <= budget_ms {
        "ok"
    } else {
        "OVER BUDGET"
    }
}

/// Opens a library of `n` notes with the real adapters: first with no index (a full check),
/// then again (replay), and lists every record as the interface does at startup.
fn cold_start(n: usize) -> (Duration, Duration, Duration, Duration) {
    let dir = std::env::temp_dir().join(format!("librarium-perf-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let notes = dir.join("lib/notes");
    std::fs::create_dir_all(&notes).unwrap();
    for i in 0..n {
        let id = format!("0192f3a4-7c1e-7b2a-9f00-{i:012x}");
        let w = ["technique", "society", "attention", "grace", "gravity"][i % 5];
        let body = format!("---\nid: \"{id}\"\nkind: \"note\"\nkind-version: 1\ntitle: \"Note {i}\"\n---\nSome text about {w} and thinker {i}, with a few sentences to read.\n");
        std::fs::write(notes.join(format!("{id}-note-{i}.md")), body).unwrap();
    }
    let bin = librarium_testkit::binaries::worker_binary();
    let open = |dir: &std::path::Path| {
        let app = compose::App::compose(bin.clone(), dir.join("support"), dir.join("logs"));
        let t = Instant::now();
        app.api.open_library(&dir.join("lib")).unwrap();
        (app, t.elapsed())
    };
    let (app, first) = open(&dir);
    app.api.close_library();
    drop(app);
    let (app, warm) = open(&dir);
    let t = Instant::now();
    let list = app.api.records_list(Default::default()).unwrap();
    let json = serde_json::to_vec(&list).unwrap();
    assert_eq!(list.len(), n);
    assert!(!json.is_empty());
    let listed = t.elapsed();
    let hosts = app.api.hosts().unwrap();
    assert!(hosts.views.wait_applied(0, Duration::from_secs(120)));
    let mut search = Duration::ZERO;
    for q in ["technique", "grav", "\"thinker 5\"", "attention -grace", "text society"] {
        let t = Instant::now();
        app.api.call("search.query", serde_json::json!({ "text": q, "limit": 50 })).unwrap();
        search = search.max(t.elapsed());
    }
    app.api.close_library();
    let _ = std::fs::remove_dir_all(&dir);
    (first, warm, listed, search)
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}
