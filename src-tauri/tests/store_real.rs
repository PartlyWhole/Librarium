//! The store on a real folder with the real adapters: crash tests (process crashes at every
//! step), outside edits seen live by FSEvents, and edits made while closed found by replay or
//! by a full check.

#[path = "../../crates/kernel/tests/crash/mod.rs"]
mod crash;

use crash::Rig;
use librarium_changes_fsevents::FsEvents;
use librarium_contracts::events::{Change, ChangeOp, ChangeOrigin};
use librarium_contracts::ports::{ChangeSource, FileSystem, IndexEngine};
use librarium_fs_macos::MacFs;
use librarium_index_sqlite::SqliteIndex;
use librarium_kernel::kinds::{Format, Kinds, RecordKindDef};
use librarium_kernel::library::{Library, LibraryPorts, OpenOptions};
use librarium_kernel::writer::Lane;
use librarium_testkit::faultfs::FaultFs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

static N: AtomicU64 = AtomicU64::new(0);

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "librarium-{tag}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join("lib")).unwrap();
    d
}

/// A real folder; "crashing" stops every later operation, as when the process dies.
struct Real {
    dir: PathBuf,
    fs: Arc<FaultFs>,
}

impl Rig for Real {
    fn fs(&self) -> Arc<dyn FileSystem> {
        self.fs.clone()
    }
    fn root(&self) -> PathBuf {
        self.dir.join("lib")
    }
    fn app(&self) -> PathBuf {
        self.dir.join("app")
    }
    fn crash_after(&self, n: u64) {
        self.fs.crash_after(n)
    }
    fn crashed(&self) -> bool {
        self.fs.has_crashed()
    }
    fn crash_now(&self) {
        self.fs.crash_after(0);
        let _ = self.fs.create_dir_all(&self.dir);
    }
    fn restart(&mut self) {
        self.fs = Arc::new(FaultFs::new(Arc::new(MacFs)));
    }
    fn all_files(&self) -> Vec<PathBuf> {
        let mut out = vec![];
        let mut stack = vec![self.root()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else {
                    out.push(p);
                }
            }
        }
        out
    }
}

impl Drop for Real {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn real() -> Real {
    Real { dir: temp_dir("crash"), fs: Arc::new(FaultFs::new(Arc::new(MacFs))) }
}

#[test]
fn process_crash_during_create() {
    crash::create_scenarios(&real);
}

#[test]
fn process_crash_during_save() {
    crash::save_scenarios(&real);
}

#[test]
fn process_crash_during_rename() {
    crash::rename_scenarios(&real);
}

// ---------------------------------------------------------------------------------------------

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
            subfolder_field: None,
        },
    )
    .unwrap();
    k
}

struct Live {
    dir: PathBuf,
    changes: Arc<Mutex<Vec<Change>>>,
}

impl Live {
    fn open(&self) -> Library {
        let lib = Library::open(
            &self.dir.join("lib"),
            &self.dir.join("app"),
            LibraryPorts {
                fs: Arc::new(MacFs),
                clock: Arc::new(librarium_system::SystemClock),
                ids: Arc::new(librarium_system::UuidV7),
                versions: Arc::new(librarium_versions_none::NoVersions),
                index: Arc::new(|p: &Path| Arc::new(SqliteIndex::new(p)) as Arc<dyn IndexEngine>),
                changes: Arc::new(FsEvents::new(0.05)) as Arc<dyn ChangeSource>,
            },
            kinds(),
            OpenOptions {
                tick: Duration::from_millis(200),
                replay_wait: Duration::from_secs(10),
                full_check_every_ms: i64::MAX,
            },
        )
        .unwrap();
        let c = self.changes.clone();
        lib.store.changes.subscribe(Arc::new(move |ch| c.lock().unwrap().push(ch.clone())));
        lib
    }
    fn wait_for(&self, f: impl Fn(&Change) -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if self.changes.lock().unwrap().iter().any(&f) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn outside_edits_on_a_real_folder() {
    let live = Live { dir: temp_dir("live"), changes: Arc::default() };
    let lib = live.open();
    assert_eq!(lib.startup.mode, "full");
    let (e, _) = lib.write(Lane::Interactive, |tx| tx.create("page", "Live", vec![], "one\n", None)).unwrap();
    let path = lib.root.join(&e.path);

    // An outside edit is seen live, and attributed to the outside.
    let text = std::fs::read_to_string(&path).unwrap().replace("one", "two");
    std::fs::write(&path, text).unwrap();
    assert!(
        live.wait_for(|c| c.id == e.id && c.origin == ChangeOrigin::Outside && c.op == ChangeOp::Updated),
        "{:?}",
        live.changes.lock().unwrap()
    );

    // An edit while closed is found by replay.
    lib.close();
    drop(lib);
    let text = std::fs::read_to_string(&path).unwrap().replace("two", "three");
    std::fs::write(&path, text).unwrap();
    let lib = live.open();
    assert_eq!(lib.startup.mode, "replay", "{:?}", lib.startup.reason);
    assert_eq!(lib.startup.check.updated, vec![e.id]);
    assert!(lib.store.read_text(e.id).unwrap().body.contains("three"));
    lib.close();
    drop(lib);

    // When replay is unavailable (another volume's state), a full check finds it.
    let changes = lib_app_dir(&live.dir).join("changes.json");
    let mut st: serde_json::Value = serde_json::from_slice(&std::fs::read(&changes).unwrap()).unwrap();
    st["volume_uuid"] = "SOME-OTHER-VOLUME".into();
    std::fs::write(&changes, serde_json::to_vec(&st).unwrap()).unwrap();
    let text = std::fs::read_to_string(&path).unwrap().replace("three", "four");
    std::fs::write(&path, text).unwrap();
    let lib = live.open();
    assert_eq!(lib.startup.mode, "full");
    assert_eq!(lib.startup.reason.as_deref(), Some("the library is on a different volume"));
    assert!(lib.store.read_text(e.id).unwrap().body.contains("four"));
}

#[test]
fn round_trip_on_a_real_folder_is_byte_exact() {
    let live = Live { dir: temp_dir("bytes"), changes: Arc::default() };
    let id = "0192f3a4-7c1e-7b2a-9f00-0000000000ee";
    let rel = format!("pages/{id}-x.md");
    let original = format!(
        "---\r\n# comment\r\nid: \"{id}\"\r\nkind: page\r\nother: [1, 2]   # keep\r\ntitle: X\r\n---\r\nBody\r\n"
    );
    std::fs::create_dir_all(live.dir.join("lib/pages")).unwrap();
    std::fs::write(live.dir.join("lib").join(&rel), &original).unwrap();
    let lib = live.open();
    let idv: librarium_contracts::Id = id.parse().unwrap();
    lib.write(Lane::Interactive, move |tx| {
        tx.set_fields(idv, None, &[("x.y".into(), Some(librarium_kernel::frontmatter::FmValue::Str("z".into())))])
    })
    .unwrap();
    let now = std::fs::read_to_string(live.dir.join("lib").join(&rel)).unwrap();
    assert_eq!(now, original.replace("title: X\r\n---", "title: X\r\nx.y: \"z\"\r\n---"));
}

fn lib_app_dir(dir: &Path) -> PathBuf {
    let libs = dir.join("app/libraries");
    std::fs::read_dir(&libs).unwrap().flatten().next().unwrap().path()
}
