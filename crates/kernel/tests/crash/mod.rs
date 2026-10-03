//! Crash scenarios, shared by the durability-modelling fake (power cuts) and a real folder
//! (process crashes): cut at every step of an operation, restart, and check the invariants.
#![allow(dead_code)]

use librarium_contracts::api::SaveResult;
use librarium_contracts::ports::{ChangeSource, FileSystem, IndexEngine};
use librarium_contracts::Id;
use librarium_kernel::frontmatter::FmValue;
use librarium_kernel::kinds::{Format, Kinds, RecordKindDef};
use librarium_kernel::library::{Library, LibraryPorts, OpenOptions};
use librarium_kernel::writer::Lane;
use librarium_testkit::changes::ScriptedChanges;
use librarium_testkit::clock::FixedClock;
use librarium_testkit::ids::SequenceIds;
use librarium_testkit::memindex::MemIndex;
use librarium_testkit::versions::RecordingVersions;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

/// A file system that can crash and come back.
pub trait Rig {
    fn fs(&self) -> Arc<dyn FileSystem>;
    fn root(&self) -> PathBuf;
    fn app(&self) -> PathBuf;
    /// The next `n` mutating operations succeed; then it crashes.
    fn crash_after(&self, n: u64);
    fn crashed(&self) -> bool;
    /// Crash now (a power cut for the fake; a process kill for a real folder).
    fn crash_now(&self);
    fn restart(&mut self);
    /// Every file under the root (absolute paths).
    fn all_files(&self) -> Vec<PathBuf>;
}

pub struct World<R: Rig> {
    pub rig: R,
    index: MemIndex,
    src: Arc<ScriptedChanges>,
    clock: Arc<FixedClock>,
    ids: Arc<SequenceIds>,
}

fn kinds() -> Kinds {
    let mut k = Kinds::new();
    k.add(
        "test",
        RecordKindDef {
            kind: "page".into(),
            version: 1,
            format: Format::Markdown,
            folder: "pages".into(),
            slugged: true,
            subfolder_field: Some("test.folder".into()),
        },
    )
    .unwrap();
    k
}

impl<R: Rig> World<R> {
    pub fn new(rig: R) -> Self {
        World {
            rig,
            index: MemIndex::new(),
            src: Arc::new(ScriptedChanges::new()),
            clock: Arc::new(FixedClock::new()),
            ids: Arc::new(SequenceIds::new()),
        }
    }
    pub fn open(&self) -> Library {
        let index = self.index.clone();
        Library::open(
            &self.rig.root(),
            &self.rig.app(),
            LibraryPorts {
                fs: self.rig.fs(),
                clock: self.clock.clone(),
                ids: self.ids.clone(),
                versions: Arc::new(RecordingVersions::default()),
                index: Arc::new(move |_p: &Path| Arc::new(index.clone()) as Arc<dyn IndexEngine>),
                changes: self.src.clone() as Arc<dyn ChangeSource>,
            },
            kinds(),
            OpenOptions {
                tick: Duration::from_secs(3600),
                replay_wait: Duration::from_secs(5),
                full_check_every_ms: i64::MAX,
            },
        )
        .expect("open after a crash")
    }

    /// Store files claiming each ID, ignoring app metadata.
    pub fn claims(&self) -> BTreeMap<Id, Vec<String>> {
        let fs = self.rig.fs();
        let root = self.rig.root();
        let mut out: BTreeMap<Id, Vec<String>> = BTreeMap::new();
        for p in self.rig.all_files() {
            let rel = p.strip_prefix(&root).unwrap().to_string_lossy().to_string();
            if rel.starts_with(".librarium") || !rel.ends_with(".md") {
                continue;
            }
            let text = String::from_utf8(fs.read(&p).unwrap()).unwrap();
            let d = librarium_kernel::record::decode_markdown(&text, "page", &kinds());
            if let Some(id) = d.id {
                out.entry(id).or_default().push(rel);
            }
        }
        out
    }

    /// Invariants after any crash and restart.
    pub fn check_invariants(&self, lib: &Library) {
        let root = self.rig.root();
        let leftovers: Vec<_> = self
            .rig
            .all_files()
            .into_iter()
            .filter(|p| p.to_string_lossy().contains(".librarium-tmp-") && !p.starts_with(root.join(".librarium")))
            .collect();
        assert!(leftovers.is_empty(), "temporary files left: {leftovers:?}");
        for (id, files) in self.claims() {
            assert_eq!(files.len(), 1, "two files claim {id}: {files:?}");
            let e = lib.store.get(id).unwrap_or_else(|| panic!("{id} is on disk but not listed"));
            assert_eq!(e.path, files[0], "the table points at the file");
        }
        for e in lib.store.list(None) {
            assert!(self.rig.fs().stat(&root.join(&e.path)).unwrap().is_some(), "{} listed but missing", e.path);
        }
        let intents = self.rig.fs().list(&self.rig.app().join("libraries")).unwrap_or_default();
        let _ = intents;
        assert!(lib.store.duplicates().is_empty(), "{:?}", lib.store.duplicates());
    }
}

fn body_of(lib: &Library, id: Id) -> String {
    lib.store.read_text(id).unwrap().body
}

/// Runs `op` with a crash at every step, then checks invariants and `after`.
pub fn sweep<R: Rig>(
    make: &dyn Fn() -> R,
    name: &str,
    setup: &dyn Fn(&Library) -> Id,
    op: &dyn Fn(&Library, Id) -> bool,
    after: &dyn Fn(&Library, Id, bool),
) -> u64 {
    let mut k = 0;
    loop {
        let mut w = World::new(make());
        let lib = w.open();
        let id = setup(&lib);
        w.rig.crash_after(k);
        let ok = op(&lib, id);
        let crashed_during = w.rig.crashed();
        if !crashed_during {
            w.rig.crash_now();
        }
        drop(lib);
        w.rig.restart();
        let lib = w.open();
        assert_eq!(lib.startup.mode, "full", "{name}@{k}: an unclean shutdown means a full check");
        w.check_invariants(&lib);
        after(&lib, id, ok);
        drop(lib);
        if !crashed_during {
            return k;
        }
        k += 1;
    }
}

pub fn create_scenarios<R: Rig>(make: &dyn Fn() -> R) {
    // Creating: afterwards the note exists whole, or not at all.
    let steps = sweep(
        make,
        "create",
        &|_| Id::from_uuid(uuid_nil()),
        &|lib, _| lib.write(Lane::Interactive, |tx| tx.create("page", "New page", vec![], "Body text\n", None)).is_ok(),
        &|lib, _, ok| {
            let pages = lib.store.list(Some("page"));
            if ok {
                assert_eq!(pages.len(), 1, "a completed create is durable");
            }
            for p in pages {
                assert_eq!(p.title, "New page");
                assert_eq!(body_of(lib, p.id), "Body text\n");
            }
        },
    );
    assert!(steps >= 4, "create took {steps} steps");
}

fn uuid_nil() -> uuid::Uuid {
    uuid::Uuid::nil()
}

fn seed(lib: &Library) -> Id {
    lib.write(Lane::Interactive, |tx| tx.create("page", "Seed", vec![], "old body\n", None)).unwrap().0.id
}

pub fn save_scenarios<R: Rig>(make: &dyn Fn() -> R) {
    sweep(
        make,
        "save",
        &seed,
        &|lib, id| {
            let v = lib.store.get(id).unwrap().hash;
            matches!(
                lib.write(Lane::Interactive, move |tx| tx.save_body(id, &v, None, "new body\n")),
                Ok(SaveResult::Saved { .. })
            )
        },
        &|lib, id, ok| {
            let b = body_of(lib, id);
            assert!(b == "old body\n" || b == "new body\n", "never torn: {b:?}");
            if ok {
                assert_eq!(b, "new body\n", "a completed save is durable");
            }
        },
    );
    sweep(
        make,
        "set_fields",
        &seed,
        &|lib, id| {
            lib.write(Lane::Interactive, move |tx| tx.set_fields(id, None, &[("x.n".into(), Some(FmValue::Int(5)))]))
                .is_ok()
        },
        &|lib, id, ok| {
            let e = lib.store.get(id).unwrap();
            if ok {
                assert_eq!(e.fields.get("x.n"), Some(&serde_json::json!(5)));
            }
            assert_eq!(body_of(lib, id), "old body\n");
        },
    );
}

pub fn rename_scenarios<R: Rig>(make: &dyn Fn() -> R) {
    let steps = sweep(
        make,
        "rename",
        &seed,
        &|lib, id| {
            lib.write(Lane::Interactive, move |tx| tx.relocate(id, Some("Renamed Seed"), Some(Some("Sub")))).is_ok()
        },
        &|lib, id, ok| {
            let e = lib.store.get(id).expect("the record survives");
            let old = (format!("pages/{id}-seed.md"), "Seed".to_string());
            let new = (format!("pages/Sub/{id}-renamed-seed.md"), "Renamed Seed".to_string());
            let now = (e.path.clone(), e.title.clone());
            assert!(now == old || now == new, "consistent after redo: {now:?}");
            if ok {
                assert_eq!(now, new, "a completed rename is durable");
            }
            assert_eq!(body_of(lib, id), "old body\n");
        },
    );
    assert!(steps >= 6, "rename took {steps} steps");
}

pub fn delete_scenarios<R: Rig>(make: &dyn Fn() -> R) {
    // Deleting permanently: afterwards the record and its sidecars are all there, or all gone.
    let steps = sweep(
        make,
        "delete",
        &|lib| {
            lib.write(Lane::Interactive, |tx| {
                tx.create_with_sidecars(
                    "page",
                    "Seed",
                    vec![],
                    "old body\n",
                    vec![(".anchor.json".into(), b"{}".to_vec())],
                )
            })
            .unwrap()
            .0
            .id
        },
        &|lib, id| {
            let v = lib.store.get(id).unwrap().hash;
            lib.write(Lane::Interactive, move |tx| tx.delete_permanently(id, &v)).is_ok()
        },
        &|lib, id, ok| {
            let sidecar = lib.store.fs.stat(&lib.store.root.join(format!("pages/{id}.anchor.json"))).unwrap().is_some();
            match lib.store.get(id) {
                Some(_) => {
                    assert!(!ok, "a completed delete is durable");
                    assert!(sidecar, "a record that survives keeps its sidecar");
                    assert_eq!(body_of(lib, id), "old body\n");
                }
                None => assert!(!sidecar, "no sidecar outlives its record"),
            }
        },
    );
    assert!(steps >= 3, "delete took {steps} steps");
}

pub fn move_folder_scenarios<R: Rig>(make: &dyn Fn() -> R) {
    // Moving a folder: afterwards every record in it is in the old place or all are in the new
    // one, and each one's folder field matches its path.
    let steps = sweep(
        make,
        "move folder",
        &|lib| {
            let a =
                lib.write(Lane::Interactive, |tx| tx.create("page", "Seed", vec![], "old body\n", Some("A"))).unwrap();
            lib.write(Lane::Interactive, |tx| tx.create("page", "Deeper", vec![], "deep\n", Some("A/B"))).unwrap();
            a.0.id
        },
        &|lib, _| lib.write(Lane::Interactive, |tx| tx.move_folder("page", "A", "Z/A")).is_ok(),
        &|lib, id, ok| {
            let all = lib.store.list(Some("page"));
            assert_eq!(all.len(), 2, "both records survive");
            let moved = all.iter().filter(|e| e.path.starts_with("pages/Z/A/")).count();
            assert!(moved == 0 || moved == 2, "all or nothing: {:?}", all.iter().map(|e| &e.path).collect::<Vec<_>>());
            if ok {
                assert_eq!(moved, 2, "a completed move is durable");
            }
            for e in &all {
                let sub = e.path.strip_prefix("pages/").unwrap().rsplit_once('/').unwrap().0;
                assert_eq!(
                    e.fields.get("test.folder").and_then(|v| v.as_str()),
                    Some(sub),
                    "the field follows {}",
                    e.path
                );
            }
            assert_eq!(body_of(lib, id), "old body\n");
        },
    );
    assert!(steps >= 3, "moving a folder took {steps} steps");
}
