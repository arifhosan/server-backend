use super::{file_name, InstalledGame, Store};
use std::path::{Path, PathBuf};

/// The two quoted strings of a `"key"<ws>"value"` line, `\\` and `\"` unescaped.
/// Anything else (braces, section headers, garbage) yields None.
fn pair(line: &str) -> Option<(String, String)> {
    let mut parts = vec![];
    let (mut cur, mut inside, mut esc) = (String::new(), false, false);
    for c in line.chars() {
        match (inside, esc, c) {
            (false, _, '"') => inside = true,
            (false, _, c) if c.is_whitespace() => {}
            (false, _, _) => return None,
            (true, true, c) => {
                cur.push(c);
                esc = false;
            }
            (true, false, '\\') => esc = true,
            (true, false, '"') => {
                parts.push(std::mem::take(&mut cur));
                inside = false;
            }
            (true, false, c) => cur.push(c),
        }
    }
    match (inside, parts.len()) {
        (false, 2) => Some((parts.remove(0), parts.remove(0))),
        _ => None,
    }
}

fn all_kv(text: &str, key: &str) -> Vec<String> {
    text.lines()
        .filter_map(pair)
        .filter(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v)
        .collect()
}

pub fn library_paths(vdf: &str) -> Vec<PathBuf> {
    all_kv(vdf, "path").into_iter().map(PathBuf::from).collect()
}

pub fn parse_manifest(acf: &str, library: &Path) -> Option<InstalledGame> {
    let first = |k| all_kv(acf, k).into_iter().next();
    let (id, dir) = (first("appid")?, first("installdir")?);
    // 228980 = Steamworks Common Redistributables
    if dir.trim().is_empty() || id == "228980" {
        return None;
    }
    Some(InstalledGame {
        store: Store::Steam,
        store_id: Some(id),
        title: first("name")?,
        install_dir: library.join("steamapps").join("common").join(dir),
        logo: None,
    })
}

/// Same-directory key: backslashes, lowercase, no trailing separator.
fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

pub fn scan(steam: Option<&Path>) -> Vec<InstalledGame> {
    let Some(root) = steam else { return vec![] };
    let mut libs = vec![root.to_path_buf()];
    if let Ok(vdf) = std::fs::read_to_string(root.join("steamapps/libraryfolders.vdf")) {
        for p in library_paths(&vdf) {
            if !libs.iter().any(|l| norm(l) == norm(&p)) {
                libs.push(p);
            }
        }
    }
    let mut out = vec![];
    for lib in libs {
        let Ok(rd) = std::fs::read_dir(lib.join("steamapps")) else { continue };
        let mut files: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                let n = file_name(p);
                n.starts_with("appmanifest_") && n.ends_with(".acf")
            })
            .collect();
        files.sort();
        // non-UTF-8 files fail read_to_string and are skipped
        out.extend(
            files
                .iter()
                .filter_map(|f| std::fs::read_to_string(f).ok())
                .filter_map(|t| parse_manifest(&t, &lib)),
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fx(name: &str) -> String {
        std::fs::read_to_string(super::super::tests::fixtures().join("steam").join(name)).unwrap()
    }

    #[test]
    fn two_libraries_from_vdf() {
        assert_eq!(
            library_paths(&fx("libraryfolders.vdf")),
            [PathBuf::from("C:\\Program Files (x86)\\Steam"), PathBuf::from("D:\\SteamLibrary")]
        );
    }

    #[test]
    fn manifest_parsed() {
        let g = parse_manifest(&fx("appmanifest_1091500.acf"), Path::new("D:/SteamLibrary")).unwrap();
        assert_eq!(g.store_id.as_deref(), Some("1091500"));
        assert_eq!(g.title, "Cyberpunk 2077");
        assert_eq!(g.install_dir, Path::new("D:/SteamLibrary/steamapps/common/Cyberpunk 2077"));
    }

    #[test]
    fn redist_and_empty_installdir_skipped() {
        let acf = |id: &str, dir: &str| format!("\"AppState\"\n{{\n\"appid\" \"{id}\"\n\"name\" \"X\"\n\"installdir\" \"{dir}\"\n}}");
        assert!(parse_manifest(&acf("228980", "Steamworks Shared"), Path::new("D:/x")).is_none());
        assert!(parse_manifest(&acf("5", ""), Path::new("D:/x")).is_none());
    }

    #[test]
    fn duplicate_library_and_non_utf8_skipped() {
        let tmp = std::env::temp_dir().join(format!("gt-steam-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let apps = tmp.join("Steam/steamapps");
        std::fs::create_dir_all(&apps).unwrap();
        let real = tmp.join("Steam").to_string_lossy().replace('\\', "\\\\");
        std::fs::write(apps.join("libraryfolders.vdf"), format!("\"libraryfolders\"\n{{\n\"0\"\n{{\n\"path\" \"{real}\"\n}}\n}}\n")).unwrap();
        std::fs::copy(super::super::tests::fixtures().join("steam/appmanifest_1091500.acf"), apps.join("appmanifest_1091500.acf")).unwrap();
        std::fs::write(apps.join("appmanifest_9.acf"), [0xff, 0xfe, 0x00, 0xc3]).unwrap();
        // registry-style root: forward slashes, lowercase, trailing slash
        let reg = PathBuf::from(format!("{}/", tmp.join("Steam").to_string_lossy().replace('\\', "/").to_lowercase()));
        let n = scan(Some(&reg)).len();
        let _ = std::fs::remove_dir_all(&tmp);
        assert_eq!(n, 1);
    }

    #[test]
    fn garbled_manifest_skipped() {
        assert!(parse_manifest(&fx("appmanifest_1.acf"), Path::new("D:/x")).is_none());
        assert!(parse_manifest("", Path::new("D:/x")).is_none());
    }
}
