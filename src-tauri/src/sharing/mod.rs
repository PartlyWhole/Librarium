//! Sharing: the connection to the sync server named by the `sync.server` setting, and the
//! shared boards that travel over it. While the setting is empty there is no connection, so
//! Librarium dials nowhere until someone gives it an address. Each open library has a samod
//! repo (automerge-repo's protocol) keeping its shared documents in its app data
//! (`libraries/<id>/sharing/`); the connection is that repo's, retried with backoff while the
//! server can't be reached, and its state goes out as `sharing.status` events.

pub mod boards;
pub mod folder;

use crate::error::{Error, Result};
use crate::store::{Emit, Library};
use crate::types::SharingStatus;
use futures::StreamExt;
use samod::storage::TokioFilesystemStorage;
use samod::{BackoffConfig, DialerEvent, DialerHandle, Repo};
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use url::{Host, Url};

/// The settings key holding the sync server's address.
pub const SERVER: &str = "sync.server";
/// The settings key holding the name colleagues see.
pub const NAME: &str = "sharing.name";

/// Runs a future to its end from ordinary code, on any thread: a blocking one, or one driving
/// async work (quitting is answered on one), which `block_in_place` hands over first.
pub(crate) fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::task::block_in_place(|| tauri::async_runtime::handle().block_on(f))
}

/// The open library's repo, its shared boards, and the dialer while a server is set.
struct Open {
    repo: Repo,
    boards: Arc<boards::Boards>,
    dialer: Option<DialerHandle>,
}

pub struct Sharing {
    emit: Emit,
    /// The shared folder's Syncthing.
    pub folder: folder::Folder,
    state: Arc<Mutex<SharingStatus>>,
    server: Mutex<Option<String>>,
    open: Mutex<Option<Open>>,
    /// Bumped on every change of address or library, so an old connection's events are ignored.
    generation: Arc<AtomicU64>,
}

/// The WebSocket address for what was typed: `https://` becomes `wss://`, and a bare name gets
/// `wss://`. An unencrypted address is accepted only on a private network.
pub fn ws_url(address: &str) -> Result<Url> {
    let a = address.trim();
    let with_scheme = if a.contains("://") { a.to_string() } else { format!("wss://{a}") };
    let mut url = Url::parse(&with_scheme).map_err(|_| Error::invalid("That isn’t a server address. It looks like https://name.example.ts.net:8443."))?;
    let scheme = match url.scheme() {
        "https" | "wss" => "wss",
        "http" | "ws" => "ws",
        _ => return Err(Error::invalid("The address should start with https:// or wss://.")),
    };
    url.set_scheme(scheme).map_err(|_| Error::invalid("That isn’t a server address."))?;
    if url.host().is_none() {
        return Err(Error::invalid("The address needs a server name."));
    }
    if scheme == "ws" && !is_private(&url) {
        return Err(Error::invalid("An unencrypted address (http:// or ws://) only works on a private network. Use https://."));
    }
    Ok(url)
}

/// Whether the address is on a private network: a Tailscale name or address, a local network
/// address, or this Mac.
pub fn is_private(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(d)) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            d.ends_with(".ts.net") || d == "localhost" || d.ends_with(".local")
        }
        Some(Host::Ipv4(ip)) => {
            let o = ip.octets();
            // 100.64.0.0/10 is Tailscale's (shared address space).
            ip.is_private() || ip.is_loopback() || ip.is_link_local() || (o[0] == 100 && (64..128).contains(&o[1]))
        }
        Some(Host::Ipv6(ip)) => {
            let s = ip.segments();
            // fc00::/7 holds Tailscale's fd7a:115c:a1e0::/48.
            IpAddr::V6(ip).is_loopback() || (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80
        }
        None => false,
    }
}

impl Sharing {
    pub fn new(emit: Emit, app_data: &std::path::Path, logs: &std::path::Path) -> Sharing {
        Sharing {
            folder: folder::Folder::new(app_data, logs, emit.clone()),
            emit,
            state: Arc::new(Mutex::new(SharingStatus { state: "off".into(), server: None, private: false, error: None })),
            server: Mutex::new(None),
            open: Mutex::new(None),
            generation: Arc::default(),
        }
    }

    pub fn status(&self) -> SharingStatus {
        self.state.lock().unwrap().clone()
    }

    /// The open library's shared boards.
    pub fn boards(&self) -> Result<Arc<boards::Boards>> {
        self.open.lock().unwrap().as_ref().map(|o| o.boards.clone()).ok_or_else(|| Error::invalid("No library is open."))
    }

    /// Starts sharing for a library that has just opened: its repo, its shared boards, the
    /// connection if a server is set, and the shared folder if a join code is.
    pub fn open_library(&self, lib: Arc<Library>, join: Option<folder::Join>, name: Option<String>) {
        self.close_library();
        let dir = lib.app_dir.join("sharing");
        let repo = block_on(async move { Repo::build_tokio().with_storage(TokioFilesystemStorage::new(dir)).load().await });
        let boards = boards::Boards::new(lib.clone(), repo.clone(), self.emit.clone());
        *self.open.lock().unwrap() = Some(Open { repo, boards: boards.clone(), dialer: None });
        let server = self.server.lock().unwrap().clone();
        self.connect(server.as_deref());
        boards.follow_all();
        if let Some(j) = join {
            self.folder.start(&lib, &j, name);
        }
    }

    /// Stops sharing for the library that is closing.
    pub fn close_library(&self) {
        self.folder.stop();
        if let Some(o) = self.open.lock().unwrap().take() {
            if let Some(d) = o.dialer {
                d.close();
            }
            o.boards.stop();
            tauri::async_runtime::spawn(async move { o.repo.stop().await });
        }
    }

    /// Connects to `server` (a checked address), or to nothing; any earlier connection stops.
    /// With no library open, it connects when one opens.
    pub fn connect(&self, server: Option<&str>) -> SharingStatus {
        *self.server.lock().unwrap() = server.map(str::to_string);
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let set = setter(self.emit.clone(), self.state.clone(), self.generation.clone(), generation);
        let mut open = self.open.lock().unwrap();
        if let Some(d) = open.as_mut().and_then(|o| o.dialer.take()) {
            d.close();
        }
        let Some(url) = server.and_then(|s| ws_url(s).ok()) else {
            return set("off", None, false, None);
        };
        let first = set("connecting", server.map(str::to_string), is_private(&url), None);
        let Some(o) = open.as_mut() else { return first };
        let Ok(dialer) = o.repo.dial_websocket(url, BackoffConfig::default()) else { return first };
        o.dialer = Some(dialer.clone());
        let (server, private) = (first.server.clone(), first.private);
        tauri::async_runtime::spawn(async move {
            let mut events = dialer.events();
            while let Some(event) = events.next().await {
                let s = server.clone();
                match event {
                    DialerEvent::Connected { .. } => set("connected", s, private, None),
                    DialerEvent::Disconnected { .. } => set("offline", s, private, Some("The connection to the server was lost. Trying again…".into())),
                    // Each retry after a failed attempt: the server can't be reached yet.
                    DialerEvent::Reconnecting { .. } => set("offline", s, private, Some("Can’t reach the server. Trying again…".into())),
                    DialerEvent::MaxRetriesReached | DialerEvent::PermanentFailure => {
                        set("offline", s, private, Some("Can’t reach the server.".into()));
                        break;
                    }
                };
            }
        });
        first
    }
}

/// Sets and announces the status, unless a newer connection has replaced this one.
fn setter(
    emit: Emit,
    state: Arc<Mutex<SharingStatus>>,
    current: Arc<AtomicU64>,
    generation: u64,
) -> impl Fn(&str, Option<String>, bool, Option<String>) -> SharingStatus + Send + 'static {
    move |s, server, private, error| {
        let status = SharingStatus { state: s.into(), server, private, error };
        if current.load(Ordering::SeqCst) == generation {
            *state.lock().unwrap() = status.clone();
            emit("sharing.status", serde_json::to_value(&status).unwrap_or_default());
        }
        status
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_on_from_any_thread() {
        // A thread driving async work (Quit is answered on one), and a plain thread (start-up).
        let on_worker = tauri::async_runtime::block_on(async { tauri::async_runtime::spawn(async { block_on(async { 1 }) }).await.unwrap() });
        let on_thread = std::thread::spawn(|| block_on(async { 2 })).join().unwrap();
        assert_eq!((on_worker, on_thread), (1, 2));
    }

    #[test]
    fn addresses() {
        assert_eq!(ws_url("https://relay-1.tailb670a6.ts.net:8443").unwrap().as_str(), "wss://relay-1.tailb670a6.ts.net:8443/");
        assert_eq!(ws_url(" relay-1.tailb670a6.ts.net:8443 ").unwrap().as_str(), "wss://relay-1.tailb670a6.ts.net:8443/");
        assert_eq!(ws_url("http://100.72.227.116:3031").unwrap().scheme(), "ws");
        assert!(ws_url("http://sync.example.org").is_err());
        assert!(ws_url("ftp://x").is_err());
        let private = |a: &str| is_private(&ws_url(a).unwrap());
        assert!(private("https://relay-1.tailb670a6.ts.net:8443"));
        assert!(private("https://100.72.227.116"));
        assert!(private("https://192.168.1.10"));
        assert!(private("https://[fd7a:115c:a1e0::df2e:e375]"));
        assert!(!private("https://sync.partlywhole.org"));
        assert!(!private("https://100.128.0.1"));
    }
}
