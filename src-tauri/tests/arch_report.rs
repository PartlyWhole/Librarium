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
    println!("\nAPI calls: {}", api.len());
    for m in api {
        println!("  {m}");
    }

    println!("\nSlots and their contributors:");
    let contributed = compose::slot_contributors();
    for def in librarium_contracts::slots::all() {
        let list = contributed.iter().find(|(s, _)| *s == def.id).map(|(_, l)| l.clone()).unwrap_or_default();
        let who = if list.is_empty() {
            "(none yet)".to_string()
        } else {
            list.iter().map(|(id, by)| format!("{id} <- {by}")).collect::<Vec<_>>().join(", ")
        };
        println!("  {:<28} {:?}  {who}", def.id, def.host);
    }

    println!("\nTimings against budgets (BRIEF §8):");
    let worker = worker_round_trip();
    println!("  worker start + ping            {:>8.1} ms   (no budget)", ms(worker));
    println!("  cold start, 10,000 notes       not measured until milestone 2   budget 1500 ms");
    println!("  keystroke to paint             not measured until milestone 2   budget 16 ms");
    println!("  palette opens                  not measured until milestone 2   budget 50 ms");
    println!();
}

fn worker_round_trip() -> Duration {
    let bin = librarium_testkit::binaries::worker_binary();
    let t = Instant::now();
    let app = compose::App::compose(bin, std::env::temp_dir().join(format!("librarium-arch-{}", std::process::id())));
    app.api.worker_ping().expect("worker answers");
    t.elapsed()
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}
