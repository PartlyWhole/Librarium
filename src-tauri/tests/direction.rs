//! Direction tests (BRIEF §4.3): dependencies point inward, towards `contracts`.
mod common;

use common::{graph, Crate, Edge, Ring};
use std::collections::HashMap;
use syn::visit::Visit;

/// Is a dependency from `from` to `to` allowed? Dev-dependencies may also use the testkit.
fn allowed(from: Ring, to: Ring, dev: bool) -> bool {
    use Ring::*;
    if dev && to == Testkit && from != Contracts {
        return true;
    }
    match from {
        Root => true,
        Contracts => false,
        Kernel => to == Contracts,
        Api => matches!(to, Contracts | Kernel),
        Adapter => to == Contracts,
        Feature => matches!(to, Contracts | Kernel),
        Worker => to == Contracts,
        Testkit => to == Contracts,
    }
}

fn violations(crates: &[Crate], edges: &[Edge]) -> Vec<String> {
    let ring: HashMap<_, _> = crates.iter().map(|c| (c.name.as_str(), c.ring)).collect();
    edges
        .iter()
        .filter(|e| !allowed(ring[e.from.as_str()], ring[e.to.as_str()], e.dev))
        .map(|e| {
            format!(
                "{} ({:?}) -> {} ({:?}){}",
                e.from,
                ring[e.from.as_str()],
                e.to,
                ring[e.to.as_str()],
                if e.dev { " [dev]" } else { "" }
            )
        })
        .collect()
}

#[test]
fn crate_dependencies_point_inward() {
    let (crates, edges) = graph();
    let v = violations(&crates, &edges);
    assert!(v.is_empty(), "forbidden dependencies:\n{}", v.join("\n"));
}

#[test]
fn the_rules_catch_each_forbidden_edge() {
    let c = |n: &str, r| Crate { name: n.into(), ring: r, dir: Default::default() };
    let crates = vec![
        c("contracts", Ring::Contracts),
        c("kernel", Ring::Kernel),
        c("api", Ring::Api),
        c("fs", Ring::Adapter),
        c("notes", Ring::Feature),
        c("daily", Ring::Feature),
        c("testkit", Ring::Testkit),
        c("app", Ring::Root),
    ];
    let e = |a: &str, b: &str, dev| Edge { from: a.into(), to: b.into(), dev };
    for bad in [
        e("notes", "daily", false),  // feature -> feature
        e("kernel", "notes", false), // kernel -> feature
        e("api", "notes", false),    // api -> feature
        e("notes", "fs", false),     // feature -> adapter
        e("kernel", "fs", false),    // kernel -> adapter
        e("kernel", "fs", true),     // kernel -> adapter, even in tests
        e("fs", "kernel", false),    // adapter -> kernel
        e("contracts", "kernel", false),
    ] {
        assert_eq!(violations(&crates, std::slice::from_ref(&bad)).len(), 1, "{bad:?} should be forbidden");
    }
    for good in
        [e("notes", "kernel", false), e("api", "kernel", false), e("app", "notes", false), e("kernel", "testkit", true)]
    {
        assert!(violations(&crates, std::slice::from_ref(&good)).is_empty(), "{good:?} should be allowed");
    }
}

/// Feature IDs are the folder names under crates/features.
fn feature_ids(crates: &[Crate]) -> Vec<String> {
    crates
        .iter()
        .filter(|c| c.ring == Ring::Feature)
        .map(|c| c.dir.file_name().unwrap().to_string_lossy().to_string())
        .collect()
}

struct Names<'a> {
    features: &'a [String],
    hits: Vec<String>,
}

impl<'a> Names<'a> {
    fn check(&mut self, s: &str, what: &str) {
        for f in self.features {
            let crate_name = format!("librarium_feature_{f}");
            let crate_dash = format!("librarium-feature-{f}");
            if s == f || s.starts_with(&format!("{f}.")) || s.contains(&crate_name) || s.contains(&crate_dash) {
                self.hits.push(format!("{what} {s:?} names feature {f:?}"));
            }
        }
    }
}

impl<'ast> Visit<'ast> for Names<'_> {
    fn visit_lit_str(&mut self, l: &'ast syn::LitStr) {
        self.check(&l.value(), "string");
    }
    fn visit_ident(&mut self, i: &'ast proc_macro2::Ident) {
        self.check(&i.to_string(), "identifier");
    }
}

fn names_in(src: &str, features: &[String]) -> Vec<String> {
    let file = syn::parse_file(src).expect("parse");
    let mut v = Names { features, hits: vec![] };
    v.visit_file(&file);
    v.hits
}

#[test]
fn no_kernel_crate_names_a_feature() {
    let (crates, _) = graph();
    let features = feature_ids(&crates);
    assert!(features.len() >= 7, "{features:?}");
    let mut hits = vec![];
    for c in crates.iter().filter(|c| matches!(c.ring, Ring::Contracts | Ring::Kernel | Ring::Api)) {
        let manifest = std::fs::read_to_string(c.dir.join("Cargo.toml")).unwrap();
        if manifest.contains("librarium-feature-") {
            hits.push(format!("{}: Cargo.toml names a feature crate", c.name));
        }
        for path in rust_files(&c.dir) {
            let src = std::fs::read_to_string(&path).unwrap();
            for h in names_in(&src, &features) {
                hits.push(format!("{}: {h}", path.strip_prefix(&c.dir).unwrap().display()));
            }
        }
    }
    assert!(hits.is_empty(), "the kernel must not name features:\n{}", hits.join("\n"));
}

#[test]
fn the_name_guard_catches_strings_and_paths() {
    let f = vec!["notes".to_string(), "daily".to_string()];
    assert_eq!(names_in(r#"const K: &str = "daily.date";"#, &f).len(), 1);
    assert_eq!(names_in(r#"fn f() { let _ = "notes"; }"#, &f).len(), 1);
    assert_eq!(names_in("use librarium_feature_notes::X;", &f).len(), 1);
    assert!(names_in(r#"const K: &str = "notebook"; const L: &str = "kind";"#, &f).is_empty());
}

fn rust_files(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = vec![];
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                if p.file_name().is_some_and(|n| n != "target") {
                    stack.push(p);
                }
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}
