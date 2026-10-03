//! Crash tests against the durability-modelling fake: a power cut at every step.
mod crash;

use crash::Rig;
use librarium_contracts::ports::FileSystem;
use librarium_testkit::memfs::MemFs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

struct Fake(Arc<MemFs>);

impl Rig for Fake {
    fn fs(&self) -> Arc<dyn FileSystem> {
        self.0.clone()
    }
    fn root(&self) -> PathBuf {
        PathBuf::from("/lib")
    }
    fn app(&self) -> PathBuf {
        PathBuf::from("/app")
    }
    fn crash_after(&self, n: u64) {
        self.0.crash_after(n)
    }
    fn crashed(&self) -> bool {
        self.0.has_crashed()
    }
    fn crash_now(&self) {
        self.0.crash_now()
    }
    fn restart(&mut self) {
        self.0.restart()
    }
    fn all_files(&self) -> Vec<PathBuf> {
        self.0.files().into_iter().filter(|p| p.starts_with("/lib")).collect()
    }
}

fn make() -> Fake {
    let fs = Arc::new(MemFs::new());
    fs.create_dir_all(Path::new("/lib")).unwrap();
    fs.flush_dir(Path::new("/"), librarium_contracts::ports::Flush::Full).unwrap();
    Fake(fs)
}

#[test]
fn power_cut_during_create() {
    crash::create_scenarios(&make);
}

#[test]
fn power_cut_during_save() {
    crash::save_scenarios(&make);
}

#[test]
fn power_cut_during_rename() {
    crash::rename_scenarios(&make);
}
