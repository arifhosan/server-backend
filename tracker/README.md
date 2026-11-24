# Game Tracker

Windows tray app that reports PC game playtime to the games backend.

    cd src-tauri
    cargo test && cargo clippy -- -D warnings && cargo build
    cargo tauri dev        # needs: cargo install tauri-cli --version "^2" --locked

Settings live in `%APPDATA%\GameTracker\settings.json`. The device token is stored only in Windows Credential Manager (service `GameTracker`).
