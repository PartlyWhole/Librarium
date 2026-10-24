//! Setting up the user's own server from Librarium (Settings ▸ Sharing ▸ Set up your server…):
//! the setup script and the job that lets Macs in (deploy/sync/, built into the app) are copied
//! over SSH, with the Mac's own SSH key and settings, and the script is run there as root. Its
//! output goes to the interface line by line (`sharing.setup` events), and at the end the join
//! code it prints, which the interface joins with.

use crate::error::{Error, Result};
use crate::store::Emit;
use serde_json::json;
use std::io::{BufRead, BufReader, Write as _};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const SETUP: &str = include_str!("../../../deploy/sync/setup.sh");
const ACCEPT: &str = include_str!("../../../deploy/sync/accept_devices.py");
/// Where the files go on the server.
const DIR: &str = "/root/librarium-sync";

/// The server as SSH is given it: `host` (as root) or `user@host`. Nothing that could be read as
/// an SSH option or a second word.
pub fn target(given: &str) -> Result<String> {
    let t = given.trim();
    let ok = !t.is_empty() && !t.starts_with('-') && t.chars().all(|c| c.is_ascii_alphanumeric() || ".-_@:[]".contains(c));
    if !ok {
        return Err(Error::invalid("Give the server as you'd SSH to it: its address, or user@address."));
    }
    Ok(if t.contains('@') { t.to_string() } else { format!("root@{t}") })
}

fn ssh(target: &str, remote: &str) -> Command {
    let mut c = Command::new("/usr/bin/ssh");
    // No questions it can't answer here: the key does it, and a new server's key is recorded.
    c.args(["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15", target, remote]);
    c
}

/// Runs `remote` with `input` on its standard input; its error output becomes the error.
fn send(target: &str, remote: &str, input: &str) -> Result<()> {
    let mut child = ssh(target, remote).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(|e| Error::io(format!("ssh didn’t start: {e}")))?;
    child.stdin.take().unwrap().write_all(input.as_bytes()).map_err(|e| Error::io(e.to_string()))?;
    let out = child.wait_with_output().map_err(|e| Error::io(e.to_string()))?;
    if out.status.success() {
        return Ok(());
    }
    let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(Error::io(if why.contains("Permission denied") {
        format!("The server didn’t accept this Mac’s SSH key ({why}). Check you can run: ssh {target}")
    } else {
        format!("Couldn’t reach the server over SSH: {why}")
    }))
}

pub struct ServerSetup {
    emit: Emit,
    running: Arc<AtomicBool>,
}

impl ServerSetup {
    pub fn new(emit: Emit) -> ServerSetup {
        ServerSetup { emit, running: Arc::default() }
    }

    /// Starts setting up `given` (on its own thread); what happens comes as events.
    pub fn start(&self, given: &str) -> Result<()> {
        let target = target(given)?;
        if self.running.swap(true, Ordering::SeqCst) {
            return Err(Error::conflict("The server is already being set up."));
        }
        let (emit, running) = (self.emit.clone(), self.running.clone());
        std::thread::spawn(move || {
            let line = |text: &str| emit("sharing.setup", json!({ "line": text }));
            let result = (|| -> Result<String> {
                line(&format!("Connecting to {target}…"));
                send(&target, &format!("mkdir -p {DIR} && cat > {DIR}/setup.sh"), SETUP)?;
                send(&target, &format!("cat > {DIR}/accept_devices.py"), ACCEPT)?;
                line("Running the setup (a few minutes the first time)…");
                let mut child = ssh(&target, &format!("bash {DIR}/setup.sh 2>&1")).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| Error::io(e.to_string()))?;
                let mut code = None;
                let mut last = String::new();
                for l in BufReader::new(child.stdout.take().unwrap()).lines().map_while(std::result::Result::ok) {
                    if l.trim().starts_with("librarium-join:") {
                        code = Some(l.trim().to_string());
                    } else if !l.trim().is_empty() {
                        line(&l);
                        last = l;
                    }
                }
                let status = child.wait().map_err(|e| Error::io(e.to_string()))?;
                match code {
                    Some(c) if status.success() => Ok(c),
                    _ => Err(Error::io(if last.is_empty() { "The setup stopped before it finished.".to_string() } else { last })),
                }
            })();
            running.store(false, Ordering::SeqCst);
            match result {
                Ok(code) => emit("sharing.setup", json!({ "done": true, "code": code })),
                Err(e) => emit("sharing.setup", json!({ "done": true, "error": e.message })),
            }
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets() {
        assert_eq!(target(" 2.28.14.161 ").unwrap(), "root@2.28.14.161");
        assert_eq!(target("alan@relay-1.example.org").unwrap(), "alan@relay-1.example.org");
        assert!(target("-oProxyCommand=x").is_err());
        assert!(target("host; rm -rf /").is_err());
        assert!(target("").is_err());
    }
}
