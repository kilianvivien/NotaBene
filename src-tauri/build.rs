use std::env;
use std::path::PathBuf;

fn main() {
    link_crispasr_into_tests();
    tauri_build::build()
}

/// `crispasr-sys` emits its rpaths as `rustc-link-arg`, which only ever applies
/// to that package's own targets — nothing propagates them to ours. The app
/// binary still loads because Tauri gives it `@executable_path/../Frameworks`,
/// but the unit-test harness gets no rpath at all, so a plain `cargo test`
/// aborts at load with a missing `libcrispasr.1.dylib`.
///
/// The unit tests live in the lib target rather than in `tests/`, so there is no
/// test target for `rustc-link-arg-tests` to attach to; the unqualified form is
/// what reaches that harness. It reaches the app binary too, which is why this
/// is confined to the dev profile — a release bundle must not carry an rpath
/// pointing into whichever machine happened to build it.
fn link_crispasr_into_tests() {
    // In a build script `cfg!(target_os)` describes the host, not the target.
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    if env::var("PROFILE").as_deref() != Ok("debug") {
        return;
    }

    // `.cargo/config.toml` sets this with `relative = true`, so cargo hands it
    // to us already absolute. The dylibs sit one level down, in `src/`.
    let lib_dir = env::var_os("CRISPASR_SYS_LIB_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
                .join("native/crispasr/arm64")
        });

    println!("cargo::rerun-if-env-changed=CRISPASR_SYS_LIB_DIR");
    println!(
        "cargo::rustc-link-arg=-Wl,-rpath,{}",
        lib_dir.join("src").display()
    );
}
