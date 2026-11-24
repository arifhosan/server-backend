use serde::{Deserialize, Serialize};
use std::{io, path::{Path, PathBuf}};

pub const DEFAULT_SERVER_URL: &str = "https://games.server.arifhosan.me/api";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct Settings {
    pub server_url: String,
    pub start_with_windows: bool,
    pub paused: bool,
    /// ignored game titles
    pub ignored: Vec<String>,
    /// game keys whose icon was already sent
    pub sent_icons: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            server_url: DEFAULT_SERVER_URL.into(),
            start_with_windows: true,
            paused: false,
            ignored: vec![],
            sent_icons: vec![],
        }
    }
}

impl Settings {
    pub fn load(dir: &Path) -> Settings {
        let path = dir.join("settings.json");
        let Ok(text) = std::fs::read_to_string(&path) else { return Settings::default() };
        serde_json::from_str(&text).unwrap_or_else(|_| {
            // keep the corrupt file for inspection instead of silently overwriting it
            let _ = std::fs::rename(&path, dir.join("settings.json.bad"));
            Settings::default()
        })
    }

    /// Atomic: write a temp file in the same dir, then rename over the target.
    pub fn save(&self, dir: &Path) -> io::Result<()> {
        std::fs::create_dir_all(dir)?;
        let tmp = dir.join("settings.json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self)?)?;
        std::fs::rename(&tmp, dir.join("settings.json"))
    }
}

/// `%APPDATA%\GameTracker`
pub fn config_dir() -> PathBuf {
    std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_default().join("GameTracker")
}

/// Server URL with a trailing `/api` (and slash) removed.
pub fn dashboard_url(server_url: &str) -> String {
    let s = server_url.trim_end_matches('/');
    s.strip_suffix("/api").unwrap_or(s).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gt-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn missing_dir_gives_defaults() {
        let s = Settings::load(&tmp("missing"));
        assert_eq!(s.server_url, DEFAULT_SERVER_URL);
        assert!(s.start_with_windows);
    }

    #[test]
    fn round_trip() {
        let d = tmp("rt");
        let s = Settings { server_url: "http://x/api".into(), start_with_windows: false, paused: true, ignored: vec!["A".into()], sent_icons: vec!["steam:1".into()] };
        s.save(&d).unwrap();
        assert_eq!(Settings::load(&d), s);
        assert!(!d.join("settings.json.tmp").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn corrupt_json_gives_defaults() {
        let d = tmp("bad");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("settings.json"), "{nope").unwrap();
        assert_eq!(Settings::load(&d), Settings::default());
        assert!(d.join("settings.json.bad").exists());
        assert!(!d.join("settings.json").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn dashboard_url_strips_api() {
        assert_eq!(dashboard_url("https://games.server.arifhosan.me/api"), "https://games.server.arifhosan.me");
        assert_eq!(dashboard_url("https://games.server.arifhosan.me/api/"), "https://games.server.arifhosan.me");
    }
}
