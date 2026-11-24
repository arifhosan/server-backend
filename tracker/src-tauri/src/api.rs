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

impl Heartbeat {
    /// None when the backend would reject it (blank title). Empty storeId/exe are omitted.
    pub fn new(at: DateTime<Utc>, store: &str, store_id: Option<&str>, title: &str, exe: Option<&str>) -> Option<Self> {
        let title = title.trim();
        if title.is_empty() {
            return None;
        }
        let some = |v: Option<&str>| v.map(str::trim).filter(|v| !v.is_empty()).map(String::from);
        Some(Heartbeat {
            at,
            game: HeartbeatGame { store: store_name(store), store_id: some(store_id), title: title.into(), exe: some(exe) },
        })
    }
}

#[derive(Debug, PartialEq)]
pub enum SendError {
    Unauthorized,
    Network(String),
    Server(u16),
}

pub struct Api {
    url: String,
    http: reqwest::blocking::Client,
}

impl Api {
    pub fn new(server_url: &str) -> Api {
        let http = reqwest::blocking::Client::builder().timeout(Duration::from_secs(30)).build().expect("http client");
        Api { url: format!("{}/games/tracker/heartbeats", server_url.trim_end_matches('/')), http }
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
}
