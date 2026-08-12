use std::path::{Path, PathBuf};

fn main() {
    embed_credentials();
    tauri_build::build()
}

// The OAuth desktop client is baked into the binary, but a clone of this repo has no
// google-credentials.json. Embedding the example file instead of failing the build turns a
// confusing compile error into the runtime "not set up yet" message from load_credentials.
fn embed_credentials() {
    let root: PathBuf = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("manifest dir has a parent")
        .to_path_buf();
    let real = root.join("google-credentials.json");
    let example = root.join("google-credentials.example.json");

    println!("cargo:rerun-if-changed={}", real.display());
    println!("cargo:rerun-if-changed={}", example.display());

    let source = if real.exists() { &real } else { &example };
    let contents = std::fs::read(source)
        .unwrap_or_else(|e| panic!("could not read {}: {e}", source.display()));

    let out = Path::new(&std::env::var("OUT_DIR").expect("OUT_DIR is set"))
        .join("google-credentials.json");
    std::fs::write(&out, contents).expect("could not write embedded credentials");
}
