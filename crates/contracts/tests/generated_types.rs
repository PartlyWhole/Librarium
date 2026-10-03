//! Fails if `src/generated/` is out of date. Run `npm run gen:types` to update it.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn read_tree(root: &Path) -> BTreeMap<PathBuf, String> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                out.insert(p.strip_prefix(root).unwrap().to_path_buf(), std::fs::read_to_string(&p).unwrap());
            }
        }
    }
    out
}

#[test]
fn generated_types_are_current() {
    let fresh = std::env::temp_dir().join(format!("librarium-types-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&fresh);
    librarium_contracts::typegen::export_types(&fresh).unwrap();
    let committed = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/generated");
    let (a, b) = (read_tree(&fresh), read_tree(&committed));
    let _ = std::fs::remove_dir_all(&fresh);
    let stale: Vec<_> = a.keys().chain(b.keys()).filter(|k| a.get(*k) != b.get(*k)).collect();
    assert!(stale.is_empty(), "src/generated is out of date (run `npm run gen:types`): {stale:?}");
}
