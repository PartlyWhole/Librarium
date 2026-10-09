//! Writes `src/types.ts` from the backend's types: `cargo test export_types`.

#[test]
fn export_types() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/types.ts");
    std::fs::create_dir_all(std::path::Path::new(path).parent().unwrap()).unwrap();
    std::fs::write(path, librarium::types::typescript()).unwrap();
}
