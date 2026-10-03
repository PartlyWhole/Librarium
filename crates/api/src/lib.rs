//! The application API: plain Rust, typed methods, one typed error, no transport types.
//!
//! Tests drive [`Api`] directly. A Transport carries it as JSON-RPC through [`RpcHandler`].

use librarium_contracts::api::{
    methods, AppInfo, CreateParams, IdParams, LibraryState, LibraryStatus, ListParams, OpenLibraryParams, RecordInfo,
    RecordText, RelocateParams, SaveParams, SaveResult, SetFieldsParams, SettingsParams, StoreStatus, WorkerPong,
    Written,
};
use librarium_contracts::events::methods as events;
use librarium_contracts::ports::{ChangeSource, Clock, FileSystem, IdGenerator, VersionStore, WorkerHost};
use librarium_contracts::rpc::{NotificationSink, RpcHandler, RpcNotification, RpcRequest, RpcResponse};
use librarium_contracts::{BackendError, ErrorCode, Id, Result};
use librarium_kernel::frontmatter::FmValue;
use librarium_kernel::kinds::Kinds;
use librarium_kernel::library::{IndexFactory, Library, LibraryPorts, OpenOptions};
use librarium_kernel::settings::Settings;
use librarium_kernel::writer::Lane;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

/// Built-in API calls, in a fixed order.
pub const METHODS: &[&str] = &[
    methods::APP_INFO,
    methods::WORKER_PING,
    methods::LIBRARY_STATUS,
    methods::LIBRARY_OPEN,
    methods::LIBRARY_CLOSE,
    methods::RECORDS_LIST,
    methods::RECORDS_GET,
    methods::RECORDS_READ,
    methods::RECORDS_CREATE,
    methods::RECORDS_SAVE,
    methods::RECORDS_SET_FIELDS,
    methods::RECORDS_RELOCATE,
    methods::SETTINGS_GET,
    methods::SETTINGS_SET,
];

/// The settings key holding the library folder.
pub const LIBRARY_PATH: &str = "store.path";

pub struct Deps {
    pub worker: Arc<dyn WorkerHost>,
    pub fs: Arc<dyn FileSystem>,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn IdGenerator>,
    pub versions: Arc<dyn VersionStore>,
    pub index: IndexFactory,
    /// A fresh change source for each library opened.
    pub changes: Arc<dyn Fn() -> Arc<dyn ChangeSource> + Send + Sync>,
    /// Builds the record kinds (from the features' contributions).
    pub kinds: Arc<dyn Fn() -> Kinds + Send + Sync>,
    /// `~/Library/Application Support/<identifier>/`
    pub app_support: PathBuf,
    pub open_options: OpenOptions,
}

enum Lib {
    None,
    Opening(PathBuf),
    Open(Arc<Library>),
    Failed(PathBuf, BackendError),
}

pub struct Api {
    deps: Deps,
    settings: Settings,
    library: RwLock<Lib>,
    sink: RwLock<Option<Arc<dyn NotificationSink>>>,
    open_lock: Mutex<()>,
}

fn params<T: DeserializeOwned>(v: Value) -> Result<T> {
    let v = if v.is_null() { json!({}) } else { v };
    serde_json::from_value(v)
        .map_err(|e| BackendError::invalid(format!("bad params: {e}")).with_data(json!({ "params": e.to_string() })))
}

fn to_json<T: Serialize>(v: T) -> Result<Value> {
    serde_json::to_value(v).map_err(|e| BackendError::internal(e.to_string()))
}

fn fm_value(k: &str, v: &Value) -> Result<Option<FmValue>> {
    if v.is_null() {
        return Ok(None);
    }
    FmValue::from_json(v)
        .map(Some)
        .ok_or_else(|| BackendError::invalid(format!("field {k:?} must be a string, number, boolean or list of these")))
}

/// Is the folder inside iCloud Drive?
pub fn in_icloud(path: &Path) -> bool {
    let s = path.to_string_lossy();
    s.contains("/Library/Mobile Documents/") || s.contains("/com~apple~CloudDocs")
}

impl Api {
    pub fn new(deps: Deps) -> Self {
        let settings = Settings::load(deps.fs.clone(), &deps.app_support);
        Api { deps, settings, library: RwLock::new(Lib::None), sink: RwLock::new(None), open_lock: Mutex::new(()) }
    }

    /// Where notifications (events) go.
    pub fn set_sink(&self, sink: Arc<dyn NotificationSink>) {
        *self.sink.write().unwrap() = Some(sink);
    }

    fn notify(&self, method: &str, params: Value) {
        if let Some(s) = self.sink.read().unwrap().as_ref() {
            s.notify(RpcNotification::new(method, params));
        }
    }

    /// Opens the library chosen earlier, if any. Call once at startup.
    pub fn open_saved_library(self: &Arc<Self>) {
        if let Some(Value::String(p)) = self.settings.get(LIBRARY_PATH) {
            let _ = self.open_library(Path::new(&p));
        }
    }

    pub fn app_info(&self) -> AppInfo {
        AppInfo {
            name: "Librarium".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            api_methods: self.method_names(),
        }
    }

    pub fn worker_ping(&self) -> Result<WorkerPong> {
        let t = Instant::now();
        let v = self.deps.worker.call("ping", json!({}), Duration::from_secs(30))?;
        Ok(WorkerPong {
            worker_version: v["worker_version"].as_str().unwrap_or_default().to_string(),
            pid: v["pid"].as_u64().unwrap_or_default() as u32,
            round_trip_us: t.elapsed().as_micros() as u64,
        })
    }

    pub fn method_names(&self) -> Vec<String> {
        METHODS.iter().map(|s| s.to_string()).collect()
    }

    // ---- library --------------------------------------------------------------------------

    pub fn library_status(&self) -> LibraryStatus {
        let saved = self.settings.get(LIBRARY_PATH).and_then(|v| v.as_str().map(PathBuf::from));
        match &*self.library.read().unwrap() {
            Lib::None => match saved {
                Some(p) => LibraryStatus {
                    state: LibraryState::Missing,
                    in_icloud: in_icloud(&p),
                    path: Some(p.display().to_string()),
                    id: None,
                    store: None,
                    error: None,
                },
                None => LibraryStatus {
                    state: LibraryState::None,
                    path: None,
                    id: None,
                    in_icloud: false,
                    store: None,
                    error: None,
                },
            },
            Lib::Opening(p) => LibraryStatus {
                state: LibraryState::Opening,
                path: Some(p.display().to_string()),
                id: None,
                in_icloud: in_icloud(p),
                store: None,
                error: None,
            },
            Lib::Open(l) => LibraryStatus {
                state: LibraryState::Open,
                path: Some(l.root.display().to_string()),
                id: Some(l.id),
                in_icloud: in_icloud(&l.root),
                store: Some(l.store.status()),
                error: None,
            },
            Lib::Failed(p, e) => LibraryStatus {
                state: if e.data.as_ref().is_some_and(|d| d.get("library_missing").is_some()) {
                    LibraryState::Missing
                } else {
                    LibraryState::Failed
                },
                path: Some(p.display().to_string()),
                id: None,
                in_icloud: in_icloud(p),
                store: None,
                error: Some(e.message.clone()),
            },
        }
    }

    /// Opens a library folder (closing any open one) and remembers the choice.
    pub fn open_library(self: &Arc<Self>, path: &Path) -> Result<LibraryStatus> {
        let _guard = self.open_lock.lock().unwrap();
        self.close_library();
        *self.library.write().unwrap() = Lib::Opening(path.to_path_buf());
        self.notify(events::STATUS, to_json(self.library_status())?);
        let ports = LibraryPorts {
            fs: self.deps.fs.clone(),
            clock: self.deps.clock.clone(),
            ids: self.deps.ids.clone(),
            versions: self.deps.versions.clone(),
            index: self.deps.index.clone(),
            changes: (self.deps.changes)(),
        };
        match Library::open(path, &self.deps.app_support, ports, (self.deps.kinds)(), self.deps.open_options.clone()) {
            Ok(lib) => {
                let lib = Arc::new(lib);
                let weak = Arc::downgrade(self);
                lib.store.changes.subscribe(Arc::new(move |c| {
                    if let Some(api) = weak.upgrade() {
                        api.notify(events::CHANGE, serde_json::to_value(c).unwrap());
                    }
                }));
                *self.library.write().unwrap() = Lib::Open(lib);
                self.settings.set(&[(LIBRARY_PATH.into(), Some(Value::String(path.display().to_string())))])?;
            }
            Err(e) => {
                *self.library.write().unwrap() = Lib::Failed(path.to_path_buf(), e.clone());
                self.notify(events::STATUS, to_json(self.library_status())?);
                return Err(e);
            }
        }
        let st = self.library_status();
        self.notify(events::STATUS, to_json(&st)?);
        Ok(st)
    }

    pub fn close_library(&self) {
        let old = std::mem::replace(&mut *self.library.write().unwrap(), Lib::None);
        if let Lib::Open(l) = old {
            l.close();
        }
    }

    /// The open library, or a calm error saying why there isn't one.
    pub fn library(&self) -> Result<Arc<Library>> {
        match &*self.library.read().unwrap() {
            Lib::Open(l) => Ok(l.clone()),
            Lib::Opening(_) => Err(BackendError::new(ErrorCode::NotReady, "The library is still opening.")),
            Lib::Failed(_, e) => Err(e.clone()),
            Lib::None => Err(BackendError::new(ErrorCode::NotReady, "No library folder is chosen yet.")),
        }
    }

    pub fn store_status(&self) -> Result<StoreStatus> {
        Ok(self.library()?.store.status())
    }

    // ---- records --------------------------------------------------------------------------

    pub fn records_list(&self, p: ListParams) -> Result<Vec<RecordInfo>> {
        let lib = self.library()?;
        let mut v: Vec<RecordInfo> = lib.store.list(p.kind.as_deref()).iter().map(|e| e.info()).collect();
        v.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()).then(a.id.cmp(&b.id)));
        Ok(v)
    }

    pub fn records_get(&self, id: Id) -> Result<RecordInfo> {
        self.library()?
            .store
            .get(id)
            .map(|e| e.info())
            .ok_or_else(|| BackendError::not_found(format!("no record {id}")))
    }

    pub fn records_read(&self, id: Id) -> Result<RecordText> {
        self.library()?.store.read_text(id)
    }

    pub fn records_create(&self, p: CreateParams) -> Result<Written> {
        let lib = self.library()?;
        let mut fields = vec![];
        for (k, v) in &p.fields {
            if let Some(f) = fm_value(k, v)? {
                fields.push((k.clone(), f));
            }
        }
        let (e, seq) = lib.write(Lane::Interactive, move |tx| {
            tx.create(&p.kind, &p.title, fields, &p.body, p.subfolder.as_deref())
        })?;
        Ok(Written { info: e.info(), seq })
    }

    pub fn records_save(&self, p: SaveParams) -> Result<SaveResult> {
        let lib = self.library()?;
        lib.write(Lane::Interactive, move |tx| tx.save_body(p.id, &p.base_version, p.base_body.as_deref(), &p.body))
    }

    pub fn records_set_fields(&self, p: SetFieldsParams) -> Result<Written> {
        let lib = self.library()?;
        let mut edits = vec![];
        for (k, v) in &p.fields {
            edits.push((k.clone(), fm_value(k, v)?));
        }
        let (e, seq) =
            lib.write(Lane::Interactive, move |tx| tx.set_fields(p.id, p.base_version.as_deref(), &edits))?;
        Ok(Written { info: e.info(), seq })
    }

    pub fn records_relocate(&self, p: RelocateParams) -> Result<Written> {
        let lib = self.library()?;
        let (e, seq) = lib.write(Lane::Interactive, move |tx| {
            let sub = p.subfolder.as_ref().map(|s| s.as_deref().filter(|x| !x.is_empty()));
            tx.relocate(p.id, p.title.as_deref(), sub)
        })?;
        Ok(Written { info: e.info(), seq })
    }

    // ---- settings -------------------------------------------------------------------------

    pub fn settings_get(&self) -> Map<String, Value> {
        self.settings.all()
    }

    pub fn settings_set(&self, values: Map<String, Value>) -> Result<Map<String, Value>> {
        if values.contains_key(LIBRARY_PATH) {
            return Err(BackendError::invalid("the library folder is changed with folder.open"));
        }
        let changes: Vec<_> = values.into_iter().map(|(k, v)| (k, if v.is_null() { None } else { Some(v) })).collect();
        self.settings.set(&changes)?;
        Ok(self.settings.all())
    }

    /// Calls a method by name with JSON params: what a Transport does.
    pub fn call(self: &Arc<Self>, method: &str, p: Value) -> Result<Value> {
        match method {
            methods::APP_INFO => to_json(self.app_info()),
            methods::WORKER_PING => to_json(self.worker_ping()?),
            methods::LIBRARY_STATUS => to_json(self.library_status()),
            methods::LIBRARY_OPEN => {
                let p: OpenLibraryParams = params(p)?;
                to_json(self.open_library(Path::new(&p.path))?)
            }
            methods::LIBRARY_CLOSE => {
                self.close_library();
                to_json(self.library_status())
            }
            methods::RECORDS_LIST => to_json(self.records_list(params(p)?)?),
            methods::RECORDS_GET => to_json(self.records_get(params::<IdParams>(p)?.id)?),
            methods::RECORDS_READ => to_json(self.records_read(params::<IdParams>(p)?.id)?),
            methods::RECORDS_CREATE => to_json(self.records_create(params(p)?)?),
            methods::RECORDS_SAVE => to_json(self.records_save(params(p)?)?),
            methods::RECORDS_SET_FIELDS => to_json(self.records_set_fields(params(p)?)?),
            methods::RECORDS_RELOCATE => to_json(self.records_relocate(params(p)?)?),
            methods::SETTINGS_GET => to_json(self.settings_get()),
            methods::SETTINGS_SET => to_json(self.settings_set(params::<SettingsParams>(p)?.values)?),
            _ => Err(BackendError::not_found(format!("no API call {method}")).with_data(json!({ "method": method }))),
        }
    }
}

/// The API as a JSON-RPC handler.
pub struct Handler(pub Arc<Api>);

impl RpcHandler for Handler {
    fn handle(&self, request: RpcRequest) -> RpcResponse {
        match self.0.call(&request.method, request.params) {
            Ok(v) => RpcResponse::ok(request.id, v),
            Err(e) => RpcResponse::err(request.id, e),
        }
    }
}
