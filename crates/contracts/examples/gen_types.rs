//! Regenerates `src/generated/`: `npm run gen:types`.
fn main() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/generated");
    let _ = std::fs::remove_dir_all(&dir);
    librarium_contracts::typegen::export_types(&dir).expect("export types");
    println!("wrote {}", dir.display());
}
