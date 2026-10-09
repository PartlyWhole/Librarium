//! The one error type. It crosses IPC as `{code, message}`; the message is calm and can be
//! shown to the user as it is.

use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename = "ErrorCode")]
pub enum Code {
    /// No library is open (none chosen, still opening, or it failed to open).
    NoLibrary,
    /// No record, file, job or method with that identity.
    NotFound,
    /// The file changed since the version the caller was based on.
    Conflict,
    /// The record can't be rewritten (unparsable frontmatter, newer kind, locked file).
    ReadOnly,
    /// The caller sent something malformed or not allowed.
    Invalid,
    /// A file-system or database error.
    Io,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(rename = "BackendError")]
pub struct Error {
    pub code: Code,
    pub message: String,
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    pub fn new(code: Code, message: impl Into<String>) -> Error {
        Error { code, message: message.into() }
    }
    pub fn not_found(m: impl Into<String>) -> Error {
        Error::new(Code::NotFound, m)
    }
    pub fn conflict(m: impl Into<String>) -> Error {
        Error::new(Code::Conflict, m)
    }
    pub fn invalid(m: impl Into<String>) -> Error {
        Error::new(Code::Invalid, m)
    }
    pub fn read_only(m: impl Into<String>) -> Error {
        Error::new(Code::ReadOnly, m)
    }
    pub fn io(m: impl Into<String>) -> Error {
        Error::new(Code::Io, m)
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Error {
        match e.kind() {
            std::io::ErrorKind::NotFound => Error::not_found(e.to_string()),
            _ => Error::io(e.to_string()),
        }
    }
}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Error {
        Error::io(format!("index: {e}"))
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Error {
        Error::invalid(e.to_string())
    }
}

/// Adds what was being done to an I/O error: "saving: Permission denied".
pub trait Context<T> {
    fn ctx(self, what: &str) -> Result<T>;
}

impl<T> Context<T> for std::io::Result<T> {
    fn ctx(self, what: &str) -> Result<T> {
        self.map_err(|e| {
            let mut err = Error::from(e);
            err.message = format!("{what}: {}", err.message);
            err
        })
    }
}
