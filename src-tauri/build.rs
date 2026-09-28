use std::env;
use std::path::PathBuf;

fn main() {
    link_crispasr_into_tests();
    build_speech_helper();
    tauri_build::build()
}

/// `notabene-speech`, the Swift helper behind the `apple-speech` transcription
/// engine (`speech/main.swift`, plan §10.3). Tauri bundles it as an external
/// binary, which it expects at `binaries/notabene-speech-{target triple}`
/// before `tauri_build` runs — so it is compiled here, from source, on every
/// build that changes it. No toolchain beyond the `swiftc` a macOS Tauri build
/// already needs, and no binary in the repository.
fn build_speech_helper() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let source = manifest.join("speech/main.swift");
    println!("cargo::rerun-if-changed={}", source.display());

    let triple = env::var("TARGET").expect("TARGET");
    let arch = if triple.starts_with("aarch64") { "arm64" } else { "x86_64" };
    let output_dir = manifest.join("binaries");
    std::fs::create_dir_all(&output_dir).expect("create binaries/");
    let output = output_dir.join(format!("notabene-speech-{triple}"));

    // macOS 13 like the app, so the helper always starts and can say it is
    // unsupported; the recogniser itself is behind `#available(macOS 26, *)`.
    let status = std::process::Command::new("xcrun")
        .args(["swiftc", "-O", "-target"])
        .arg(format!("{arch}-apple-macos13.0"))
        .arg(&source)
        .arg("-o")
        .arg(&output)
        .status()
        .expect("run swiftc for notabene-speech");
    assert!(status.success(), "swiftc failed to build notabene-speech");
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
