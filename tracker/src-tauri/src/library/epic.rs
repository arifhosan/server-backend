use super::{InstalledGame, Store};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Item {
    display_name: String,
    install_location: String,
    app_name: String,
    #[serde(default, rename = "bIsIncompleteInstall")]
    incomplete: bool,
}

pub fn parse_item(json: &str) -> Option<InstalledGame> {
    let i: Item = serde_json::from_str(json.trim_start_matches('\u{feff}')).ok()?;
    if i.incomplete {
        return None;
    }
    Some(InstalledGame {
        store: Store::Epic,
        store_id: Some(i.app_name),
        title: i.display_name,
        install_dir: PathBuf::from(i.install_location),
        logo: None,
    })
}

pub fn scan(manifests: &Path) -> Vec<InstalledGame> {
    let Ok(rd) = std::fs::read_dir(manifests) else { return vec![] };
    let mut files: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "item"))
        .collect();
    files.sort();
    let mut out: Vec<InstalledGame> = vec![];
    for g in files
        .iter()
        .filter_map(|f| std::fs::read_to_string(f).ok())
        .filter_map(|t| parse_item(&t))
    {
        if !out.iter().any(|o| o.install_dir == g.install_dir) {
            out.push(g);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn item_parsed_and_bad_skipped() {
        let dir = super::super::tests::fixtures().join("epic");
        let g = parse_item(&std::fs::read_to_string(dir.join("ABC123.item")).unwrap()).unwrap();
        assert_eq!((g.title.as_str(), g.store_id.as_deref()), ("Fortnite", Some("Fortnite")));
        assert_eq!(g.install_dir, Path::new("D:\\Epic Games\\Fortnite"));
        assert!(parse_item("not json").is_none());
        assert_eq!(scan(&dir).len(), 1);
    }

    #[test]
    fn bom_incomplete_and_duplicates() {
        let j = |extra: &str| {
            format!("{{\"DisplayName\":\"G\",\"AppName\":\"a\",\"InstallLocation\":\"D:\\\\G\"{extra}}}")
        };
        assert!(parse_item(&format!("\u{feff}{}", j(""))).is_some());
        assert!(parse_item(&j(",\"bIsIncompleteInstall\":true")).is_none());
        let dir = std::env::temp_dir().join(format!("gt-epic-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.item"), j("")).unwrap();
        std::fs::write(dir.join("b.item"), j("")).unwrap();
        let n = scan(&dir).len();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(n, 1);
    }
}
