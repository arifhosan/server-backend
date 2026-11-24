// Fields are filled by later tasks (detection, heartbeat sender).
#![allow(dead_code)]

use crate::library::Store;
use chrono::{DateTime, Utc};
use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

#[derive(Clone, Debug)]
pub struct RunningGame {
    /// "<store>:<store_id or folder title>"
    pub key: String,
    pub store: Store,
    pub store_id: Option<String>,
    pub title: String,
    pub exe: String,
    pub started_at: DateTime<Utc>,
}

/// The UI gets title, store and the session length so far (not the other fields).
impl Serialize for RunningGame {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("RunningGame", 3)?;
        st.serialize_field("title", &self.title)?;
        st.serialize_field("store", self.store.as_str())?;
        let secs = (Utc::now() - self.started_at).num_seconds().max(0);
        st.serialize_field("session_seconds", &secs)?;
        st.end()
    }
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
