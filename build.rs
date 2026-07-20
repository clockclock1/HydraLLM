use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let assets_dir = manifest_dir.join("assets");
    println!("cargo:rerun-if-changed={}", assets_dir.display());

    let mut files = Vec::new();
    collect_assets(&assets_dir, &assets_dir, &mut files);
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let mut generated = String::from(
        "fn embedded_asset(path: &str) -> Option<(&'static [u8], &'static str)> {\n    match path {\n",
    );

    for (relative, absolute) in files {
        generated.push_str(&format!(
            "        {:?} => Some((include_bytes!({:?}), {:?})),\n",
            relative,
            absolute.to_string_lossy(),
            content_type(&relative)
        ));
    }

    generated.push_str("        _ => None,\n    }\n}\n");
    fs::write(out_dir.join("embedded_assets.rs"), generated).expect("write embedded assets map");
}

fn collect_assets(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_assets(root, &path, out);
        } else if path.is_file() {
            let relative = path
                .strip_prefix(root)
                .expect("asset path under root")
                .to_string_lossy()
                .replace('\\', "/");
            println!("cargo:rerun-if-changed={}", path.display());
            out.push((relative, path));
        }
    }
}

fn content_type(path: &str) -> &'static str {
    if path.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if path.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if path.ends_with(".js") {
        "application/javascript; charset=utf-8"
    } else if path.ends_with(".json") {
        "application/json; charset=utf-8"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        "image/jpeg"
    } else if path.ends_with(".webp") {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}
