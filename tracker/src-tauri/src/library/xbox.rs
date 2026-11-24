use super::{file_name, subdirs, InstalledGame, Store};
use std::path::{Component, Path, PathBuf};

fn attr(doc: &roxmltree::Document, el: &str, name: &str) -> Option<String> {
    let v = doc
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name() == el)?
        .attribute(name)?
        .trim();
    (!v.is_empty()).then(|| v.to_string())
}

/// Relative, non-escaping logo path only.
fn safe_logo(content: &Path, l: &str) -> Option<PathBuf> {
    let p = PathBuf::from(l.replace('\\', "/"));
    p.components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
        .then(|| content.join(p))
}

pub fn parse_game(folder: &Path, config: Option<&str>) -> InstalledGame {
    let content = folder.join("Content");
    let doc = config.and_then(|c| roxmltree::Document::parse(c.trim_start_matches('\u{feff}')).ok());
    let a = |el, name| doc.as_ref().and_then(|d| attr(d, el, name));
    let id = a("Identity", "Name");
    InstalledGame {
        store: Store::Xbox,
        store_id: id.clone(),
        title: a("ShellVisuals", "DefaultDisplayName")
            .filter(|t| !t.starts_with("ms-resource:"))
            .or(id)
            .unwrap_or_else(|| file_name(folder)),
        logo: a("ShellVisuals", "Square150x150Logo").and_then(|l| safe_logo(&content, &l)),
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

    #[test]
    fn entities_comments_single_quotes_multiline() {
        let f = Path::new("E:/XboxGames/Folder");
        let cfg = "<Game>
<!-- <ShellVisuals DefaultDisplayName=\"Old\"/> -->
<IdentityFoo Name=\"Bad\"/>
<Identity
  Publisher='P'
  Name='Pub.Thing'/>
<ShellVisuals
  DefaultDisplayName='Tom &amp; Jerry&apos;s &gt; X'
  Square150x150Logo=\"a.png\"/></Game>";
        let g = parse_game(f, Some(cfg));
        assert_eq!(g.title, "Tom & Jerry's > X");
        assert_eq!(g.store_id.as_deref(), Some("Pub.Thing"));
        let only_comment = "<Game><!-- <ShellVisuals DefaultDisplayName=\"Old\"/> --></Game>";
        assert_eq!(parse_game(f, Some(only_comment)).title, "Folder");
    }

    #[test]
    fn ms_resource_title_and_unsafe_logo() {
        let f = Path::new("E:/XboxGames/Folder");
        let cfg = |logo: &str| {
            format!(
                "<Game><Identity Name=\"Pub.Thing\"/><ShellVisuals DefaultDisplayName=\"ms-resource:Name\" Square150x150Logo=\"{logo}\"/></Game>"
            )
        };
        assert_eq!(parse_game(f, Some(&cfg("..\\x.png"))).logo, None);
        assert_eq!(parse_game(f, Some(&cfg("C:\\x.png"))).logo, None);
        let g = parse_game(f, Some(&cfg("Assets\\l.png")));
        assert_eq!(g.title, "Pub.Thing");
        assert!(g.logo.is_some());
    }
}
