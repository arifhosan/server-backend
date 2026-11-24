# Game Tracker

Windows tray app that reports PC game playtime to the games backend.

    cd src-tauri
    cargo test && cargo clippy -- -D warnings && cargo build
    cargo tauri dev        # needs: cargo install tauri-cli --version "^2" --locked

Settings live in `%APPDATA%\GameTracker\settings.json`. The device token is stored only in Windows Credential Manager (service `GameTracker`).

## Install

1. Download `GameTracker-setup.exe` from the [latest release](https://github.com/ArifHosan/server-backend/releases/latest/download/GameTracker-setup.exe) and run it. It installs per user, no admin needed.
2. SmartScreen: the binary is not code-signed, so Windows may warn. Choose "More info", then "Run anyway".
3. In the dashboard open Devices, create a device token, then paste it in the tray app (Settings, Device token).

The app starts with Windows (toggle in Settings; implemented with `tauri-plugin-autostart`) and checks for updates at start and then daily.

## Building the installer locally

    cd tracker/src-tauri
    cargo tauri build

Output: `target/release/bundle/nsis/Game Tracker_<version>_x64-setup.exe`. Updater artifacts (`createUpdaterArtifacts`) are off in `tauri.conf.json`, so no signing key is needed locally.

## Releasing (owner)

One-time setup:

1. `cargo tauri signer generate -w ~/.tauri/gametracker.key` (never commit the private key).
2. Replace the `pubkey` TODO in `src-tauri/tauri.conf.json` with the contents of `~/.tauri/gametracker.key.pub`.
3. Add GitHub repo secrets `TAURI_SIGNING_PRIVATE_KEY` (contents of the key file) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

The release workflow refuses to build until the pubkey is set (step 2): it fails at once if `tauri.conf.json` still contains the `TODO-OWNER-REPLACE` placeholder.

Each release: set `version` in `tauri.conf.json` and `Cargo.toml`, commit, then `git tag tracker-v<version> && git push origin tracker-v<version>`. The workflow `.github/workflows/tracker-release.yml` builds with `--config '{"bundle":{"createUpdaterArtifacts":true}}'` and publishes `GameTracker-setup.exe`, its `.sig` and `latest.json`.

The dashboard and updater use `releases/latest/download/...`, which is the newest non-prerelease release of the whole repo. Tracker releases are marked latest; any other release type in this repo must be a prerelease or not marked latest, or the download links break.
