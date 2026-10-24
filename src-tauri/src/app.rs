//! The app's state: the settings, and the open library (or why there isn't one). Opening a
//! library closes the previous one first; the interface is told by `library.status`.

use crate::bible::Bible;
use crate::error::{Code, Context, Error, Result};
use crate::etymology::Etymology;
use crate::settings::{Settings, LIBRARY_PATH};
use crate::sharing::{self, Sharing};
use crate::store::{Emit, Library};
use crate::types::{FolderInfo, LibraryState, LibraryStatus, SharedFolderStatus, SharingStatus};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

enum State {
    None,
    Opening(PathBuf),
    Open(Arc<Library>),
    Failed(PathBuf, Error),
}

pub struct App {
    /// `~/Library/Application Support/local.librarium.desktop/`
    pub app_data: PathBuf,
    /// `~/Library/Logs/local.librarium.desktop/`
    pub logs: PathBuf,
    pub settings: Settings,
    pub emit: Emit,
    /// Word origins and the Bible (the app's, not a library's).
    pub etymology: Etymology,
    pub bible: Bible,
    /// The connection to the sync server, if one is set.
    pub sharing: Sharing,
    state: RwLock<State>,
    opening: Mutex<()>,
}

/// Is the folder inside iCloud Drive?
pub fn in_icloud(path: &Path) -> bool {
    let s = path.to_string_lossy();
    s.contains("/Library/Mobile Documents/") || s.contains("/com~apple~CloudDocs")
}

impl App {
    pub fn new(app_data: PathBuf, logs: PathBuf, emit: Emit) -> App {
        let settings = Settings::load(&app_data);
        let sharing = Sharing::new(emit.clone(), &app_data, &logs);
        sharing.connect(settings.get(sharing::SERVER).as_ref().and_then(|v| v.as_str()));
        App {
            settings,
            sharing,
            etymology: Etymology::new(&app_data, emit.clone()),
            bible: Bible::new(&app_data, emit.clone()),
            app_data,
            logs,
            emit,
            state: RwLock::new(State::None),
            opening: Mutex::new(()),
        }
    }

    fn saved_path(&self) -> Option<PathBuf> {
        self.settings.get(LIBRARY_PATH).and_then(|v| v.as_str().map(PathBuf::from))
    }

    pub fn status(&self) -> LibraryStatus {
        let s = |state, path: Option<&Path>, error: Option<String>| LibraryStatus {
            state,
            in_icloud: path.is_some_and(in_icloud),
            path: path.map(|p| p.display().to_string()),
            id: None,
            store: None,
            error,
        };
        match &*self.state.read().unwrap() {
            State::None => match self.saved_path() {
                Some(p) => s(LibraryState::Missing, Some(&p), None),
                None => s(LibraryState::None, None, None),
            },
            State::Opening(p) => s(LibraryState::Opening, Some(p), None),
            State::Failed(p, e) if e.code == Code::NotFound => {
                s(LibraryState::Missing, Some(p), Some(e.message.clone()))
            }
            State::Failed(p, e) => s(LibraryState::Failed, Some(p), Some(e.message.clone())),
            State::Open(lib) => LibraryStatus {
                id: Some(lib.id),
                store: Some(lib.status()),
                ..s(LibraryState::Open, Some(&lib.root), None)
            },
        }
    }

    fn set_state(&self, state: State) {
        let opened = match &state {
            State::Open(lib) => Some(lib.clone()),
            _ => None,
        };
        let old = std::mem::replace(&mut *self.state.write().unwrap(), state);
        if let State::Open(lib) = old {
            self.sharing.close_library();
            lib.close();
        }
        if let Some(lib) = opened {
            self.sharing.open_library(lib, self.join(), self.my_name());
        }
        (self.emit)("library.status", serde_json::to_value(self.status()).unwrap_or_default());
    }

    /// Opens a library folder, closing any open one, and remembers the choice.
    pub fn open(&self, path: &Path) -> Result<LibraryStatus> {
        let _one_at_a_time = self.opening.lock().unwrap();
        self.set_state(State::Opening(path.to_path_buf()));
        match Library::open(path, &self.app_data, self.emit.clone()) {
            Ok(lib) => {
                let mut v = Map::new();
                v.insert(LIBRARY_PATH.into(), Value::String(path.display().to_string()));
                self.settings.set(v)?;
                self.set_state(State::Open(lib));
                Ok(self.status())
            }
            Err(e) => {
                log::warn!("the library at {} didn’t open: {e}", path.display());
                self.set_state(State::Failed(path.to_path_buf(), e.clone()));
                Err(e)
            }
        }
    }

    /// Opens the saved library on another thread, "opening" from now on.
    pub fn open_saved_soon(self: &Arc<Self>) {
        if let Some(p) = self.saved_path() {
            *self.state.write().unwrap() = State::Opening(p.clone());
            let app = self.clone();
            std::thread::spawn(move || {
                let _ = app.open(&p);
            });
        }
    }

    pub fn close(&self) {
        self.set_state(State::None);
    }

    /// The open library, or a calm error saying why there isn't one.
    pub fn library(&self) -> Result<Arc<Library>> {
        match &*self.state.read().unwrap() {
            State::Open(lib) => Ok(lib.clone()),
            State::Opening(_) => Err(Error::new(Code::NoLibrary, "The library is still opening.")),
            State::Failed(_, e) => Err(Error::new(Code::NoLibrary, e.message.clone())),
            State::None => Err(Error::new(Code::NoLibrary, "No library folder is chosen yet.")),
        }
    }

    pub fn set_settings(&self, values: Map<String, Value>) -> Result<Map<String, Value>> {
        if values.contains_key(LIBRARY_PATH) {
            return Err(Error::invalid("The library folder is changed by opening another."));
        }
        if values.contains_key(sharing::SERVER) || values.contains_key(sharing::folder::JOIN) {
            return Err(Error::invalid("The sync server is set with sharing.setServer, which checks it."));
        }
        self.settings.set(values)?;
        Ok(self.settings.all())
    }

    /// The name colleagues see (Settings ▸ Sharing).
    pub fn my_name(&self) -> Option<String> {
        self.settings.get(sharing::NAME).and_then(|v| v.as_str().map(str::to_string))
    }

    /// The join code's contents, if one was given.
    fn join(&self) -> Option<sharing::folder::Join> {
        self.settings.get(sharing::folder::JOIN).and_then(|v| serde_json::from_value(v).ok())
    }

    /// Joins with a code: its sync server becomes the one connected to, and the shared folder is
    /// kept with its Syncthing (in the open library).
    pub fn join_with(&self, code: &str) -> Result<SharedFolderStatus> {
        let j = sharing::folder::parse_code(code)?;
        self.set_sync_server(Some(j.server.clone()))?;
        let mut v = Map::new();
        v.insert(sharing::folder::JOIN.into(), serde_json::to_value(&j).unwrap_or_default());
        self.settings.set(v)?;
        let lib = self.library()?;
        self.sharing.folder.start(&lib, &j, self.my_name());
        Ok(self.sharing.folder.status())
    }

    /// Stops keeping the shared folder here (its files stay, as an ordinary folder).
    pub fn leave_folder(&self) -> Result<SharedFolderStatus> {
        self.sharing.folder.stop();
        let mut v = Map::new();
        v.insert(sharing::folder::JOIN.into(), Value::Null);
        self.settings.set(v)?;
        Ok(self.sharing.folder.status())
    }

    /// The join code to send a colleague.
    pub fn invite(&self) -> Result<String> {
        self.join().map(|j| sharing::folder::code_of(&j)).ok_or_else(|| Error::invalid("Join with a code first: the code from your sync server’s setup."))
    }

    /// Sets the sync server's address (`None`: none) after checking it, and connects to it.
    pub fn set_sync_server(&self, server: Option<String>) -> Result<SharingStatus> {
        let server = server.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        if let Some(s) = &server {
            sharing::ws_url(s)?;
        }
        let mut v = Map::new();
        v.insert(sharing::SERVER.into(), server.clone().map_or(Value::Null, Value::String));
        self.settings.set(v)?;
        Ok(self.sharing.connect(server.as_deref()))
    }

    /// Writes an export to a path the user chose: never inside the library, except its
    /// `exports` folder.
    pub fn export(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        if let Ok(lib) = self.library() {
            if path.starts_with(&lib.root) && !path.starts_with(lib.root.join("exports")) {
                return Err(Error::invalid("Exports go outside the library folder (or in its exports folder)."));
            }
        }
        crate::store::write::safe_write(path, bytes, false).ctx("writing the export")
    }
}

/// What a folder holds, so the first run can ask how to treat it.
pub fn inspect(path: &Path) -> FolderInfo {
    let mut info = FolderInfo {
        path: path.display().to_string(),
        exists: path.is_dir(),
        empty: true,
        is_library: path.join(".librarium/library.json").exists(),
        markdown_files: 0,
        in_icloud: in_icloud(path),
    };
    let mut stack = vec![path.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in fs::read_dir(&d).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            if d == path {
                info.empty = false;
            }
            if e.path().is_dir() {
                stack.push(e.path());
            } else if name.ends_with(".md") {
                info.markdown_files += 1;
                if info.markdown_files >= 10_000 {
                    return info;
                }
            }
        }
    }
    info
}

/// Shows a file or folder in the Finder.
pub fn reveal(path: &Path) -> Result<()> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSArray, NSString, NSURL};
    if !path.exists() {
        return Err(Error::not_found(format!("{} can’t be found.", path.display())));
    }
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    NSWorkspace::sharedWorkspace().activateFileViewerSelectingURLs(&NSArray::from_retained_slice(&[url]));
    Ok(())
}

/// Opens a web or mail address in the user's browser or mail app; nothing else is opened.
pub fn open_url(url: &str) -> Result<()> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};
    let u = url.trim();
    let lower = u.to_ascii_lowercase();
    let ok = ["https://", "http://", "mailto:"].iter().any(|p| lower.starts_with(p))
        && u.len() <= 8192
        && !u.chars().any(|c| c.is_whitespace() || c.is_control());
    let parsed = ok.then(|| NSURL::URLWithString(&NSString::from_str(u))).flatten();
    let url = parsed.ok_or_else(|| Error::invalid("Only web and mail addresses are opened."))?;
    if NSWorkspace::sharedWorkspace().openURL(&url) {
        Ok(())
    } else {
        Err(Error::io("The browser couldn’t open that address."))
    }
}
