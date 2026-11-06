fn main() {
    let mut windows = tauri_build::WindowsAttributes::new();

    // Tauri embeds its Windows manifest only into binaries, so `cargo test` executables
    // that link Tauri crash with STATUS_ENTRYPOINT_NOT_FOUND. Embed our own manifest
    // into every target instead (MSVC only).

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();

    if target_os == "windows" && target_env == "msvc" {
        windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        let manifest = std::env::current_dir()
            .expect("current dir")
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed=windows-app-manifest.xml");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        println!("cargo:rustc-link-arg=/WX");
    }

    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run tauri-build");
}
