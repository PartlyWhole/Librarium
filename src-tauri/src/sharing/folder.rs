//! The shared folder: Library ▸ Shared, kept the same on colleagues' Macs by Syncthing, through
//! the Syncthing on the sync server. Librarium runs its own Syncthing (bundled beside the app),
//! with its home in app data (`syncthing/`): made once with discovery, relays, NAT traversal,
//! usage reports and upgrades off, so it only ever talks to the server named in the join code.
//! It runs while a library is open and a join code is set, listens on this Mac only, and is told
//! what to do through its REST API with a key chosen at each start.
//!
//! A join code (`librarium-join:` and base64url JSON) names the sync server's address and its
//! Syncthing's device ID and address; the server's setup script prints it. Its status goes out
//! as `sharing.folder` events.

use crate::error::{Error, Result};
use crate::store::{folders, Emit, Library};
use crate::types::SharedFolderStatus;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The settings key holding the join code's contents.
pub const JOIN: &str = "sharing.join";
/// The Syncthing folder everyone shares, and the Library folder it is.
const FOLDER_ID: &str = "librarium-shared";
pub const FOLDER: &str = "Shared";
const CODE_PREFIX: &str = "librarium-join:";

/// What a join code says: the sync server's address, and its Syncthing's device ID and address.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Join {
    pub server: String,
    pub device: String,
    pub address: String,
}

pub fn parse_code(code: &str) -> Result<Join> {
    let bad = || Error::invalid("That isn’t a join code. It starts with librarium-join: and comes from whoever set up your sync server.");
    let body = code.trim().strip_prefix(CODE_PREFIX).ok_or_else(bad)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(body.trim_end_matches('=')).map_err(|_| bad())?;
    let j: Join = serde_json::from_slice(&bytes).map_err(|_| bad())?;
    let id_ok = j.device.split('-').count() == 8 && j.device.chars().all(|c| c == '-' || c.is_ascii_alphanumeric());
    if !id_ok || !j.address.starts_with("tcp://") {
        return Err(bad());
    }
    super::ws_url(&j.server)?;
    Ok(j)
}

pub fn code_of(j: &Join) -> String {
    format!("{CODE_PREFIX}{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(j).unwrap_or_default()))
}

/// Librarium's Syncthing's REST API.
#[derive(Clone)]
struct Api {
    base: String,
    key: String,
    http: reqwest::Client,
}

impl Api {
    async fn call(&self, method: reqwest::Method, path: &str, body: Option<&Value>) -> Result<Value> {
        let mut r = self.http.request(method, format!("{}{path}", self.base)).header("X-API-Key", &self.key);
        if let Some(b) = body {
            r = r.header("Content-Type", "application/json").body(b.to_string());
        }
        let res = r.send().await.map_err(|e| Error::io(format!("Syncthing didn’t answer ({e}).")))?;
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(Error::io(format!("Syncthing refused {path} ({status}): {}", text.trim())));
        }
        Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
    }
    async fn get(&self, path: &str) -> Result<Value> {
        self.call(reqwest::Method::GET, path, None).await
    }
}

struct Running {
    child: Child,
    api: Api,
    stop: Arc<AtomicBool>,
}

pub struct Folder {
    home: PathBuf,
    log: PathBuf,
    emit: Emit,
    state: Arc<Mutex<SharedFolderStatus>>,
    running: Mutex<Option<Running>>,
}

fn status(state: &str, detail: Option<String>, need: u64) -> SharedFolderStatus {
    SharedFolderStatus { state: state.into(), detail, need }
}

/// The Syncthing bundled beside the app's program.
fn binary() -> Result<PathBuf> {
    let p = std::env::current_exe().map_err(|e| Error::io(e.to_string()))?.with_file_name("syncthing");
    if p.is_file() {
        Ok(p)
    } else {
        Err(Error::not_found("Syncthing isn’t in this copy of Librarium, so the shared folder can’t be kept."))
    }
}

/// Makes Syncthing's home the first time: its keys and settings, then the settings changed so it
/// never announces itself or reaches anything but the sync server, and never upgrades or reports.
fn make_home(bin: &Path, home: &Path) -> Result<()> {
    let config = home.join("config.xml");
    if config.exists() {
        return Ok(());
    }
    let out = Command::new(bin).args(["generate", "--no-port-probing", "--home"]).arg(home).output().map_err(|e| Error::io(e.to_string()))?;
    if !out.status.success() {
        return Err(Error::io(format!("Syncthing couldn’t make its settings: {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    let mut xml = std::fs::read_to_string(&config).map_err(|e| Error::io(e.to_string()))?;
    for (from, to) in [
        ("<listenAddress>default</listenAddress>", "<listenAddress>tcp://127.0.0.1:0</listenAddress>"),
        ("<globalAnnounceEnabled>true</globalAnnounceEnabled>", "<globalAnnounceEnabled>false</globalAnnounceEnabled>"),
        ("<localAnnounceEnabled>true</localAnnounceEnabled>", "<localAnnounceEnabled>false</localAnnounceEnabled>"),
        ("<relaysEnabled>true</relaysEnabled>", "<relaysEnabled>false</relaysEnabled>"),
        ("<natEnabled>true</natEnabled>", "<natEnabled>false</natEnabled>"),
        ("<startBrowser>true</startBrowser>", "<startBrowser>false</startBrowser>"),
        ("<urAccepted>0</urAccepted>", "<urAccepted>-1</urAccepted>"),
        ("<crashReportingEnabled>true</crashReportingEnabled>", "<crashReportingEnabled>false</crashReportingEnabled>"),
    ] {
        xml = xml.replace(from, to);
    }
    xml = replace_between(&xml, "<autoUpgradeIntervalH>", "</autoUpgradeIntervalH>", "0");
    std::fs::write(&config, xml).map_err(|e| Error::io(e.to_string()))
}

/// Replaces the text between `open` and `close` (the first such pair).
fn replace_between(s: &str, open: &str, close: &str, with: &str) -> String {
    match (s.find(open), s.find(close)) {
        (Some(a), Some(b)) if b > a => format!("{}{open}{with}{}", &s[..a], &s[b..]),
        _ => s.to_string(),
    }
}

/// A Syncthing left running by a Librarium that stopped without closing it holds the home's lock:
/// it is stopped first.
fn stop_leftover(home: &Path) {
    let pid_file = home.join("librarium.pid");
    if let Some(pid) = std::fs::read_to_string(&pid_file).ok().and_then(|s| s.trim().parse::<u32>().ok()) {
        let is_ours = Command::new("ps").args(["-p", &pid.to_string(), "-o", "comm="]).output().is_ok_and(|o| String::from_utf8_lossy(&o.stdout).trim().ends_with("syncthing"));
        if is_ours {
            let _ = Command::new("kill").arg(pid.to_string()).status();
            // It lets go of the home's lock only once it has stopped.
            let alive = || Command::new("kill").args(["-0", &pid.to_string()]).stderr(Stdio::null()).status().is_ok_and(|s| s.success());
            let deadline = Instant::now() + Duration::from_secs(10);
            while alive() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(200));
            }
            std::thread::sleep(Duration::from_millis(300));
        }
    }
    let _ = std::fs::remove_file(pid_file);
}

impl Folder {
    pub fn new(app_data: &Path, logs: &Path, emit: Emit) -> Folder {
        Folder {
            home: app_data.join("syncthing"),
            log: logs.join("syncthing.log"),
            emit,
            state: Arc::new(Mutex::new(status("off", None, 0))),
            running: Mutex::new(None),
        }
    }

    pub fn status(&self) -> SharedFolderStatus {
        self.state.lock().unwrap().clone()
    }

    fn set(emit: &Emit, state: &Mutex<SharedFolderStatus>, s: SharedFolderStatus) {
        let changed = *state.lock().unwrap() != s;
        if changed {
            *state.lock().unwrap() = s.clone();
            emit("sharing.folder", serde_json::to_value(&s).unwrap_or_default());
        }
    }

    /// Starts keeping the library's Shared folder with the server the join code names (any
    /// earlier run stops first). Problems show in the status rather than failing.
    pub fn start(&self, lib: &Library, join: &Join, name: Option<String>) {
        self.stop();
        let set = |s| Folder::set(&self.emit, &self.state, s);
        set(status("starting", None, 0));
        match self.launch(lib, join) {
            Ok(r) => {
                let (api, stop, emit, state, join, path) = (r.api.clone(), r.stop.clone(), self.emit.clone(), self.state.clone(), join.clone(), lib.root.join("items").join(FOLDER));
                *self.running.lock().unwrap() = Some(r);
                tauri::async_runtime::spawn(async move { follow(api, stop, emit, state, join, path, name).await });
            }
            Err(e) => set(status("error", Some(e.message), 0)),
        }
    }

    fn launch(&self, lib: &Library, _join: &Join) -> Result<Running> {
        let bin = binary()?;
        std::fs::create_dir_all(&self.home).map_err(|e| Error::io(e.to_string()))?;
        make_home(&bin, &self.home)?;
        stop_leftover(&self.home);
        // The Library's Shared folder, made through the store if it isn't there yet.
        if !lib.root.join("items").join(FOLDER).is_dir() {
            folders::create(&lib.write(), "item", FOLDER)?;
        }
        let port = std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map_err(|e| Error::io(e.to_string()))?.port();
        let key = crate::util::new_id().simple().to_string();
        let child = Command::new(&bin)
            .args(["serve", "--no-browser", "--no-restart", "--no-upgrade", "--log-max-old-files=1"])
            .arg(format!("--home={}", self.home.display()))
            .arg(format!("--gui-address=http://127.0.0.1:{port}"))
            .arg(format!("--gui-apikey={key}"))
            .arg(format!("--log-file={}", self.log.display()))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| Error::io(format!("Syncthing didn’t start: {e}")))?;
        let _ = std::fs::write(self.home.join("librarium.pid"), child.id().to_string());
        // reqwest needs rustls's provider even for http:// (it builds its TLS setup up front).
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(10)).build().map_err(|e| Error::io(e.to_string()))?;
        Ok(Running { child, api: Api { base: format!("http://127.0.0.1:{port}"), key, http }, stop: Arc::new(AtomicBool::new(false)) })
    }

    /// Stops Librarium's Syncthing (asked first, then made to).
    pub fn stop(&self) {
        let Some(mut r) = self.running.lock().unwrap().take() else { return };
        r.stop.store(true, Ordering::SeqCst);
        let api = r.api.clone();
        let _ = super::block_on(async move { tokio::time::timeout(Duration::from_secs(3), api.call(reqwest::Method::POST, "/rest/system/shutdown", None)).await });
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = r.child.try_wait() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = r.child.kill();
        let _ = r.child.wait();
        let _ = std::fs::remove_file(self.home.join("librarium.pid"));
        Folder::set(&self.emit, &self.state, status("off", None, 0));
    }
}

/// Waits for Syncthing to answer, tells it about the server and the folder, then reports how the
/// folder is doing every few seconds until stopped.
async fn follow(api: Api, stop: Arc<AtomicBool>, emit: Emit, state: Arc<Mutex<SharedFolderStatus>>, join: Join, path: PathBuf, name: Option<String>) {
    let set = |s| Folder::set(&emit, &state, s);
    let started = Instant::now();
    while api.get("/rest/noauth/health").await.is_err() {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        if started.elapsed() > Duration::from_secs(30) {
            return set(status("error", Some("Syncthing didn’t start (see Reveal logs).".into()), 0));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    if let Err(e) = configure(&api, &join, &path, name.as_deref()).await {
        return set(status("error", Some(e.message), 0));
    }
    while !stop.load(Ordering::SeqCst) {
        set(report(&api, &join).await);
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

async fn configure(api: &Api, join: &Join, path: &Path, name: Option<&str>) -> Result<()> {
    use reqwest::Method;
    // This Mac goes by the person's name in the server's list of devices.
    if let (Some(name), Ok(me)) = (name.filter(|n| !n.trim().is_empty()), api.get("/rest/system/status").await) {
        if let Some(id) = me["myID"].as_str() {
            api.call(Method::PATCH, &format!("/rest/config/devices/{id}"), Some(&json!({ "name": name.trim() }))).await?;
        }
    }
    let options = json!({
        "listenAddresses": ["tcp://127.0.0.1:0"],
        "globalAnnounceEnabled": false, "localAnnounceEnabled": false,
        "relaysEnabled": false, "natEnabled": false,
        "startBrowser": false, "urAccepted": -1, "crashReportingEnabled": false, "autoUpgradeIntervalH": 0,
    });
    api.call(Method::PATCH, "/rest/config/options", Some(&options)).await?;
    let device = json!({ "deviceID": join.device, "name": "Sync server", "addresses": [join.address], "autoAcceptFolders": false });
    api.call(Method::PUT, &format!("/rest/config/devices/{}", join.device), Some(&device)).await?;
    // A folder kept for another library (or another server) is let go, then made afresh here, so
    // nothing is taken for deleted in the new place.
    let path_s = path.display().to_string();
    if let Ok(f) = api.get(&format!("/rest/config/folders/{FOLDER_ID}")).await {
        let same_path = f["path"].as_str() == Some(path_s.as_str());
        let same_server = f["devices"].as_array().is_some_and(|d| d.iter().any(|x| x["deviceID"] == json!(join.device)));
        if same_path && same_server {
            api.call(Method::PATCH, &format!("/rest/config/folders/{FOLDER_ID}"), Some(&json!({ "fsWatcherDelayS": 2 }))).await?;
            return Ok(());
        }
        api.call(Method::DELETE, &format!("/rest/config/folders/{FOLDER_ID}"), None).await?;
    }
    let folder = json!({
        "id": FOLDER_ID, "label": "Librarium Shared", "path": path_s, "type": "sendreceive",
        "devices": [{ "deviceID": join.device }],
        "versioning": { "type": "trashcan", "params": { "cleanoutDays": "30" } },
        "fsWatcherEnabled": true, "fsWatcherDelayS": 2,
    });
    api.call(Method::PUT, &format!("/rest/config/folders/{FOLDER_ID}"), Some(&folder)).await?;
    Ok(())
}

async fn report(api: &Api, join: &Join) -> SharedFolderStatus {
    let connected = api.get("/rest/system/connections").await.ok().is_some_and(|c| c["connections"][&join.device]["connected"] == json!(true));
    let Ok(db) = api.get(&format!("/rest/db/status?folder={FOLDER_ID}")).await else {
        return status("starting", None, 0);
    };
    let need = db["needFiles"].as_u64().unwrap_or(0) + db["needDeletes"].as_u64().unwrap_or(0);
    let errors = db["errors"].as_u64().unwrap_or(0) + db["pullErrors"].as_u64().unwrap_or(0);
    match db["state"].as_str().unwrap_or("") {
        "error" => status("error", db["error"].as_str().map(str::to_string), need),
        _ if !connected => status("waiting", Some("Can’t reach the sync server’s Syncthing yet. Trying again…".into()), need),
        "syncing" | "sync-preparing" | "sync-waiting" | "scanning" | "scan-waiting" if need > 0 => status("syncing", None, need),
        _ if errors > 0 => status("error", Some(format!("{errors} files couldn’t be kept in step (see Reveal logs).")), need),
        _ => status("ready", None, need),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_codes() {
        let j = Join { server: "https://relay-1.tailb670a6.ts.net:8443".into(), device: "KOPFZFY-DZDVHQO-2V3SJGE-D2LJ5DF-O4VP55S-JJTBNC5-JZT5YIW-WEISNAL".into(), address: "tcp://relay-1.tailb670a6.ts.net:22000".into() };
        let code = code_of(&j);
        assert!(code.starts_with("librarium-join:"));
        assert_eq!(parse_code(&format!("  {code}\n")).unwrap(), j);
        assert!(parse_code("librarium-join:bm9wZQ").is_err());
        assert!(parse_code("hello").is_err());
    }
}
