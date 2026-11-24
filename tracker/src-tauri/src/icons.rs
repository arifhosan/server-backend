//! Non-Steam game icons: found once, downscaled, sent once per game key.
use crate::api::Api;
use crate::library::Store;
use crate::settings::Settings;
use crate::state::RunningGame;
use image::{imageops::FilterType, DynamicImage, ImageFormat, ImageReader, Limits, RgbaImage};
use std::{io::Cursor, path::Path, sync::Mutex};

const MAX_PX: u32 = 128;
const MAX_BYTES: usize = 65_536;
const MAX_FILE: u64 = 8 << 20;

/// Decode an untrusted logo file within hard limits (8 MB file, 4096 px, 64 MiB alloc).
fn decode_logo(path: &Path) -> Option<DynamicImage> {
    if std::fs::metadata(path).ok()?.len() > MAX_FILE {
        return None;
    }
    let mut r = ImageReader::open(path).ok()?.with_guessed_format().ok()?;
    let mut lim = Limits::default();
    lim.max_image_width = Some(4096);
    lim.max_image_height = Some(4096);
    lim.max_alloc = Some(64 << 20);
    r.limits(lim);
    r.decode().ok()
}

/// The configured logo, or (Xbox ships `Logo.scale-200.png` instead of `Logo.png`) the first scale-qualified sibling.
fn resolve_logo(logo: &Path) -> Option<std::path::PathBuf> {
    if logo.is_file() {
        return Some(logo.to_path_buf());
    }
    let stem = logo.file_stem()?.to_string_lossy();
    let ext = logo.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    [100, 125, 150, 200, 400]
        .iter()
        .map(|s| logo.with_file_name(format!("{stem}.scale-{s}{ext}")))
        .find(|p| p.is_file())
}

/// PNG of at most 128 px and 64 KB, or None.
fn encode(mut img: DynamicImage) -> Option<Vec<u8>> {
    if img.width() > MAX_PX || img.height() > MAX_PX {
        img = img.resize(MAX_PX, MAX_PX, FilterType::Lanczos3);
    }
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, ImageFormat::Png).ok()?;
    Some(out.into_inner()).filter(|b| b.len() <= MAX_BYTES)
}

/// Xbox: the logo PNG if it decodes; otherwise (and for every other store) the exe's icon. Steam: never.
pub fn icon_png(store: Store, logo: Option<&Path>, exe: &Path) -> Option<Vec<u8>> {
    if store == Store::Steam {
        return None;
    }
    if let Some(png) = logo.filter(|_| store == Store::Xbox).and_then(resolve_logo).and_then(|p| decode_logo(&p)).and_then(encode) {
        return Some(png);
    }
    // a panic inside the Win32 icon code just skips the icon
    let ico = std::panic::catch_unwind(|| windows_icons::get_icon_by_path(exe)).ok()?.ok()?;
    encode(DynamicImage::ImageRgba8(RgbaImage::from_raw(ico.width(), ico.height(), ico.into_raw())?))
}

/// Upload the icon unless Steam or already sent; on success remember the key. Failures are retried next session.
pub fn send_once(api: &Api, token: &str, settings: &Mutex<Settings>, dir: &Path, g: &RunningGame) {
    if g.store == Store::Steam || settings.lock().is_ok_and(|s| s.sent_icons.contains(&g.key)) {
        return;
    }
    let Some(png) = icon_png(g.store, g.logo.as_deref(), &g.exe_path) else { return };
    let r = api.put_icon(token, g.store.as_str(), g.store_id.as_deref(), &g.title, &png);
    if let (Ok(()), Ok(mut s)) = (r, settings.lock()) {
        s.sent_icons.push(g.key.clone());
        let _ = s.save(dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn game(store: Store, logo: Option<std::path::PathBuf>) -> RunningGame {
        RunningGame { key: "xbox:Pkg".into(), store, store_id: Some("Pkg".into()), title: "Halo".into(), exe: "nope.exe".into(), exe_path: "nope.exe".into(), logo, started_at: Utc::now() }
    }

    fn logo_file(dir: &Path, px: u32) -> std::path::PathBuf {
        let p = dir.join("logo.png");
        let noise = RgbaImage::from_fn(px, px, |x, y| image::Rgba([(x * 7 + y) as u8, (y * 3) as u8, (x ^ y) as u8, 255]));
        noise.save(&p).unwrap();
        p
    }

    #[test]
    fn big_logo_is_downscaled_to_128_and_64kb() {
        let d = tempfile::tempdir().unwrap();
        let png = icon_png(Store::Xbox, Some(&logo_file(d.path(), 512)), Path::new("nope.exe")).unwrap();
        let img = image::load_from_memory(&png).unwrap();
        assert!(img.width() <= 128 && img.height() <= 128);
        assert!(png.len() <= 65_536);
        assert_eq!(&png[..4], b"\x89PNG");
    }

    #[test]
    fn missing_logo_falls_back_to_scale_sibling() {
        let d = tempfile::tempdir().unwrap();
        let cfg = d.path().join("Logo.png");
        assert!(resolve_logo(&cfg).is_none());
        let real = logo_file(d.path(), 64); // writes logo.png; Windows paths are case-insensitive
        std::fs::rename(&real, d.path().join("Logo.scale-200.png")).unwrap();
        std::fs::copy(d.path().join("Logo.scale-200.png"), d.path().join("Logo.scale-150.png")).unwrap();
        assert_eq!(resolve_logo(&cfg), Some(d.path().join("Logo.scale-150.png"))); // first existing in order
        assert!(icon_png(Store::Xbox, Some(&cfg), Path::new("nope.exe")).is_some());
        assert_eq!(resolve_logo(&logo_file(d.path(), 8)), Some(d.path().join("logo.png"))); // exact file wins
    }

    #[test]
    fn huge_declared_size_is_skipped() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("bomb.png");
        // signature + IHDR declaring 11000 x 11000 RGBA; no pixel data follows
        let mut b = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
        b.extend([0, 0, 0x2a, 0xf8, 0, 0, 0x2a, 0xf8, 8, 6, 0, 0, 0, 0, 0, 0, 0]);
        std::fs::write(&p, b).unwrap();
        assert!(decode_logo(&p).is_none());
        assert!(icon_png(Store::Xbox, Some(&p), Path::new("nope.exe")).is_none());
    }

    #[test]
    fn steam_never_uploads() {
        let d = tempfile::tempdir().unwrap();
        let mut s = mockito::Server::new();
        let m = s.mock("PUT", "/games/tracker/icon").expect(0).create();
        let mut g = game(Store::Steam, Some(logo_file(d.path(), 64)));
        g.key = "steam:1".into();
        send_once(&Api::new(&s.url()), "t", &Mutex::new(Settings::default()), d.path(), &g);
        m.assert();
    }

    #[test]
    fn sent_once_then_never_again() {
        let d = tempfile::tempdir().unwrap();
        let mut s = mockito::Server::new();
        let m = s
            .mock("PUT", "/games/tracker/icon")
            .match_header("authorization", "Bearer t")
            .match_body(mockito::Matcher::PartialJson(serde_json::json!({"game":{"store":"xbox","storeId":"Pkg","title":"Halo"}})))
            .with_status(204)
            .expect(1)
            .create();
        let api = Api::new(&s.url());
        let settings = Mutex::new(Settings::default());
        let g = game(Store::Xbox, Some(logo_file(d.path(), 64)));
        send_once(&api, "t", &settings, d.path(), &g);
        send_once(&api, "t", &settings, d.path(), &g); // second session
        m.assert();
        assert_eq!(Settings::load(d.path()).sent_icons, vec!["xbox:Pkg".to_string()]);
    }

    #[test]
    fn non_2xx_keeps_key_unsent() {
        let d = tempfile::tempdir().unwrap();
        let mut s = mockito::Server::new();
        s.mock("PUT", "/games/tracker/icon").with_status(400).create();
        let settings = Mutex::new(Settings::default());
        send_once(&Api::new(&s.url()), "t", &settings, d.path(), &game(Store::Xbox, Some(logo_file(d.path(), 64))));
        assert!(settings.lock().unwrap().sent_icons.is_empty());
    }
}
