use super::{InstalledGame, Store};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Item {
    display_name: String,
    install_location: String,
    app_name: String,
}

pub fn parse_item(json: &str) -> Option<InstalledGame> {
    let i: Item = serde_json::from_str(json).ok()?;
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
    files
        .iter()
        .filter_map(|f| std::fs::read_to_string(f).ok())
        .filter_map(|t| parse_item(&t))
        .collect()
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
}
