//! ChangeSource port: FSEvents, used directly so past events can be replayed by event ID
//! (the `notify` crate cannot replay).
//!
//! - `start(since)` replays every event after `since.event_id` (when the volume's UUID still
//!   matches), then sends `history_done`.
//! - Dropped or merged events (`MustScanSubDirs`, `UserDropped`, `KernelDropped`,
//!   `EventIdsWrapped`, `RootChanged`) set `rescan`.
//! - FSEvents reports real paths (`/private/var/…`); they are mapped back to the root as given.

#![allow(non_upper_case_globals, non_camel_case_types)]

use librarium_contracts::ports::{ChangeBatch, ChangeSink, ChangeSource, ReplayState, StartOutcome};
use librarium_contracts::{BackendError, Result};
use std::ffi::{c_char, c_void, CStr, CString};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

type CFTypeRef = *const c_void;
type CFAllocatorRef = *const c_void;
type CFArrayRef = *const c_void;
type CFStringRef = *const c_void;
type CFUUIDRef = *const c_void;
type FSEventStreamRef = *mut c_void;
type dispatch_queue_t = *mut c_void;

#[repr(C)]
struct CFArrayCallBacks {
    version: isize,
    retain: *const c_void,
    release: *const c_void,
    copy_description: *const c_void,
    equal: *const c_void,
}

#[repr(C)]
struct FSEventStreamContext {
    version: isize,
    info: *mut c_void,
    retain: *const c_void,
    release: *const c_void,
    copy_description: *const c_void,
}

type Callback = extern "C" fn(FSEventStreamRef, *mut c_void, usize, *mut c_void, *const u32, *const u64);

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFTypeArrayCallBacks: CFArrayCallBacks;
    fn CFArrayCreate(
        alloc: CFAllocatorRef,
        values: *const CFTypeRef,
        n: isize,
        cb: *const CFArrayCallBacks,
    ) -> CFArrayRef;
    fn CFStringCreateWithCString(alloc: CFAllocatorRef, s: *const c_char, encoding: u32) -> CFStringRef;
    fn CFStringGetCString(s: CFStringRef, buf: *mut c_char, size: isize, encoding: u32) -> u8;
    fn CFUUIDCreateString(alloc: CFAllocatorRef, uuid: CFUUIDRef) -> CFStringRef;
    fn CFRelease(o: CFTypeRef);
}

#[link(name = "CoreServices", kind = "framework")]
extern "C" {
    fn FSEventStreamCreate(
        alloc: CFAllocatorRef,
        cb: Callback,
        ctx: *const FSEventStreamContext,
        paths: CFArrayRef,
        since: u64,
        latency: f64,
        flags: u32,
    ) -> FSEventStreamRef;
    fn FSEventStreamSetDispatchQueue(s: FSEventStreamRef, q: dispatch_queue_t);
    fn FSEventStreamStart(s: FSEventStreamRef) -> u8;
    fn FSEventStreamFlushSync(s: FSEventStreamRef);
    fn FSEventStreamStop(s: FSEventStreamRef);
    fn FSEventStreamInvalidate(s: FSEventStreamRef);
    fn FSEventStreamRelease(s: FSEventStreamRef);
    fn FSEventsGetCurrentEventId() -> u64;
    fn FSEventsCopyUUIDForDevice(dev: libc::dev_t) -> CFUUIDRef;
}

extern "C" {
    fn dispatch_queue_create(label: *const c_char, attr: *const c_void) -> dispatch_queue_t;
    fn dispatch_release(o: *mut c_void);
}

const kCFStringEncodingUTF8: u32 = 0x0800_0100;
const kFSEventStreamEventIdSinceNow: u64 = 0xFFFF_FFFF_FFFF_FFFF;
const kFSEventStreamCreateFlagNoDefer: u32 = 0x02;
const kFSEventStreamCreateFlagWatchRoot: u32 = 0x04;
const kFSEventStreamCreateFlagFileEvents: u32 = 0x10;

const kFSEventStreamEventFlagMustScanSubDirs: u32 = 0x01;
const kFSEventStreamEventFlagUserDropped: u32 = 0x02;
const kFSEventStreamEventFlagKernelDropped: u32 = 0x04;
const kFSEventStreamEventFlagEventIdsWrapped: u32 = 0x08;
const kFSEventStreamEventFlagHistoryDone: u32 = 0x10;
const kFSEventStreamEventFlagRootChanged: u32 = 0x20;
const RESCAN: u32 = kFSEventStreamEventFlagMustScanSubDirs
    | kFSEventStreamEventFlagUserDropped
    | kFSEventStreamEventFlagKernelDropped
    | kFSEventStreamEventFlagEventIdsWrapped
    | kFSEventStreamEventFlagRootChanged;

struct Shared {
    sink: ChangeSink,
    /// (canonical root, root as given)
    real_root: PathBuf,
    root: PathBuf,
    volume: String,
}

struct Running {
    stream: FSEventStreamRef,
    queue: dispatch_queue_t,
    shared: *mut Shared,
}

// The stream and queue are used only under the mutex.
unsafe impl Send for Running {}

pub struct FsEvents {
    running: Mutex<Option<Running>>,
    /// Seconds FSEvents may coalesce events for.
    latency: f64,
}

impl Default for FsEvents {
    fn default() -> Self {
        Self::new(0.3)
    }
}

impl FsEvents {
    pub fn new(latency: f64) -> Self {
        FsEvents { running: Mutex::new(None), latency }
    }
}

fn cfstring_to_string(s: CFStringRef) -> String {
    let mut buf = vec![0 as c_char; 128];
    // SAFETY: buf is writable for its length.
    let ok = unsafe { CFStringGetCString(s, buf.as_mut_ptr(), buf.len() as isize, kCFStringEncodingUTF8) };
    if ok == 0 {
        return String::new();
    }
    // SAFETY: CFStringGetCString wrote a NUL-terminated string.
    unsafe { CStr::from_ptr(buf.as_ptr()) }.to_string_lossy().into_owned()
}

/// The UUID of the volume holding `path` (FSEvents keeps one event database per volume).
pub fn volume_uuid(path: &Path) -> Option<String> {
    let c = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: valid path and out-pointer.
    if unsafe { libc::stat(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    // SAFETY: FFI; the returned objects are released below.
    unsafe {
        let uuid = FSEventsCopyUUIDForDevice(st.st_dev);
        if uuid.is_null() {
            return None;
        }
        let s = CFUUIDCreateString(std::ptr::null(), uuid);
        CFRelease(uuid);
        let out = cfstring_to_string(s);
        CFRelease(s);
        Some(out)
    }
}

extern "C" fn callback(
    _s: FSEventStreamRef,
    info: *mut c_void,
    n: usize,
    paths: *mut c_void,
    flags: *const u32,
    ids: *const u64,
) {
    // SAFETY: FSEvents passes the context we created, and arrays of length n.
    let shared = unsafe { &*(info as *const Shared) };
    let paths = paths as *const *const c_char;
    let mut out = vec![];
    let (mut rescan, mut done, mut last) = (false, false, 0u64);
    for i in 0..n {
        let (f, id) = unsafe { (*flags.add(i), *ids.add(i)) };
        let p = unsafe { CStr::from_ptr(*paths.add(i)) }.to_string_lossy().into_owned();
        if f & kFSEventStreamEventFlagHistoryDone != 0 {
            done = true;
            continue;
        }
        if f & RESCAN != 0 {
            rescan = true;
        }
        last = last.max(id);
        let p = PathBuf::from(p);
        let mapped = match p.strip_prefix(&shared.real_root) {
            Ok(rest) => shared.root.join(rest),
            Err(_) => p,
        };
        out.push(mapped);
    }
    let event_id = if last > 0 { last } else { unsafe { FSEventsGetCurrentEventId() } };
    (shared.sink)(ChangeBatch {
        paths: out,
        rescan,
        history_done: done,
        state: ReplayState { event_id, volume_uuid: shared.volume.clone() },
    });
}

impl ChangeSource for FsEvents {
    fn start(&self, root: &Path, since: Option<ReplayState>, sink: ChangeSink) -> Result<StartOutcome> {
        self.stop();
        let real_root =
            std::fs::canonicalize(root).map_err(|e| BackendError::io(format!("watching {}: {e}", root.display())))?;
        let volume = volume_uuid(&real_root).unwrap_or_default();
        let (since_id, outcome) = match since {
            None => (kFSEventStreamEventIdSinceNow, StartOutcome::Unavailable("no saved event ID".into())),
            Some(s) if volume.is_empty() => (
                kFSEventStreamEventIdSinceNow,
                StartOutcome::Unavailable(format!("the volume has no event history ({})", s.volume_uuid)),
            ),
            Some(s) if s.volume_uuid != volume => (
                kFSEventStreamEventIdSinceNow,
                StartOutcome::Unavailable("the library is on a different volume".into()),
            ),
            Some(s) if s.event_id > unsafe { FSEventsGetCurrentEventId() } => {
                (kFSEventStreamEventIdSinceNow, StartOutcome::Unavailable("event IDs went backwards".into()))
            }
            Some(s) => (s.event_id, StartOutcome::Replaying),
        };
        let shared =
            Box::into_raw(Box::new(Shared { sink, real_root: real_root.clone(), root: root.to_path_buf(), volume }));
        let ctx = FSEventStreamContext {
            version: 0,
            info: shared as *mut c_void,
            retain: std::ptr::null(),
            release: std::ptr::null(),
            copy_description: std::ptr::null(),
        };
        let cpath =
            CString::new(real_root.as_os_str().as_bytes()).map_err(|_| BackendError::invalid("path contains NUL"))?;
        // SAFETY: FFI calls with valid arguments; ownership of every object is tracked in Running.
        unsafe {
            let s = CFStringCreateWithCString(std::ptr::null(), cpath.as_ptr(), kCFStringEncodingUTF8);
            let arr = CFArrayCreate(
                std::ptr::null(),
                &s as *const CFStringRef as *const CFTypeRef,
                1,
                &kCFTypeArrayCallBacks,
            );
            CFRelease(s);
            let flags = kFSEventStreamCreateFlagNoDefer
                | kFSEventStreamCreateFlagWatchRoot
                | kFSEventStreamCreateFlagFileEvents;
            let stream = FSEventStreamCreate(std::ptr::null(), callback, &ctx, arr, since_id, self.latency, flags);
            CFRelease(arr);
            if stream.is_null() {
                drop(Box::from_raw(shared));
                return Err(BackendError::io("FSEventStreamCreate failed"));
            }
            let label = CString::new("librarium.fsevents").unwrap();
            let queue = dispatch_queue_create(label.as_ptr(), std::ptr::null());
            FSEventStreamSetDispatchQueue(stream, queue);
            if FSEventStreamStart(stream) == 0 {
                FSEventStreamInvalidate(stream);
                FSEventStreamRelease(stream);
                dispatch_release(queue);
                drop(Box::from_raw(shared));
                return Err(BackendError::io("FSEventStreamStart failed"));
            }
            *self.running.lock().unwrap() = Some(Running { stream, queue, shared });
        }
        Ok(outcome)
    }

    fn stop(&self) {
        if let Some(r) = self.running.lock().unwrap().take() {
            // SAFETY: the stream was started by us; after Invalidate no callback runs, so the
            // shared context can be freed.
            unsafe {
                FSEventStreamFlushSync(r.stream);
                FSEventStreamStop(r.stream);
                FSEventStreamInvalidate(r.stream);
                FSEventStreamRelease(r.stream);
                dispatch_release(r.queue);
                drop(Box::from_raw(r.shared));
            }
        }
    }

    fn current(&self, root: &Path) -> Result<ReplayState> {
        let real = std::fs::canonicalize(root).map_err(|e| BackendError::io(e.to_string()))?;
        Ok(ReplayState {
            event_id: unsafe { FSEventsGetCurrentEventId() },
            volume_uuid: volume_uuid(&real).unwrap_or_default(),
        })
    }
}

impl Drop for FsEvents {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn passes_the_shared_suite() {
        let base = std::env::temp_dir().join(format!("librarium-fsevents-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let src = super::FsEvents::new(0.05);
        librarium_testkit::suites::changes::run(&src, &base, &|p| {
            std::fs::write(p, format!("{:?}", std::time::Instant::now())).unwrap();
        });
        drop(src);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn knows_the_volume() {
        assert!(!super::volume_uuid(std::path::Path::new("/")).unwrap_or_default().is_empty());
    }
}
