//! VersionStore port while history is off (BRIEF §9): records nothing, has no history.

use librarium_contracts::ports::VersionStore;
use librarium_contracts::Result;

pub struct NoVersions;

impl VersionStore for NoVersions {
    fn recorded(&self, _path: &str, _bytes: &[u8]) -> Result<()> {
        Ok(())
    }
    fn history(&self, _path: &str) -> Result<Vec<String>> {
        Ok(vec![])
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn passes_the_shared_suite() {
        librarium_testkit::suites::versions::run(&super::NoVersions, false);
    }
}
