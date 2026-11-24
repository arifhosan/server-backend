use super::{file_name, subdirs, InstalledGame, Store};
use std::path::{Path, PathBuf};

/// Value of ` attr="..."` inside the first `<tag ...>` element. Naive: no entity decoding.
fn attr(xml: &str, tag: &str, attr: &str) -> Option<String> {
    let start = xml.find(&format!("<{tag}"))?;
    let el = &xml[start..start + xml[start..].find('>')?];
    let needle = format!(" {attr}=\"");
    let from = el.find(&needle)? + needle.len();
    let v = &el[from..from + el[from..].find('"')?];
    (!v.is_empty()).then(|| v.to_string())
}

pub fn parse_game(folder: &Path, config: Option<&str>) -> InstalledGame {
    let content = folder.join("Content");
    let cfg = config.unwrap_or("");
    InstalledGame {
        store: Store::Xbox,
        store_id: attr(cfg, "Identity", "Name"),
        title: attr(cfg, "ShellVisuals", "DefaultDisplayName")
            .or_else(|| attr(cfg, "Identity", "Name"))
            .unwrap_or_else(|| file_name(folder)),
        logo: attr(cfg, "ShellVisuals", "Square150x150Logo").map(|l| content.join(l.replace('\\', "/"))),
        install_dir: content,
    }
}

pub fn scan(drives: &[PathBuf]) -> Vec<InstalledGame> {
    drives
        .iter()
        .flat_map(|d| subdirs(&d.join("XboxGames")))
        .filter(|f| f.join("Content").is_dir())
        .map(|f| {
            let cfg = std::fs::read_to_string(f.join("Content/MicrosoftGame.config")).ok();
            parse_game(&f, cfg.as_deref())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn xbox() -> PathBuf {
        super::super::tests::fixtures().join("xbox/XboxGames")
    }

    #[test]
    fn config_title_id_and_logo() {
        let folder = xbox().join("Racer");
        let cfg = std::fs::read_to_string(folder.join("Content/MicrosoftGame.config")).unwrap();
        let g = parse_game(&folder, Some(&cfg));
        assert_eq!(g.title, "Contoso Racer");
        assert_eq!(g.store_id.as_deref(), Some("Contoso.Racer"));
        assert_eq!(g.logo, Some(folder.join("Content").join("Assets/Logo150.png")));
        assert_eq!(g.install_dir, folder.join("Content"));
    }

    #[test]
    fn identity_name_then_folder_name() {
        let f = Path::new("E:/XboxGames/Folder");
        let id_only = r#"<Game><Identity Name="Pub.Thing"/></Game>"#;
        assert_eq!(parse_game(f, Some(id_only)).title, "Pub.Thing");
        let g = parse_game(f, None);
        assert_eq!((g.title.as_str(), g.store_id, g.logo), ("Folder", None, None));
        assert_eq!(parse_game(f, Some("<<garbled")).title, "Folder");
    }
}
