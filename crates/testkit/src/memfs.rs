//! An in-memory FileSystem that models durability: unflushed writes are dropped on a
//! simulated crash.
//!
//! - File contents become durable on `flush_file(Full)`, or on `flush_file(Data)` followed by
//!   any full flush (`flush_file(Full)`, `flush_dir(Full)` or `barrier`).
//! - Folder entries (creations, renames, removals) become durable the same way through
//!   `flush_dir`. Like APFS's journal, a rename is one transaction: flushing either folder it
//!   touched makes both halves durable together.
//! - A crash reverts every folder to its durable entries and every file to its durable
//!   contents (empty if it was never flushed: a torn file).
//! - Folders themselves are durable once created.

use librarium_contracts::ports::{DirEntry, FileMeta, FileSystem, Flush};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{self, ErrorKind};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone)]
struct Node {
    volatile: Vec<u8>,
    durable: Option<Vec<u8>>,
    pending: Option<Vec<u8>>,
    /// (mtime, ctime) as of the durable contents.
    durable_times: (i64, i64),
    mtime: i64,
    ctime: i64,
    birth: i64,
}

#[derive(Debug, Clone, Default)]
struct Dir {
    volatile: BTreeMap<String, u64>,
    durable: BTreeMap<String, u64>,
}

/// An entry change not yet durable. Ops sharing a group commit together.
#[derive(Debug, Clone)]
struct DirOp {
    dir: PathBuf,
    name: String,
    ino: Option<u64>,
    group: u64,
    /// Data-flushed: becomes durable at the next full flush.
    pending: bool,
}

#[derive(Debug, Default)]
struct State {
    dirs: BTreeMap<PathBuf, Dir>,
    nodes: HashMap<u64, Node>,
    next_ino: u64,
    clock_ns: i64,
    ops: u64,
    crash_at: Option<u64>,
    crashed: bool,
    read_only: BTreeSet<PathBuf>,
    log: Vec<DirOp>,
    next_group: u64,
}

pub struct MemFs {
    s: Mutex<State>,
}

fn crashed() -> io::Error {
    io::Error::other("simulated crash")
}

fn norm(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

fn split(p: &Path) -> io::Result<(PathBuf, String)> {
    let p = norm(p);
    let name = p.file_name().ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "no file name"))?;
    Ok((p.parent().unwrap_or(Path::new("/")).to_path_buf(), name.to_string_lossy().to_string()))
}

impl Default for MemFs {
    fn default() -> Self {
        Self::new()
    }
}

impl MemFs {
    pub fn new() -> Self {
        let mut s = State { next_ino: 1, clock_ns: 1_790_932_440_000_000_000, ..Default::default() };
        s.dirs.insert(PathBuf::from("/"), Dir::default());
        MemFs { s: Mutex::new(s) }
    }

    /// The next `n` mutating operations succeed; the one after cuts the power.
    pub fn crash_after(&self, n: u64) {
        let mut s = self.s.lock().unwrap();
        s.crash_at = Some(s.ops + n);
    }

    /// Cuts the power now.
    pub fn crash_now(&self) {
        let mut s = self.s.lock().unwrap();
        Self::revert(&mut s);
        s.crashed = true;
    }

    pub fn has_crashed(&self) -> bool {
        self.s.lock().unwrap().crashed
    }

    /// Powers back on after a crash.
    pub fn restart(&self) {
        let mut s = self.s.lock().unwrap();
        s.crashed = false;
        s.crash_at = None;
    }

    /// Mutating operations performed so far.
    pub fn ops(&self) -> u64 {
        self.s.lock().unwrap().ops
    }

    /// Makes writes that would replace or remove `path` fail with PermissionDenied.
    pub fn set_read_only(&self, path: &Path, read_only: bool) {
        let mut s = self.s.lock().unwrap();
        if read_only {
            s.read_only.insert(norm(path));
        } else {
            s.read_only.remove(&norm(path));
        }
    }

    /// An outside program writes a file, durably, with its own timing.
    pub fn write_outside(&self, path: &Path, bytes: &[u8]) {
        let mut s = self.s.lock().unwrap();
        let (dir, name) = split(path).unwrap();
        Self::mkdirs(&mut s, &dir);
        s.clock_ns += 1_000_000;
        let now = s.clock_ns;
        let existing = s.dirs[&dir].volatile.get(&name).copied();
        let ino = match existing {
            Some(ino) => {
                let n = s.nodes.get_mut(&ino).unwrap();
                n.volatile = bytes.to_vec();
                n.durable = Some(bytes.to_vec());
                n.mtime = now;
                n.ctime = now;
                n.durable_times = (now, now);
                ino
            }
            None => {
                let ino = s.next_ino;
                s.next_ino += 1;
                s.nodes.insert(
                    ino,
                    Node {
                        volatile: bytes.to_vec(),
                        durable: Some(bytes.to_vec()),
                        pending: None,
                        durable_times: (now, now),
                        mtime: now,
                        ctime: now,
                        birth: now,
                    },
                );
                ino
            }
        };
        let d = s.dirs.get_mut(&dir).unwrap();
        d.volatile.insert(name.clone(), ino);
        d.durable.insert(name, ino);
    }

    /// An outside program removes a file.
    pub fn remove_outside(&self, path: &Path) {
        let mut s = self.s.lock().unwrap();
        let (dir, name) = split(path).unwrap();
        if let Some(d) = s.dirs.get_mut(&dir) {
            d.volatile.remove(&name);
            d.durable.remove(&name);
        }
    }

    /// Every file path, for assertions.
    pub fn files(&self) -> Vec<PathBuf> {
        let s = self.s.lock().unwrap();
        let mut out = vec![];
        for (dir, d) in &s.dirs {
            for name in d.volatile.keys() {
                out.push(dir.join(name));
            }
        }
        out.sort();
        out
    }

    fn revert(s: &mut State) {
        s.log.clear();
        for d in s.dirs.values_mut() {
            d.volatile = d.durable.clone();
        }
        for n in s.nodes.values_mut() {
            n.volatile = n.durable.clone().unwrap_or_default();
            n.pending = None;
            (n.mtime, n.ctime) = n.durable_times;
        }
    }

    /// Commits the logged entry ops selected by `pick` (and the rest of their groups), in order.
    fn commit(s: &mut State, pick: impl Fn(&DirOp) -> bool) {
        let groups: BTreeSet<u64> = s.log.iter().filter(|o| pick(o)).map(|o| o.group).collect();
        let (now, later): (Vec<DirOp>, Vec<DirOp>) =
            std::mem::take(&mut s.log).into_iter().partition(|o| groups.contains(&o.group));
        s.log = later;
        for o in now {
            if let Some(d) = s.dirs.get_mut(&o.dir) {
                match o.ino {
                    Some(i) => d.durable.insert(o.name, i),
                    None => d.durable.remove(&o.name),
                };
            }
        }
    }

    fn log_op(s: &mut State, dir: &Path, name: &str, ino: Option<u64>, group: u64) {
        s.log.push(DirOp { dir: dir.to_path_buf(), name: name.to_string(), ino, group, pending: false });
    }

    fn new_group(s: &mut State) -> u64 {
        s.next_group += 1;
        s.next_group
    }

    fn promote(s: &mut State) {
        Self::commit(s, |o| o.pending);
        for n in s.nodes.values_mut() {
            if let Some(p) = n.pending.take() {
                n.durable = Some(p);
                n.durable_times = (n.mtime, n.ctime);
            }
        }
    }

    fn mkdirs(s: &mut State, dir: &Path) {
        let mut cur = PathBuf::new();
        for c in dir.components() {
            cur.push(c);
            s.dirs.entry(cur.clone()).or_default();
        }
    }

    /// Counts a mutating op, cutting the power if it is the scheduled one.
    fn step(s: &mut State) -> io::Result<()> {
        if s.crashed {
            return Err(crashed());
        }
        if s.crash_at.is_some_and(|at| s.ops >= at) {
            Self::revert(s);
            s.crashed = true;
            return Err(crashed());
        }
        s.ops += 1;
        s.clock_ns += 1_000_000;
        Ok(())
    }

    fn lookup(s: &State, p: &Path) -> Option<u64> {
        let (dir, name) = split(p).ok()?;
        s.dirs.get(&dir)?.volatile.get(&name).copied()
    }

    fn check_writable(s: &State, p: &Path) -> io::Result<()> {
        if s.read_only.contains(&norm(p)) {
            return Err(io::Error::new(ErrorKind::PermissionDenied, "read-only file"));
        }
        Ok(())
    }
}

impl FileSystem for MemFs {
    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        let s = self.s.lock().unwrap();
        if s.crashed {
            return Err(crashed());
        }
        let ino =
            Self::lookup(&s, path).ok_or_else(|| io::Error::new(ErrorKind::NotFound, format!("{}", path.display())))?;
        Ok(s.nodes[&ino].volatile.clone())
    }

    fn stat(&self, path: &Path) -> io::Result<Option<FileMeta>> {
        let s = self.s.lock().unwrap();
        if s.crashed {
            return Err(crashed());
        }
        if s.dirs.contains_key(&norm(path)) {
            return Ok(Some(FileMeta { len: 0, mtime_ns: 0, ctime_ns: 0, inode: 0, birth_ns: None, is_dir: true }));
        }
        Ok(Self::lookup(&s, path).map(|ino| {
            let n = &s.nodes[&ino];
            FileMeta {
                len: n.volatile.len() as u64,
                mtime_ns: n.mtime,
                ctime_ns: n.ctime,
                inode: ino,
                birth_ns: Some(n.birth),
                is_dir: false,
            }
        }))
    }

    fn list(&self, dir: &Path) -> io::Result<Vec<DirEntry>> {
        let s = self.s.lock().unwrap();
        if s.crashed {
            return Err(crashed());
        }
        let dir = norm(dir);
        let d = s.dirs.get(&dir).ok_or_else(|| io::Error::new(ErrorKind::NotFound, format!("{}", dir.display())))?;
        let mut out: Vec<DirEntry> = d.volatile.keys().map(|n| DirEntry { name: n.clone(), is_dir: false }).collect();
        for p in s.dirs.keys() {
            if p.parent() == Some(dir.as_path()) && p != &dir {
                out.push(DirEntry { name: p.file_name().unwrap().to_string_lossy().to_string(), is_dir: true });
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    fn create_dir_all(&self, path: &Path) -> io::Result<()> {
        let mut s = self.s.lock().unwrap();
        Self::step(&mut s)?;
        Self::mkdirs(&mut s, &norm(path));
        Ok(())
    }

    fn write_new(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        let mut s = self.s.lock().unwrap();
        Self::step(&mut s)?;
        let (dir, name) = split(path)?;
        if !s.dirs.contains_key(&dir) {
            return Err(io::Error::new(ErrorKind::NotFound, format!("no folder {}", dir.display())));
        }
        if s.dirs[&dir].volatile.contains_key(&name) || s.dirs.contains_key(&norm(path)) {
            return Err(io::Error::new(ErrorKind::AlreadyExists, format!("{}", path.display())));
        }
        let ino = s.next_ino;
        s.next_ino += 1;
        let now = s.clock_ns;
        s.nodes.insert(
            ino,
            Node {
                volatile: bytes.to_vec(),
                durable: None,
                pending: None,
                durable_times: (now, now),
                mtime: now,
                ctime: now,
                birth: now,
            },
        );
        s.dirs.get_mut(&dir).unwrap().volatile.insert(name.clone(), ino);
        let g = Self::new_group(&mut s);
        Self::log_op(&mut s, &dir, &name, Some(ino), g);
        Ok(())
    }

    fn flush_file(&self, path: &Path, how: Flush) -> io::Result<()> {
        let mut s = self.s.lock().unwrap();
        Self::step(&mut s)?;
        let ino =
            Self::lookup(&s, path).ok_or_else(|| io::Error::new(ErrorKind::NotFound, format!("{}", path.display())))?;
        let n = s.nodes.get_mut(&ino).unwrap();
        match how {
            Flush::Data => n.pending = Some(n.volatile.clone()),
            Flush::Full => {
                n.durable = Some(n.volatile.clone());
                n.durable_times = (n.mtime, n.ctime);
                n.pending = None;
                Self::promote(&mut s);
            }
        }
        Ok(())
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        let mut s = self.s.lock().unwrap();
        Self::step(&mut s)?;
        Self::check_writable(&s, to)?;
        let (fd, fname) = split(from)?;
        let (td, tname) = split(to)?;
        if !s.dirs.contains_key(&td) {
            return Err(io::Error::new(ErrorKind::NotFound, format!("no folder {}", td.display())));
        }
        let ino = s
            .dirs
            .get_mut(&fd)
            .and_then(|d| d.volatile.remove(&fname))
            .ok_or_else(|| io::Error::new(ErrorKind::NotFound, format!("{}", from.display())))?;
        s.dirs.get_mut(&td).unwrap().volatile.insert(tname.clone(), ino);
        let g = Self::new_group(&mut s);
        Self::log_op(&mut s, &fd, &fname, None, g);
        Self::log_op(&mut s, &td, &tname, Some(ino), g);
        let now = s.clock_ns;
        s.nodes.get_mut(&ino).unwrap().ctime = now;
        Ok(())
    }

    fn rename_exclusive(&self, from: &Path, to: &Path) -> io::Result<()> {
        {
            let s = self.s.lock().unwrap();
            if Self::lookup(&s, to).is_some() || s.dirs.contains_key(&norm(to)) {
                drop(s);
                let mut s = self.s.lock().unwrap();
                Self::step(&mut s)?;
                return Err(io::Error::new(ErrorKind::AlreadyExists, format!("{}", to.display())));
            }
        }
        self.rename(from, to)
    }

    fn flush_dir(&self, dir: &Path, how: Flush) -> io::Result<()> {
        let mut s = self.s.lock().unwrap();
        Self::step(&mut s)?;
        let dir = norm(dir);
        if !s.dirs.contains_key(&dir) {
            return Err(io::Error::new(ErrorKind::NotFound, format!("{}", dir.display())));
        }
        match how {
            Flush::Data => {
                for o in s.log.iter_mut().filter(|o| o.dir == dir) {
                    o.pending = true;
                }
            }
            Flush::Full => {
                Self::commit(&mut s, |o| o.dir == dir);
                Self::promote(&mut s);
            }
        }
        Ok(())
    }

    fn barrier(&self, _path: &Path) -> io::Result<()> {
        let mut s = self.s.lock().unwrap();
        Self::step(&mut s)?;
        Self::promote(&mut s);
        Ok(())
    }

    fn remove_file(&self, path: &Path) -> io::Result<()> {
        let mut s = self.s.lock().unwrap();
        Self::step(&mut s)?;
        Self::check_writable(&s, path)?;
        let (dir, name) = split(path)?;
        s.dirs
            .get_mut(&dir)
            .and_then(|d| d.volatile.remove(&name))
            .ok_or_else(|| io::Error::new(ErrorKind::NotFound, format!("{}", path.display())))?;
        let g = Self::new_group(&mut s);
        Self::log_op(&mut s, &dir, &name, None, g);
        Ok(())
    }

    fn remove_dir(&self, path: &Path) -> io::Result<()> {
        let mut s = self.s.lock().unwrap();
        Self::step(&mut s)?;
        let p = norm(path);
        let empty = s.dirs.get(&p).is_some_and(|d| d.volatile.is_empty())
            && !s.dirs.keys().any(|k| k.parent() == Some(p.as_path()));
        if !empty {
            return Err(io::Error::new(ErrorKind::DirectoryNotEmpty, format!("{}", p.display())));
        }
        s.dirs.remove(&p);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_the_shared_suite() {
        let fs = MemFs::new();
        crate::suites::filesystem::run(&fs, Path::new("/suite"));
    }

    #[test]
    fn unflushed_writes_are_lost_on_crash() {
        let fs = MemFs::new();
        let d = Path::new("/d");
        fs.create_dir_all(d).unwrap();
        fs.write_new(&d.join("a"), b"one").unwrap();
        fs.crash_now();
        fs.restart();
        assert!(fs.stat(&d.join("a")).unwrap().is_none(), "entry was never flushed");

        fs.write_new(&d.join("b"), b"two").unwrap();
        fs.flush_dir(d, Flush::Full).unwrap();
        fs.crash_now();
        fs.restart();
        assert_eq!(fs.read(&d.join("b")).unwrap(), b"", "entry durable, contents torn");

        fs.write_new(&d.join("c"), b"three").unwrap();
        fs.flush_file(&d.join("c"), Flush::Data).unwrap();
        fs.flush_dir(d, Flush::Data).unwrap();
        fs.barrier(d).unwrap();
        fs.crash_now();
        fs.restart();
        assert_eq!(fs.read(&d.join("c")).unwrap(), b"three", "a barrier makes data flushes durable");
    }

    #[test]
    fn crash_after_n_ops() {
        let fs = MemFs::new();
        fs.create_dir_all(Path::new("/d")).unwrap();
        fs.crash_after(1);
        fs.write_new(Path::new("/d/a"), b"x").unwrap();
        assert!(fs.write_new(Path::new("/d/b"), b"x").is_err());
        assert!(fs.has_crashed());
        assert!(fs.read(Path::new("/d/a")).is_err());
        fs.restart();
        assert!(fs.stat(Path::new("/d/a")).unwrap().is_none());
    }
}
