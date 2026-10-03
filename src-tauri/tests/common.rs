//! Shared by the direction test and the architecture report: the crate graph from `cargo metadata`.
#![allow(dead_code)]

use cargo_metadata::{DependencyKind, MetadataCommand};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Ring {
    Contracts,
    Kernel,
    Api,
    Adapter,
    Feature,
    Worker,
    Testkit,
    Root,
}

#[derive(Debug, Clone)]
pub struct Crate {
    pub name: String,
    pub ring: Ring,
    pub dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Edge {
    pub from: String,
    pub to: String,
    pub dev: bool,
}

pub fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

pub fn ring_of(rel: &Path) -> Option<Ring> {
    let parts: Vec<_> = rel.iter().map(|p| p.to_string_lossy().to_string()).collect();
    match parts.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["src-tauri", ..] => Some(Ring::Root),
        ["crates", "contracts", ..] => Some(Ring::Contracts),
        ["crates", "kernel", ..] => Some(Ring::Kernel),
        ["crates", "api", ..] => Some(Ring::Api),
        ["crates", "adapters", _, ..] => Some(Ring::Adapter),
        ["crates", "features", _, ..] => Some(Ring::Feature),
        ["crates", "worker", ..] => Some(Ring::Worker),
        ["crates", "testkit", ..] => Some(Ring::Testkit),
        _ => None,
    }
}

/// Our crates and the edges between them.
pub fn graph() -> (Vec<Crate>, Vec<Edge>) {
    let root = workspace_root();
    let meta = MetadataCommand::new().manifest_path(root.join("Cargo.toml")).no_deps().exec().expect("cargo metadata");
    let mut crates = vec![];
    for p in meta.workspace_packages() {
        let dir = p.manifest_path.parent().unwrap().as_std_path().to_path_buf();
        let rel = dir.strip_prefix(&root).unwrap();
        let ring =
            ring_of(rel).unwrap_or_else(|| panic!("crate {} is outside the known rings: {}", p.name, rel.display()));
        crates.push(Crate { name: p.name.to_string(), ring, dir });
    }
    let ours: BTreeSet<_> = crates.iter().map(|c| c.name.clone()).collect();
    let mut edges = BTreeSet::new();
    for p in meta.workspace_packages() {
        for d in &p.dependencies {
            if ours.contains(&d.name) {
                edges.insert(Edge {
                    from: p.name.to_string(),
                    to: d.name.clone(),
                    dev: d.kind == DependencyKind::Development,
                });
            }
        }
    }
    (crates, edges.into_iter().collect())
}
