//! A recording VersionStore: remembers every write it is told about.

use librarium_contracts::ports::VersionStore;
use librarium_contracts::Result;
use std::sync::Mutex;

#[derive(Default)]
pub struct RecordingVersions {
    pub writes: Mutex<Vec<(String, Vec<u8>)>>,
}

impl VersionStore for RecordingVersions {
    fn recorded(&self, path: &str, bytes: &[u8]) -> Result<()> {
        self.writes.lock().unwrap().push((path.to_string(), bytes.to_vec()));
        Ok(())
    }
    fn history(&self, path: &str) -> Result<Vec<String>> {
        Ok(self
            .writes
            .lock()
            .unwrap()
            .iter()
            .rev()
            .filter(|(p, _)| p == path)
            .map(|(_, b)| String::from_utf8_lossy(b).into_owned())
            .collect())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn passes_the_shared_suite() {
        crate::suites::versions::run(&super::RecordingVersions::default(), true);
    }
}
