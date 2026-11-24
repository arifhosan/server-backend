//! Installed-game index. Pure parsers take strings or paths; only `Roots::detect` touches the system.
mod epic;
mod steam;
mod xbox;

use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Store {
    Steam,
    Xbox,
    Epic,
    Other,
}

impl Store {
    pub fn as_str(self) -> &'static str {
        match self {
            Store::Steam => "steam",
            Store::Xbox => "xbox",
            Store::Epic => "epic",
            Store::Other => "other",
        }
    }
}

/// Same-directory key: backslashes, lowercase, no trailing separator.
pub fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstalledGame {
    pub store: Store,
    pub store_id: Option<String>,
    pub title: String,
    pub install_dir: PathBuf,
    pub logo: Option<PathBuf>,
}

pub struct Roots {
    pub steam: Option<PathBuf>,
    pub drives: Vec<PathBuf>,
    pub epic_manifests: PathBuf,
    pub fallback: Vec<PathBuf>,
}

impl Roots {
    pub fn detect() -> Roots {
        let drives: Vec<PathBuf> = (b'A'..=b'Z')
            .map(|c| PathBuf::from(format!("{}:\\", c as char)))
            .filter(|d| d.exists())
            .collect();
        let steam = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .open_subkey("Software\\Valve\\Steam")
            .and_then(|k| k.get_value::<String, _>("SteamPath"))
            .ok()
            .map(PathBuf::from);
        let program_data = std::env::var_os("ProgramData").unwrap_or_else(|| "C:\\ProgramData".into());
        let mut bases = drives.clone();
        for v in ["ProgramFiles", "ProgramFiles(x86)"] {
            bases.extend(std::env::var_os(v).map(PathBuf::from));
        }
        let fallback = bases
            .iter()
            .flat_map(|b| ["Ubisoft Game Launcher\\games", "EA Games", "GOG Galaxy\\Games"].map(|s| b.join(s)))
            .collect();
        Roots {
            steam,
            drives,
            epic_manifests: PathBuf::from(program_data).join("Epic\\EpicGamesLauncher\\Data\\Manifests"),
            fallback,
        }
    }
}

pub fn build_index(roots: &Roots) -> Vec<InstalledGame> {
    let mut out = steam::scan(roots.steam.as_deref());
    out.extend(xbox::scan(&roots.drives));
    out.extend(epic::scan(&roots.epic_manifests));
    for dir in &roots.fallback {
        out.extend(subdirs(dir).into_iter().map(|p| InstalledGame {
            store: Store::Other,
            store_id: None,
            title: file_name(&p),
            install_dir: p,
            logo: None,
        }));
    }
    out
}

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut v: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    v.sort();
    v
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    pub fn fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
    }

    #[test]
    fn index_combines_stores_and_fallback() {
        // A Steam library on a second drive is found through libraryfolders.vdf.
        let tmp = std::env::temp_dir().join(format!("gt-lib-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let main = tmp.join("Steam");
        let second = tmp.join("SteamLibrary");
        fs::create_dir_all(main.join("steamapps")).unwrap();
        fs::create_dir_all(second.join("steamapps")).unwrap();
        let esc = |p: &Path| p.to_string_lossy().replace('\\', "\\\\");
        fs::write(
            main.join("steamapps/libraryfolders.vdf"),
            format!(
                "\"libraryfolders\"\n{{\n\"0\"\n{{\n\"path\"\t\t\"{}\"\n}}\n\"1\"\n{{\n\"path\"\t\t\"{}\"\n}}\n}}\n",
                esc(&main),
                esc(&second)
            ),
        )
        .unwrap();
        fs::copy(
            fixtures().join("steam/appmanifest_1091500.acf"),
            second.join("steamapps/appmanifest_1091500.acf"),
        )
        .unwrap();
        fs::create_dir_all(tmp.join("EA Games/Apex")).unwrap();

        let idx = build_index(&Roots {
            steam: Some(main),
            drives: vec![fixtures().join("xbox")],
            epic_manifests: fixtures().join("epic"),
            fallback: vec![tmp.join("EA Games"), tmp.join("missing")],
        });
        let _ = fs::remove_dir_all(&tmp);
        let got: Vec<_> = idx.iter().map(|g| (g.store, g.title.as_str())).collect();
        assert_eq!(
            got,
            [
                (Store::Steam, "Cyberpunk 2077"),
                (Store::Xbox, "NoConfig"),
                (Store::Xbox, "Contoso Racer"),
                (Store::Epic, "Fortnite"),
                (Store::Other, "Apex"),
            ]
        );
    }

    #[test]
    fn missing_everything_is_empty() {
        let idx = build_index(&Roots {
            steam: Some("Z:/nope".into()),
            drives: vec!["Z:/nope".into()],
            epic_manifests: "Z:/nope".into(),
            fallback: vec![],
        });
        assert!(idx.is_empty());
    }
}
