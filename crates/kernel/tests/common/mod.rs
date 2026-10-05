//! A test library on the durability-modelling fakes. Kinds use neutral names: the kernel
//! (and its tests) never name a feature.
#![allow(dead_code)]

use librarium_contracts::events::Change;
use librarium_contracts::ports::{ChangeSource, Clock, FileSystem, IdGenerator, IndexEngine};
use librarium_kernel::kinds::{Format, Kinds, RecordKindDef, SlugField};
use librarium_kernel::library::{Library, LibraryPorts, OpenOptions};
use librarium_testkit::changes::ScriptedChanges;
use librarium_testkit::clock::FixedClock;
use librarium_testkit::ids::SequenceIds;
use librarium_testkit::memfs::MemFs;
use librarium_testkit::memindex::MemIndex;
use librarium_testkit::versions::RecordingVersions;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const ROOT: &str = "/Users/me/Library";
pub const APP: &str = "/Users/me/AppSupport";

pub fn kinds() -> Kinds {
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
    k.add(
        "test",
        RecordKindDef {
            kind: "clip".into(),
            version: 1,
            format: Format::Markdown,
            folder: "clips".into(),
            slugged: false,
            subfolder_field: None,
        },
    )
    .unwrap();
    k.add(
        "test",
        RecordKindDef {
            kind: "thing".into(),
            version: 1,
            format: Format::JsonDir,
            folder: "things".into(),
            slugged: true,
            subfolder_field: Some("test.place".into()),
        },
    )
    .unwrap();
    // Kept beside pages, in their folders (as boards are beside notes).
    k.add(
        "test",
        RecordKindDef {
            kind: "sketch".into(),
            version: 1,
            format: Format::Markdown,
            folder: "pages".into(),
            slugged: true,
            subfolder_field: Some("test.folder".into()),
        },
    )
    .unwrap();
    k.add_slug_field("test", SlugField { kind: "page".into(), field: "test.date".into() }).unwrap();
    k
}

pub struct H {
    pub fs: Arc<MemFs>,
    pub index: MemIndex,
    pub src: Arc<ScriptedChanges>,
    pub clock: Arc<FixedClock>,
    pub ids: Arc<SequenceIds>,
    pub changes: Arc<Mutex<Vec<Change>>>,
}

impl H {
    pub fn new() -> H {
        let fs = Arc::new(MemFs::new());
        fs.create_dir_all(Path::new(ROOT)).unwrap();
        H {
            fs,
            index: MemIndex::new(),
            src: Arc::new(ScriptedChanges::new()),
            clock: Arc::new(FixedClock::new()),
            ids: Arc::new(SequenceIds::new()),
            changes: Arc::default(),
        }
    }

    pub fn open(&self) -> Library {
        self.try_open().expect("open the library")
    }

    pub fn try_open(&self) -> librarium_contracts::Result<Library> {
        let index = self.index.clone();
        let lib = Library::open(
            Path::new(ROOT),
            Path::new(APP),
            LibraryPorts {
                fs: self.fs.clone() as Arc<dyn FileSystem>,
                clock: self.clock.clone() as Arc<dyn Clock>,
                ids: self.ids.clone() as Arc<dyn IdGenerator>,
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
        )?;
        let c = self.changes.clone();
        lib.store.changes.subscribe(Arc::new(move |ch| c.lock().unwrap().push(ch.clone())));
        Ok(lib)
    }

    pub fn abs(&self, rel: &str) -> PathBuf {
        Path::new(ROOT).join(rel)
    }

    pub fn read(&self, rel: &str) -> String {
        String::from_utf8(self.fs.read(&self.abs(rel)).unwrap()).unwrap()
    }

    /// An outside program writes a file; the change source sees it.
    pub fn outside_write(&self, rel: &str, text: &str) {
        self.fs.write_outside(&self.abs(rel), text.as_bytes());
        self.src.record(&self.abs(rel));
    }

    pub fn outside_remove(&self, rel: &str) {
        self.fs.remove_outside(&self.abs(rel));
        self.src.record(&self.abs(rel));
    }

    /// Store files (not temps, not .librarium).
    pub fn store_files(&self) -> Vec<String> {
        self.fs
            .files()
            .into_iter()
            .filter_map(|p| p.strip_prefix(ROOT).ok().map(|r| r.to_string_lossy().to_string()))
            .filter(|r| !r.starts_with(".librarium"))
            .collect()
    }
}

/// Waits until the writer has processed everything queued so far.
pub fn settle(lib: &Library) {
    lib.write(librarium_kernel::writer::Lane::Background, |_| ());
    lib.write(librarium_kernel::writer::Lane::Background, |_| ());
}
