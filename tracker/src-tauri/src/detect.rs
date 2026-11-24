//! Running-game matcher: process exe paths against the installed-game index.
use crate::library::{norm, InstalledGame};
use std::path::PathBuf;

/// Crash handlers, anti-cheat, launchers and installers never count as "playing".
pub fn is_helper(exe_name: &str) -> bool {
    let n = exe_name.to_lowercase();
    n == "steamwebhelper.exe"
        || n == "dxsetup.exe"
        || ["easyanticheat", "beservice", "vc_redist"].iter().any(|p| n.starts_with(p) && n.ends_with(".exe"))
        || (n.ends_with(".exe") && ["helper", "launcher", "crash"].iter().any(|p| n.contains(p)))
}

/// One entry per game, in index order, with the first non-helper exe file name found inside its folder.
pub fn match_running(index: &[InstalledGame], exes: &[PathBuf], ignored: &[String]) -> Vec<(InstalledGame, String)> {
    let exes: Vec<(String, String)> = exes
        .iter()
        .filter_map(|p| Some((norm(p), p.file_name()?.to_string_lossy().into_owned())))
        .filter(|(_, name)| !is_helper(name))
        .collect();
    index
        .iter()
        .filter(|g| !ignored.iter().any(|i| i.eq_ignore_ascii_case(&g.title)))
        .filter_map(|g| {
            let dir = format!("{}\\", norm(&g.install_dir));
            let (_, name) = exes.iter().find(|(p, _)| p.starts_with(&dir))?;
            Some((g.clone(), name.clone()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::Store;

    fn game(store: Store, title: &str, dir: &str) -> InstalledGame {
        InstalledGame { store, store_id: None, title: title.into(), install_dir: dir.into(), logo: None }
    }
    fn cp() -> InstalledGame {
        game(Store::Steam, "Cyberpunk 2077", "D:/Steam/steamapps/common/Cyberpunk 2077")
    }
    fn run(index: &[InstalledGame], exes: &[&str], ignored: &[&str]) -> Vec<(String, String)> {
        let exes: Vec<PathBuf> = exes.iter().map(PathBuf::from).collect();
        let ignored: Vec<String> = ignored.iter().map(|s| s.to_string()).collect();
        match_running(index, &exes, &ignored).into_iter().map(|(g, e)| (g.title, e)).collect()
    }

    #[test]
    fn exe_in_game_folder_matches() {
        let got = run(&[cp()], &["D:/Steam/steamapps/common/Cyberpunk 2077/bin/x64/Cyberpunk2077.exe"], &[]);
        assert_eq!(got, [("Cyberpunk 2077".to_string(), "Cyberpunk2077.exe".to_string())]);
    }

    #[test]
    fn unrelated_folder_and_sibling_prefix_do_not_match() {
        assert!(run(&[cp()], &["C:/Windows/notepad.exe"], &[]).is_empty());
        assert!(run(&[cp()], &["D:/Steam/steamapps/common/Cyberpunk 2077 Demo/a.exe"], &[]).is_empty());
    }

    #[test]
    fn helper_alone_is_not_playing() {
        let p = "D:/Steam/steamapps/common/Cyberpunk 2077/UnityCrashHandler64.exe";
        assert!(run(&[cp()], &[p], &[]).is_empty());
    }

    #[test]
    fn game_plus_helper_is_one_entry() {
        let d = "D:/Steam/steamapps/common/Cyberpunk 2077//";
        let got = run(&[cp()], &[&format!("{d}UnityCrashHandler64.exe"), &format!("{d}a.exe"), &format!("{d}b.exe")], &[]);
        assert_eq!(got, [("Cyberpunk 2077".to_string(), "a.exe".to_string())]);
    }

    #[test]
    fn two_games_two_entries() {
        let idx = [cp(), game(Store::Epic, "Fortnite", "C:/Epic/Fortnite")];
        let got = run(&idx, &["C:/Epic/Fortnite/f.exe", "D:/Steam/steamapps/common/Cyberpunk 2077/c.exe"], &[]);
        assert_eq!(got.len(), 2);
    }

    #[test]
    fn ignored_title_is_skipped() {
        let p = "D:/Steam/steamapps/common/Cyberpunk 2077/c.exe";
        assert!(run(&[cp()], &[p], &["cyberpunk 2077"]).is_empty());
    }

    #[test]
    fn path_case_and_slashes_normalized() {
        assert_eq!(run(&[cp()], &["d:/STEAM/steamapps/COMMON/cyberpunk 2077/C.exe"], &[]).len(), 1);
    }

    #[test]
    fn helper_list() {
        for h in ["UnityCrashHandler32.exe", "crashreportclient.EXE", "EasyAntiCheat_EOS.exe", "BEService_x64.exe", "MyHelper.exe", "Launcher.exe", "steamwebhelper.exe", "vc_redist.x64.exe", "DXSETUP.exe"] {
            assert!(is_helper(h), "{h}");
        }
        assert!(!is_helper("Cyberpunk2077.exe"));
    }
}
