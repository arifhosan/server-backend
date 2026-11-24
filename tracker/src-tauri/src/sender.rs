use crate::api::{Api, Heartbeat, SendError};
use crate::queue::Queue;
use crate::state::{AppState, Connection};
use crate::{publish, token, LockOk, Shared};
use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::mpsc, time::Duration};
use tauri::{AppHandle, Manager};

const BATCH: usize = 500;
const TICK: Duration = Duration::from_secs(60);

/// Sending side of the wake channel; `set_token` uses it to flush at once.
pub struct Wake(pub mpsc::Sender<()>);

#[derive(Debug, PartialEq)]
pub enum Flush {
    /// number of heartbeats accepted
    Sent(usize),
    /// queue was empty
    Idle,
    Offline,
    Revoked,
}

/// Send the queue oldest first in batches of 500. A batch is acked only after the server accepted it.
pub fn flush(q: &mut Queue, api: &Api, token: &str, now: DateTime<Utc>) -> Flush {
    let mut sent = 0;
    loop {
        let batch = q.peek_batch(BATCH, now);
        if batch.is_empty() {
            // ack drops entries that expired while the queue was never sent
            let _ = q.ack(0);
            return if sent == 0 { Flush::Idle } else { Flush::Sent(sent) };
        }
        match api.send_heartbeats(token, &batch) {
            Ok(()) => {
                if q.ack(batch.len()).is_err() {
                    return Flush::Offline;
                }
                sent += batch.len();
            }
            Err(SendError::Unauthorized) => return Flush::Revoked,
            Err(SendError::Network(_) | SendError::Server(_)) => return Flush::Offline,
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
struct Today {
    date: String,
    seconds: u64,
}

impl Today {
    fn load(dir: &Path, date: &str) -> Today {
        let t: Today = std::fs::read_to_string(dir.join("today.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        if t.date == date { t } else { Today { date: date.into(), seconds: 0 } }
    }

    fn save(&self, dir: &Path) {
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(dir.join("today.json"), serde_json::to_string(self).unwrap_or_default());
    }

    /// Start a new day when the local date changed; true if it did.
    fn roll(&mut self, dir: &Path, date: &str) -> bool {
        if self.date == date {
            return false;
        }
        *self = Today { date: date.into(), seconds: 0 };
        self.save(dir);
        true
    }

    fn add(&mut self, dir: &Path, date: &str, secs: u64) {
        self.roll(dir, date);
        self.seconds += secs;
        self.save(dir);
    }
}

fn today_str() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

/// One heartbeat per running game; none while paused.
fn heartbeats(st: &AppState, now: DateTime<Utc>) -> Vec<Heartbeat> {
    if st.paused {
        return vec![];
    }
    st.playing
        .iter()
        .filter_map(|g| Heartbeat::new(now, g.store.as_str(), g.store_id.as_deref(), &g.title, Some(&g.exe)))
        .collect()
}

fn run_flush(app: &AppHandle, q: &mut Queue) {
    let shared = app.state::<Shared>();
    let server = shared.settings.lock_ok().server_url.clone();
    let conn = match token::get() {
        None => Connection::NoToken,
        Some(t) => match flush(q, &Api::new(&server), &t, Utc::now()) {
            Flush::Sent(_) => Connection::Ok { last_sent_at: Some(Utc::now().timestamp()) },
            Flush::Offline => Connection::Offline { queued: q.len() as u32 },
            Flush::Revoked => Connection::Revoked,
            Flush::Idle => return, // nothing sent: no new information about the server
        },
    };
    shared.state.lock_ok().connection = conn;
    publish(app);
}

/// 60 s loop: one heartbeat per running game into the queue, then flush. A message on the wake channel flushes only.
pub fn spawn(app: AppHandle, dir: std::path::PathBuf) {
    let (tx, rx) = mpsc::channel();
    app.manage(Wake(tx));
    std::thread::spawn(move || {
        let mut q = Queue::open(dir.join("queue.jsonl"));
        let mut today = Today::load(&dir, &today_str());
        app.state::<Shared>().state.lock_ok().today_seconds = today.seconds;
        loop {
            match rx.recv_timeout(TICK) {
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let now = Utc::now();
                    if today.roll(&dir, &today_str()) {
                        app.state::<Shared>().state.lock_ok().today_seconds = 0;
                        publish(&app);
                    }
                    let hbs = heartbeats(&app.state::<Shared>().state.lock_ok(), now);
                    // disk full etc.: this minute is lost (and not counted), the loop must go on
                    if !hbs.is_empty() && q.push(&hbs).is_ok() {
                        today.add(&dir, &today_str(), 60 * hbs.len() as u64);
                        app.state::<Shared>().state.lock_ok().today_seconds = today.seconds;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
                Ok(()) => {}
            }
            run_flush(&app, &mut q);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::Heartbeat;
    use chrono::TimeZone;

    fn hbs(n: usize, now: DateTime<Utc>) -> Vec<Heartbeat> {
        (0..n).map(|i| Heartbeat::new(now, "steam", Some("1"), &format!("g{i}"), Some("g.exe")).unwrap()).collect()
    }

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 24, 10, 0, 0).unwrap()
    }

    #[test]
    fn body_and_header_exact() {
        let mut s = mockito::Server::new();
        let m = s
            .mock("POST", "/games/tracker/heartbeats")
            .match_header("authorization", "Bearer gt_abc")
            .match_body(mockito::Matcher::Json(serde_json::json!({"heartbeats":[
                {"at":"2026-11-24T10:00:00Z","game":{"store":"steam","storeId":"7","title":"Hades","exe":"h.exe"}},
                {"at":"2026-11-24T10:00:00Z","game":{"store":"other","title":"Solo"}}]})))
            .with_status(200)
            .create();
        let a = Heartbeat::new(now(), "steam", Some("7"), "Hades", Some("h.exe")).unwrap();
        let b = Heartbeat::new(now(), "gog", Some(""), "  Solo ", Some("")).unwrap();
        assert!(Heartbeat::new(now(), "steam", None, "   ", None).is_none());
        Api::new(&s.url()).send_heartbeats("gt_abc", &[a, b]).unwrap();
        m.assert();
    }

    #[test]
    fn six_hundred_go_as_500_then_100() {
        let dir = tempfile::tempdir().unwrap();
        let mut q = Queue::open(dir.path().join("q.jsonl"));
        q.push(&hbs(600, now())).unwrap();
        let mut s = mockito::Server::new();
        let first = s.mock("POST", "/games/tracker/heartbeats").match_body(mockito::Matcher::Regex(r#""title":"g499""#.into())).with_status(200).expect(1).create();
        let second = s.mock("POST", "/games/tracker/heartbeats").match_body(mockito::Matcher::Regex(r#""title":"g599""#.into())).with_status(200).expect(1).create();
        assert_eq!(flush(&mut q, &Api::new(&s.url()), "t", now()), Flush::Sent(600));
        first.assert();
        second.assert();
        assert_eq!(q.len(), 0);
    }

    #[test]
    fn network_error_after_first_batch_keeps_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let mut q = Queue::open(dir.path().join("q.jsonl"));
        q.push(&hbs(600, now())).unwrap();
        // raw server: accepts the first request with 200, then drops the second connection mid-request
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", l.local_addr().unwrap());
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            let mut buf = vec![0u8; 1 << 20];
            let (mut c, _) = l.accept().unwrap();
            let mut got = 0;
            while !buf[..got].ends_with(b"]}") {
                got += c.read(&mut buf[got..]).unwrap();
            }
            c.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            drop(c);
            drop(l.accept().unwrap()); // second batch: connection closed without a response
        });
        assert_eq!(flush(&mut q, &Api::new(&url), "t", now()), Flush::Offline);
        assert_eq!(q.len(), 100);
        assert_eq!(Queue::open(dir.path().join("q.jsonl")).peek_batch(1, now())[0].game.title, "g500");
    }

    #[test]
    fn unacked_batch_is_resent_after_crash() {
        let dir = tempfile::tempdir().unwrap();
        let mut q = Queue::open(dir.path().join("q.jsonl"));
        q.push(&hbs(3, now())).unwrap();
        assert_eq!(q.peek_batch(500, now()), Queue::open(dir.path().join("q.jsonl")).peek_batch(500, now()));
    }

    #[test]
    fn unauthorized_is_revoked_and_queue_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let mut q = Queue::open(dir.path().join("q.jsonl"));
        q.push(&hbs(5, now())).unwrap();
        let mut s = mockito::Server::new();
        s.mock("POST", "/games/tracker/heartbeats").with_status(401).create();
        assert_eq!(flush(&mut q, &Api::new(&s.url()), "t", now()), Flush::Revoked);
        assert_eq!(q.len(), 5);
    }

    #[test]
    fn server_error_is_offline() {
        let dir = tempfile::tempdir().unwrap();
        let mut q = Queue::open(dir.path().join("q.jsonl"));
        q.push(&hbs(2, now())).unwrap();
        let mut s = mockito::Server::new();
        s.mock("POST", "/games/tracker/heartbeats").with_status(503).create();
        assert_eq!(flush(&mut q, &Api::new(&s.url()), "t", now()), Flush::Offline);
        assert_eq!(q.len(), 2);
    }

    #[test]
    fn paused_produces_no_heartbeats() {
        use crate::library::Store;
        let mut st = AppState::new(true, false);
        st.playing.push(crate::state::RunningGame {
            key: "steam:1".into(),
            store: Store::Steam,
            store_id: Some("1".into()),
            title: "Hades".into(),
            exe: "h.exe".into(),
            started_at: now(),
        });
        assert_eq!(heartbeats(&st, now()).len(), 1);
        st.paused = true;
        assert!(heartbeats(&st, now()).is_empty());
    }

    #[test]
    fn midnight_rollover_resets_with_no_games() {
        let dir = tempfile::tempdir().unwrap();
        let mut t = Today::load(dir.path(), "2026-11-24");
        t.add(dir.path(), "2026-11-24", 600);
        assert!(!t.roll(dir.path(), "2026-11-24"));
        assert!(t.roll(dir.path(), "2026-11-25"));
        assert_eq!(t.seconds, 0);
        assert_eq!(Today::load(dir.path(), "2026-11-25").seconds, 0);
    }

    #[test]
    fn today_accumulates_and_resets_on_new_date() {
        let dir = tempfile::tempdir().unwrap();
        let mut t = Today::load(dir.path(), "2026-11-24");
        t.add(dir.path(), "2026-11-24", 60);
        t.add(dir.path(), "2026-11-24", 120);
        assert_eq!(Today::load(dir.path(), "2026-11-24").seconds, 180);
        assert_eq!(Today::load(dir.path(), "2026-11-25").seconds, 0);
        t.add(dir.path(), "2026-11-25", 60);
        assert_eq!(Today::load(dir.path(), "2026-11-25").seconds, 60);
    }
}
