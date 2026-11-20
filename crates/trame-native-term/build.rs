use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=GHOSTTY_VT_DIR");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("linux") {
        return;
    }
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    // a `zig build -Demit-lib-vt --prefix <dir>` install of libghostty-vt
    let dir = std::env::var("GHOSTTY_VT_DIR").map_or_else(
        |_| manifest.join("../../.scratch/ghostty-vt"),
        PathBuf::from,
    );
    let include = dir.join("include");
    println!(
        "cargo:rustc-link-search=native={}",
        dir.join("lib").display()
    );
    println!("cargo:rustc-link-lib=static=ghostty-vt");
    println!(
        "cargo:rerun-if-changed={}",
        include.join("ghostty/vt.h").display()
    );
    bindgen::Builder::default()
        .header(include.join("ghostty/vt.h").to_string_lossy())
        .clang_arg(format!("-I{}", include.display()))
        .clang_arg("-DGHOSTTY_STATIC")
        .allowlist_function("ghostty_.*")
        .allowlist_type("Ghostty.*")
        .allowlist_var("GHOSTTY_.*")
        .default_enum_style(bindgen::EnumVariation::Consts)
        .prepend_enum_name(false)
        .layout_tests(false)
        .generate()
        .expect("bindgen libghostty-vt")
        .write_to_file(PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("vt.rs"))
        .unwrap();
}
