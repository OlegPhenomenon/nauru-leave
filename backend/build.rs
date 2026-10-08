use std::{env, fs, path::Path};
fn copy(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).unwrap();
    for entry in fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            copy(&entry.path(), &dst.join(entry.file_name()));
        } else {
            fs::copy(entry.path(), dst.join(entry.file_name())).unwrap();
        }
    }
}
fn main() {
    // Watch the parent too: restoring a previously absent dist directory can retain old mtimes.
    println!("cargo:rerun-if-changed=../frontend");
    println!("cargo:rerun-if-changed=../frontend/dist");
    let out = std::path::PathBuf::from(env::var("OUT_DIR").unwrap()).join("frontend");
    if out.exists() {
        fs::remove_dir_all(&out).unwrap();
    }
    fs::create_dir_all(&out).unwrap();
    let src = Path::new("../frontend/dist");
    if src.exists() {
        copy(src, &out);
    } else {
        fs::write(out.join("index.html"), "<!doctype html><html lang=en><title>Nauru Leave Desk</title><p>Frontend not built. Run npm ci and npm run build in frontend/.</p></html>").unwrap();
    }
    println!("cargo:rustc-env=NLD_EMBED_DIR={}", out.display());
}
