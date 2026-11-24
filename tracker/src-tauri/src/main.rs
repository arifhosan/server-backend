#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod detect;
mod icons;
mod library;
mod queue;
mod sender;
mod settings;
mod state;
mod token;

use serde::Serialize;
use settings::{config_dir, dashboard_url, Settings};
use state::{AppState, Connection, RunningGame};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WebviewWindow,
};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_opener::OpenerExt as _;

type Res<T = ()> = Result<T, String>;

trait LockOk<T> {
    fn lock_ok(&self) -> std::sync::MutexGuard<'_, T>;
}
impl<T> LockOk<T> for Mutex<T> {
    /// Lock without panicking on a poisoned mutex.
    fn lock_ok(&self) -> std::sync::MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|e| e.into_inner())
    }
}

struct Shared {
    state: Mutex<AppState>,
    settings: Mutex<Settings>,
}

struct Tray {
    icon: TrayIcon,
    pause: MenuItem<tauri::Wry>,
}

#[derive(Serialize)]
struct SettingsView {
    server_url: String,
    start_with_windows: bool,
    ignored: Vec<String>,
    token_masked: Option<String>,
}

/// Emit `state` to the UI and sync the tray icon and menu. Call after every state change.
fn publish(app: &AppHandle) {
    let st = app.state::<Shared>().state.lock_ok().clone();
    let _ = app.emit("state", &st);
    if let Some(t) = app.try_state::<Tray>() {
        let bytes: &[u8] = if st.playing.is_empty() {
            include_bytes!("../icons/tray-idle.png")
        } else {
            include_bytes!("../icons/tray-playing.png")
        };
        if let Ok(img) = Image::from_bytes(bytes) {
            let _ = t.icon.set_icon(Some(img));
        }
        let _ = t.pause.set_text(if st.paused { "Resume" } else { "Pause" });
    }
}

fn apply_paused(app: &AppHandle, paused: bool) -> Res {
    let shared = app.state::<Shared>();
    {
        let mut s = shared.settings.lock_ok();
        let mut next = s.clone();
        next.paused = paused;
        next.save(&config_dir()).map_err(|e| e.to_string())?;
        *s = next;
    }
    {
        let mut st = shared.state.lock_ok();
        st.paused = paused;
        if paused {
            st.playing.clear(); // pausing stops reporting: nothing is "playing" any more
        }
    }
    publish(app);
    Ok(())
}

fn apply_autostart(app: &AppHandle, on: bool) -> Res {
    let al = app.autolaunch();
    (if on { al.enable() } else { al.disable() }).map_err(|e| e.to_string())
}

fn show_window(w: &WebviewWindow) {
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
}

#[tauri::command]
fn get_state(shared: State<Shared>) -> AppState {
    shared.state.lock_ok().clone()
}

#[tauri::command]
fn get_settings(shared: State<Shared>) -> SettingsView {
    let s = shared.settings.lock_ok();
    SettingsView {
        server_url: s.server_url.clone(),
        start_with_windows: s.start_with_windows,
        ignored: s.ignored.clone(),
        token_masked: token::get().map(|t| token::mask(&t)),
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, server_url: String, start_with_windows: bool) -> Res {
    let url = server_url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Server URL must start with http:// or https://".into());
    }
    {
        let shared = app.state::<Shared>();
        let mut s = shared.settings.lock_ok();
        s.server_url = url.to_string();
        s.start_with_windows = start_with_windows;
        s.save(&config_dir()).map_err(|e| e.to_string())?;
    }
    apply_autostart(&app, start_with_windows)
}

#[tauri::command]
fn set_token(app: AppHandle, token: String) -> Res {
    let t = token.trim();
    if t.is_empty() {
        return Err("Token is empty".into());
    }
    token::set(t).map_err(|e| e.to_string())?;
    app.state::<Shared>().state.lock_ok().connection = Connection::Ok { last_sent_at: None };
    publish(&app);
    let _ = app.state::<sender::Wake>().0.send(());
    Ok(())
}

#[tauri::command]
fn remove_token(app: AppHandle) -> Res {
    token::clear().map_err(|e| e.to_string())?;
    app.state::<Shared>().state.lock_ok().connection = Connection::NoToken;
    publish(&app);
    Ok(())
}

#[tauri::command]
fn set_paused(app: AppHandle, paused: bool) -> Res {
    apply_paused(&app, paused)
}

#[tauri::command]
fn unignore(shared: State<Shared>, title: String) -> Res {
    let mut s = shared.settings.lock_ok();
    s.ignored.retain(|t| *t != title);
    s.save(&config_dir()).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_dashboard(app: AppHandle, path: String) -> Res {
    if !path.starts_with('/') {
        return Err("path must start with /".into());
    }
    let base = dashboard_url(&app.state::<Shared>().settings.lock_ok().server_url);
    app.opener().open_url(format!("{base}{path}"), None::<&str>).map_err(|e| e.to_string())
}

/// Every 15 s (skipped while paused): running exes -> matched games -> `AppState.playing`. Index rebuilt every 10 min.
fn start_detection(app: AppHandle) {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    std::thread::spawn(move || {
        let Ok(mut sys) = System::new() else { return };
        let mut index = Vec::new();
        let mut indexed_at: Option<Instant> = None;
        loop {
            if indexed_at.is_none_or(|t| t.elapsed() >= Duration::from_secs(600)) {
                index = library::build_index(&library::Roots::detect());
                indexed_at = Some(Instant::now());
            }
            let shared = app.state::<Shared>();
            if !shared.state.lock_ok().paused {
                sys.refresh_processes_specifics(
                    ProcessesToUpdate::All,
                    true,
                    ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
                );
                let exes: Vec<_> = sys.processes().values().filter_map(|p| p.exe().map(|e| e.to_path_buf())).collect();
                let ignored = shared.settings.lock_ok().ignored.clone();
                let found = detect::match_running(&index, &exes, &ignored);
                {
                    let mut st = shared.state.lock_ok();
                    let now = chrono::Utc::now();
                    let playing = found
                        .into_iter()
                        .map(|(g, exe)| {
                            let key = format!("{}:{}", g.store.as_str(), g.store_id.as_deref().unwrap_or(&g.title));
                            let started_at = st.playing.iter().find(|r| r.key == key).map_or(now, |r| r.started_at);
                            RunningGame { key, store: g.store, store_id: g.store_id, title: g.title, exe, logo: g.logo, started_at }
                        })
                        .collect();
                    if !st.paused {
                        st.playing = playing; // pause may have been hit while scanning
                    }
                }
                publish(&app);
            }
            std::thread::sleep(Duration::from_secs(15));
        }
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                show_window(&w);
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_state, get_settings, save_settings, set_token, remove_token, set_paused, unignore, open_dashboard
        ])
        .on_window_event(|w, ev| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                api.prevent_close();
                let _ = w.hide();
            }
        })
        .setup(|app| {
            let settings = Settings::load(&config_dir());
            let _ = apply_autostart(app.handle(), settings.start_with_windows); // startup: UI shows errors on save
            let paused = settings.paused;
            app.manage(Shared {
                state: Mutex::new(AppState::new(token::get().is_some(), paused)),
                settings: Mutex::new(settings),
            });

            sender::spawn(app.handle().clone(), config_dir());

            let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", if paused { "Resume" } else { "Pause" }, true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &pause, &quit])?;
            let icon = TrayIconBuilder::new()
                .icon(Image::from_bytes(include_bytes!("../icons/tray-idle.png"))?)
                .tooltip("Game Tracker")
                .menu(&menu)
                .on_menu_event(|app, ev| match ev.id.as_ref() {
                    "open" => {
                        if let Some(w) = app.get_webview_window("main") {
                            show_window(&w);
                        }
                    }
                    "pause" => {
                        let p = app.state::<Shared>().state.lock_ok().paused;
                        let _ = apply_paused(app, !p);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                        if let Some(w) = tray.app_handle().get_webview_window("main") {
                            show_window(&w);
                        }
                    }
                })
                .build(app)?;
            app.manage(Tray { icon, pause });

            start_detection(app.handle().clone());

            // Autostarted launches stay in the tray; a manual launch opens the window.
            if !std::env::args().any(|a| a == "--autostart") {
                if let Some(w) = app.get_webview_window("main") {
                    show_window(&w);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Game Tracker");
}
