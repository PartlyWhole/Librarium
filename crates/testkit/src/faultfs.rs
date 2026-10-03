//! Wraps any FileSystem (usually the real one) to model a process crash: after `n` mutating
//! operations every operation fails, leaving the folder exactly as far as it got.

use librarium_contracts::ports::{DirEntry, FileMeta, FileSystem, Flush};
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

pub struct FaultFs {
    inner: Arc<dyn FileSystem>,
    ops: AtomicU64,
    limit: AtomicU64,
    dead: AtomicBool,
}

impl FaultFs {
    pub fn new(inner: Arc<dyn FileSystem>) -> Self {
        FaultFs { inner, ops: AtomicU64::new(0), limit: AtomicU64::new(u64::MAX), dead: AtomicBool::new(false) }
    }
    pub fn crash_after(&self, n: u64) {
        self.limit.store(self.ops.load(Ordering::SeqCst) + n, Ordering::SeqCst);
    }
    pub fn has_crashed(&self) -> bool {
        self.dead.load(Ordering::SeqCst)
    }
    pub fn ops(&self) -> u64 {
        self.ops.load(Ordering::SeqCst)
    }
    fn step(&self) -> io::Result<()> {
        if self.dead.load(Ordering::SeqCst) {
            return Err(io::Error::other("simulated process crash"));
        }
        if self.ops.load(Ordering::SeqCst) >= self.limit.load(Ordering::SeqCst) {
            self.dead.store(true, Ordering::SeqCst);
            return Err(io::Error::other("simulated process crash"));
        }
        self.ops.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn alive(&self) -> io::Result<()> {
        if self.dead.load(Ordering::SeqCst) {
            Err(io::Error::other("simulated process crash"))
        } else {
            Ok(())
        }
    }
}

impl FileSystem for FaultFs {
    fn read(&self, p: &Path) -> io::Result<Vec<u8>> {
        self.alive()?;
        self.inner.read(p)
    }
    fn stat(&self, p: &Path) -> io::Result<Option<FileMeta>> {
        self.alive()?;
        self.inner.stat(p)
    }
    fn list(&self, p: &Path) -> io::Result<Vec<DirEntry>> {
        self.alive()?;
        self.inner.list(p)
    }
    fn create_dir_all(&self, p: &Path) -> io::Result<()> {
        self.step()?;
        self.inner.create_dir_all(p)
    }
    fn write_new(&self, p: &Path, b: &[u8]) -> io::Result<()> {
        self.step()?;
        self.inner.write_new(p, b)
    }
    fn flush_file(&self, p: &Path, h: Flush) -> io::Result<()> {
        self.step()?;
        self.inner.flush_file(p, h)
    }
    fn rename(&self, a: &Path, b: &Path) -> io::Result<()> {
        self.step()?;
        self.inner.rename(a, b)
    }
    fn rename_exclusive(&self, a: &Path, b: &Path) -> io::Result<()> {
        self.step()?;
        self.inner.rename_exclusive(a, b)
    }
    fn flush_dir(&self, p: &Path, h: Flush) -> io::Result<()> {
        self.step()?;
        self.inner.flush_dir(p, h)
    }
    fn barrier(&self, p: &Path) -> io::Result<()> {
        self.step()?;
        self.inner.barrier(p)
    }
    fn remove_file(&self, p: &Path) -> io::Result<()> {
        self.step()?;
        self.inner.remove_file(p)
    }
    fn remove_dir(&self, p: &Path) -> io::Result<()> {
        self.step()?;
        self.inner.remove_dir(p)
    }
}
