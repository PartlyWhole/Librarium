//! FileSystem port: the macOS file system.
//!
//! Full flushes use `F_FULLFSYNC` (Rust's `File::sync_all` on macOS); data flushes use plain
//! `fsync`. Exclusive renames use `renamex_np(…, RENAME_EXCL)`.

use librarium_contracts::ports::{DirEntry, FileMeta, FileSystem, Flush};
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::os::unix::io::AsRawFd;
use std::path::Path;

pub struct MacFs;

fn cpath(p: &Path) -> io::Result<CString> {
    CString::new(p.as_os_str().as_bytes()).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))
}

fn flush_fd(f: &File, how: Flush) -> io::Result<()> {
    match how {
        Flush::Full => full_fsync(f),
        Flush::Data => {
            // SAFETY: a valid open descriptor.
            if unsafe { libc::fsync(f.as_raw_fd()) } == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        }
    }
}

fn full_fsync(f: &File) -> io::Result<()> {
    // SAFETY: a valid open descriptor.
    if unsafe { libc::fcntl(f.as_raw_fd(), libc::F_FULLFSYNC) } == 0 {
        return Ok(());
    }
    // Some file systems (network, FAT) don't support F_FULLFSYNC: fall back to fsync.
    if unsafe { libc::fsync(f.as_raw_fd()) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn nanos(s: i64, ns: i64) -> i64 {
    s.saturating_mul(1_000_000_000).saturating_add(ns)
}

impl FileSystem for MacFs {
    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        fs::read(path)
    }

    fn stat(&self, path: &Path) -> io::Result<Option<FileMeta>> {
        match fs::symlink_metadata(path) {
            Ok(m) => Ok(Some(FileMeta {
                len: m.len(),
                mtime_ns: nanos(m.mtime(), m.mtime_nsec()),
                ctime_ns: nanos(m.ctime(), m.ctime_nsec()),
                inode: m.ino(),
                birth_ns: m
                    .created()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos() as i64),
                is_dir: m.is_dir(),
                writable: m.mode() & 0o200 != 0 && {
                    use std::os::macos::fs::MetadataExt as _;
                    m.st_flags() & (libc::UF_IMMUTABLE | libc::SF_IMMUTABLE) == 0
                },
            })),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn list(&self, dir: &Path) -> io::Result<Vec<DirEntry>> {
        let mut out = vec![];
        for e in fs::read_dir(dir)? {
            let e = e?;
            let Some(name) = e.file_name().to_str().map(str::to_string) else { continue };
            let is_dir = e.file_type()?.is_dir();
            out.push(DirEntry { name, is_dir });
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    fn create_dir_all(&self, path: &Path) -> io::Result<()> {
        fs::create_dir_all(path)
    }

    fn write_new(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        let mut f = OpenOptions::new().write(true).create_new(true).open(path)?;
        f.write_all(bytes)
    }

    fn flush_file(&self, path: &Path, how: Flush) -> io::Result<()> {
        let f = File::open(path)?;
        flush_fd(&f, how)
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        fs::rename(from, to)
    }

    fn rename_exclusive(&self, from: &Path, to: &Path) -> io::Result<()> {
        let (a, b) = (cpath(from)?, cpath(to)?);
        // SAFETY: two valid NUL-terminated paths.
        if unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_EXCL) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    fn flush_dir(&self, dir: &Path, how: Flush) -> io::Result<()> {
        let f = File::open(dir)?;
        flush_fd(&f, how)
    }

    fn barrier(&self, path: &Path) -> io::Result<()> {
        let f = File::open(path)?;
        full_fsync(&f)
    }

    fn remove_file(&self, path: &Path) -> io::Result<()> {
        fs::remove_file(path)
    }

    fn remove_dir(&self, path: &Path) -> io::Result<()> {
        fs::remove_dir(path)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn passes_the_shared_suite() {
        let base = std::env::temp_dir().join(format!("librarium-fs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        librarium_testkit::suites::filesystem::run(&super::MacFs, &base.join("suite"));
        std::fs::remove_dir_all(&base).unwrap();
    }
}
