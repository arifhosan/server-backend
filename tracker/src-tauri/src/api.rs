use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize, Serializer};
use std::time::Duration;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Heartbeat {
    #[serde(serialize_with = "ser_at")]
    pub at: DateTime<Utc>,
    pub game: HeartbeatGame,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatGame {
    pub store: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub store_id: Option<String>,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exe: Option<String>,
}

/// Always ends in `Z`, which the backend requires.
fn ser_at<S: Serializer>(at: &DateTime<Utc>, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&at.to_rfc3339_opts(SecondsFormat::Secs, true))
}

pub fn store_name(store: &str) -> &'static str {
    match store.to_ascii_lowercase().as_str() {
        "steam" => "steam",
        "xbox" => "xbox",
        "epic" => "epic",
        _ => "other",
    }
}

/// Deserialisation shape; serde cannot read a `&'static str` directly.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameWire {
    store: String,
    #[serde(default)]
    store_id: Option<String>,
    title: String,
    #[serde(default)]
    exe: Option<String>,
}

impl<'de> Deserialize<'de> for HeartbeatGame {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let w = GameWire::deserialize(d)?;
        Ok(HeartbeatGame { store: store_name(&w.store), store_id: w.store_id, title: w.title, exe: w.exe })
    }
}

/// Longest prefix of `s` with at most `max` UTF-16 code units (the backend counts JS string length), cut on a char boundary.
fn clamp16(s: &str, max: usize) -> &str {
    let mut n = 0;
    for (i, c) in s.char_indices() {
        n += c.len_utf16();
        if n > max {
            return &s[..i];
        }
    }
    s
}

impl Heartbeat {
    /// None when the backend would reject it (blank title). Empty storeId/exe are omitted. Over-long fields are
    /// clamped (title 255, exe 255) or dropped (storeId over 64) so one odd game can never get the batch refused.
    pub fn new(at: DateTime<Utc>, store: &str, store_id: Option<&str>, title: &str, exe: Option<&str>) -> Option<Self> {
        let title = clamp16(title.trim(), 255).trim_end();
        if title.is_empty() {
            return None;
        }
        fn some(v: Option<&str>) -> Option<&str> {
            v.map(str::trim).filter(|v| !v.is_empty())
        }
        Some(Heartbeat {
            at,
            game: HeartbeatGame {
                store: store_name(store),
                store_id: some(store_id).filter(|v| v.chars().count() <= 64).map(String::from),
                title: title.into(),
                exe: some(exe).map(|v| clamp16(v, 255).to_string()),
            },
        })
    }
}

#[derive(Debug, PartialEq)]
pub enum SendError {
    Unauthorized,
    Network(String),
    Server(u16),
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PsnStatus {
    pub status: String,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize, Debug, PartialEq)]
pub struct TrackerStatus {
    pub psn: Option<PsnStatus>,
}

pub struct Api {
    base: String,
    url: String,
    http: reqwest::blocking::Client,
}

impl Api {
    pub fn new(server_url: &str) -> Api {
        let http = reqwest::blocking::Client::builder().timeout(Duration::from_secs(30)).build().expect("http client");
        let base = server_url.trim_end_matches('/').to_string();
        Api { url: format!("{base}/games/tracker/heartbeats"), base, http }
    }

    pub fn send_heartbeats(&self, token: &str, hbs: &[Heartbeat]) -> Result<(), SendError> {
        let res = self
            .http
            .post(&self.url)
            .bearer_auth(token)
            .json(&serde_json::json!({ "heartbeats": hbs }))
            .send()
            .map_err(|e| SendError::Network(e.without_url().to_string()))?;
        match res.status().as_u16() {
            200..=299 => Ok(()),
            401 => Err(SendError::Unauthorized),
            c => Err(SendError::Server(c)),
        }
    }

    /// Upload a game icon (PNG bytes). 401 -> `Unauthorized`; 400 (bad or oversized PNG) -> `Server(400)`.
    pub fn put_icon(&self, token: &str, store: &str, store_id: Option<&str>, title: &str, png: &[u8]) -> Result<(), SendError> {
        use base64::Engine as _;
        let game = HeartbeatGame { store: store_name(store), store_id: store_id.map(String::from), title: title.into(), exe: None };
        let res = self
            .http
            .put(format!("{}/games/tracker/icon", self.base))
            .bearer_auth(token)
            .json(&serde_json::json!({ "game": game, "png": base64::engine::general_purpose::STANDARD.encode(png) }))
            .send()
            .map_err(|e| SendError::Network(e.without_url().to_string()))?;
        match res.status().as_u16() {
            200..=299 => Ok(()),
            401 => Err(SendError::Unauthorized),
            c => Err(SendError::Server(c)),
        }
    }

    pub fn tracker_status(&self, token: &str) -> Result<TrackerStatus, SendError> {
        let res = self
            .http
            .get(format!("{}/games/tracker/status", self.base))
            .bearer_auth(token)
            .send()
            .map_err(|e| SendError::Network(e.without_url().to_string()))?;
        match res.status().as_u16() {
            200..=299 => res.json().map_err(|e| SendError::Network(e.without_url().to_string())),
            401 => Err(SendError::Unauthorized),
            c => Err(SendError::Server(c)),
        }
    }
}
