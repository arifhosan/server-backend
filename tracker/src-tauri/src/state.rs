// Fields are filled by later tasks (detection, heartbeat sender).
#![allow(dead_code)]

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct RunningGame {
    pub title: String,
    pub store: String,
    pub session_seconds: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Connection {
    /// unix seconds of the last accepted heartbeat, if any yet
    Ok { last_sent_at: Option<i64> },
    Offline { queued: u32 },
    Revoked,
    NoToken,
}

#[derive(Serialize, Clone, Debug)]
pub struct PsnBanner {
    /// "expiring" | "expired"
    pub status: String,
    pub days: Option<u32>,
}

#[derive(Serialize, Clone, Debug)]
pub struct AppState {
    pub playing: Vec<RunningGame>,
    pub today_seconds: u64,
    pub connection: Connection,
    pub psn: Option<PsnBanner>,
    pub paused: bool,
}

impl AppState {
    pub fn new(has_token: bool, paused: bool) -> Self {
        AppState {
            playing: vec![],
            today_seconds: 0,
            connection: if has_token { Connection::Ok { last_sent_at: None } } else { Connection::NoToken },
            psn: None,
            paused,
        }
    }
}
