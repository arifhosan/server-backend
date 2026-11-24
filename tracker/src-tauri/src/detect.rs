//! Running-game matcher: process exe paths against the installed-game index.
use crate::library::{norm, InstalledGame};
use crate::state::RunningGame;
use chrono::{DateTime, Utc};
use std::path::PathBuf;

/// Matches become `RunningGame`s. A game keeps its `started_at` from `prev` unless `gap_reset` (the polls were so far
/// apart that the PC slept; the backend starts a new session after such a gap, so the timer must too).
pub fn to_playing(found: Vec<(InstalledGame, PathBuf)>, prev: &[RunningGame], now: DateTime<Utc>, gap_reset: bool) -> Vec<RunningGame> {
    found
        .into_iter()
        .map(|(g, exe_path)| {
            let key = format!("{}:{}", g.store.as_str(), g.store_id.as_deref().unwrap_or(&g.title));
            let started_at = prev.iter().find(|r| r.key == key).filter(|_| !gap_reset).map_or(now, |r| r.started_at);
            let exe = exe_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            RunningGame { key, store: g.store, store_id: g.store_id, title: g.title, exe, exe_path, logo: g.logo, started_at }
        })
        .collect()
}

/// Crash handlers, anti-cheat, launchers and installers never count as "playing".
pub fn is_helper(exe_name: &str) -> bool {
    let n = exe_name.to_lowercase();
    n == "steamwebhelper.exe"
        || n == "dxsetup.exe"
        || ["easyanticheat", "beservice", "vc_redist"].iter().any(|p| n.starts_with(p) && n.ends_with(".exe"))
        || n == "crashpad_handler.exe"
        || (n.ends_with(".exe") && ["helper", "launcher", "crashhandler", "crashreport", "crashsender"].iter().any(|p| n.contains(p)))
}

/// One entry per game, in index order, with the full path of the first non-helper exe found inside its folder.
pub fn match_running(index: &[InstalledGame], exes: &[PathBuf], ignored: &[String]) -> Vec<(InstalledGame, PathBuf)> {
    let exes: Vec<(String, &PathBuf)> = exes
        .iter()
        .filter(|p| p.file_name().is_some_and(|n| !is_helper(&n.to_string_lossy())))
        .map(|p| (norm(p), p))
        .collect();
    index
        .iter()
        .filter(|g| !ignored.iter().any(|i| i.eq_ignore_ascii_case(&g.title)))
        .filter_map(|g| {
            let dir = format!("{}\\", norm(&g.install_dir));
            let (_, path) = exes.iter().find(|(p, _)| p.starts_with(&dir))?;
            Some((g.clone(), (*path).clone()))
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
        match_running(index, &exes, &ignored)
            .into_iter()
            .map(|(g, e)| (g.title, e.file_name().unwrap().to_string_lossy().into_owned()))
            .collect()
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
    fn match_carries_full_exe_path() {
        let p = PathBuf::from("D:/Steam/steamapps/common/Cyberpunk 2077/bin/x64/Cyberpunk2077.exe");
        let got = match_running(&[cp()], &[p.clone()], &[]);
        assert_eq!(got[0].1, p);
        let r = to_playing(got, &[], Utc::now(), false);
        assert_eq!((r[0].exe.as_str(), &r[0].exe_path), ("Cyberpunk2077.exe", &p));
    }

    #[test]
    fn session_start_kept_unless_poll_gap() {
        use chrono::Duration;
        let t0 = Utc::now() - Duration::hours(2);
        let found = || vec![(cp(), PathBuf::from("D:/Steam/steamapps/common/Cyberpunk 2077/c.exe"))];
        let prev = to_playing(found(), &[], t0, false);
        let now = Utc::now();
        assert_eq!(to_playing(found(), &prev, now, false)[0].started_at, t0);
        assert_eq!(to_playing(found(), &prev, now, true)[0].started_at, now);
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
        for h in ["UnityCrashHandler32.exe", "crashreportclient.EXE", "crashpad_handler.exe", "CrashSender1403.exe", "EasyAntiCheat_EOS.exe", "BEService_x64.exe", "MyHelper.exe", "Launcher.exe", "steamwebhelper.exe", "vc_redist.x64.exe", "DXSETUP.exe"] {
            assert!(is_helper(h), "{h}");
        }
        assert!(!is_helper("Cyberpunk2077.exe"));
        assert!(!is_helper("CrashBandicootNSaneTrilogy.exe"));
    }
}
