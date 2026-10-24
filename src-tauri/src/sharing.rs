//! Sharing: the connection to the sync server named by the `sync.server` setting. While it is
//! empty there is none, so Librarium dials nowhere until someone gives it an address. The
//! connection is samod's (automerge-repo's protocol), retried with backoff while the server
//! can't be reached; its state goes out as `sharing.status` events. Nothing is shared over it
//! yet.

use crate::error::{Error, Result};
use crate::store::Emit;
use crate::types::SharingStatus;
use futures::StreamExt;
use samod::{BackoffConfig, DialerEvent, DialerHandle, Repo};
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use url::{Host, Url};

/// The settings key holding the sync server's address.
pub const SERVER: &str = "sync.server";

type Conn = (Repo, DialerHandle);

pub struct Sharing {
    emit: Emit,
    state: Arc<Mutex<SharingStatus>>,
    /// The repo and its dialer, while an address is set.
    conn: Arc<Mutex<Option<Conn>>>,
    /// Bumped on every change of address, so an old connection's events are ignored.
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
    pub fn new(emit: Emit) -> Sharing {
        Sharing {
            emit,
            state: Arc::new(Mutex::new(SharingStatus { state: "off".into(), server: None, private: false, error: None })),
            conn: Arc::default(),
            generation: Arc::default(),
        }
    }

    pub fn status(&self) -> SharingStatus {
        self.state.lock().unwrap().clone()
    }

    /// Connects to `server` (a checked address), or to nothing; any earlier connection stops.
    pub fn connect(&self, server: Option<&str>) -> SharingStatus {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some((repo, dialer)) = self.conn.lock().unwrap().take() {
            dialer.close();
            tauri::async_runtime::spawn(async move { repo.stop().await });
        }
        let url = server.and_then(|s| ws_url(s).ok());
        let set = setter(self.emit.clone(), self.state.clone(), self.generation.clone(), generation);
        let Some(url) = url else {
            return set("off", None, false, None);
        };
        let first = set("connecting", server.map(str::to_string), is_private(&url), None);
        let (conn, current) = (self.conn.clone(), self.generation.clone());
        let (server, private) = (first.server.clone(), first.private);
        tauri::async_runtime::spawn(async move {
            let repo = Repo::build_tokio().load().await;
            let Ok(dialer) = repo.dial_websocket(url, BackoffConfig::default()) else { return };
            let mut events = dialer.events();
            let stale = {
                let mut slot = conn.lock().unwrap();
                let stale = current.load(Ordering::SeqCst) != generation;
                if !stale {
                    *slot = Some((repo.clone(), dialer.clone()));
                }
                stale
            };
            if stale {
                dialer.close();
                repo.stop().await;
                return;
            }
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
