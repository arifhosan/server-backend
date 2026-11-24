use crate::api::{Api, Heartbeat, SendError, TrackerStatus};
use crate::queue::Queue;
use crate::state::{AppState, Connection, PsnBanner};
use crate::{publish, token, LockOk, Shared};
use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::mpsc, time::Duration};
use crate::settings::write_atomic;
use tauri::{AppHandle, Manager};

const BATCH: usize = 100;
/// Batches per tick at most: a big backlog must not stop the once-a-minute heartbeats from being queued.
const MAX_BATCHES: usize = 10;
const TICK: Duration = Duration::from_secs(60);

/// Sending side of the wake channel; `set_token` uses it to flush at once.
pub struct Wake(pub mpsc::Sender<()>);

/// Wakes the status poller (after a token is set).
pub struct StatusWake(pub mpsc::Sender<()>);

/// Banner only for `expiring` (days rounded up) and `expired`; an expiry already in the past counts as expired.
pub fn psn_banner(st: &TrackerStatus, now: DateTime<Utc>) -> Option<PsnBanner> {
    let p = st.psn.as_ref()?;
    let expired = || Some(PsnBanner { status: "expired".into(), days: None });
    match p.status.as_str() {
        "expired" => expired(),
        "expiring" => {
            let secs = (p.expires_at? - now).num_seconds(); // no expiry date: nothing true to show
            if secs <= 0 {
                return expired();
            }
            Some(PsnBanner { status: "expiring".into(), days: Some(((secs + 86_399) / 86_400) as u32) })
        }
        _ => None,
    }
}

#[derive(Debug, PartialEq)]
pub enum StatusPoll {
    Banner(Option<PsnBanner>),
    Revoked,
    /// network or server error: keep what is shown
    Failed,
}

pub fn poll_status(api: &Api, token: &str, now: DateTime<Utc>) -> StatusPoll {
    match api.tracker_status(token) {
        Ok(st) => StatusPoll::Banner(psn_banner(&st, now)),
        Err(SendError::Unauthorized) => StatusPoll::Revoked,
        Err(_) => StatusPoll::Failed,
    }
}

fn run_status(app: &AppHandle) {
    let shared = app.state::<Shared>();
    let server = shared.settings.lock_ok().server_url.clone();
    let Some(t) = token::get() else { return };
    let poll = poll_status(&Api::new(&server), &t, Utc::now());
    if apply_poll(&mut shared.state.lock_ok(), poll) {
        publish(app);
    }
}

/// Store a poll result; false if nothing changed. A result that arrives after the token was removed is dropped.
fn apply_poll(st: &mut AppState, poll: StatusPoll) -> bool {
    if st.connection == Connection::NoToken {
        return false;
    }
    match poll {
        StatusPoll::Banner(b) => {
            st.psn = b;
            // the server answers again; nothing is queued, so no flush will ever say so
            if st.connection == (Connection::Offline { queued: 0 }) {
                st.connection = Connection::Ok { last_sent_at: None };
            }
        }
        StatusPoll::Revoked => st.connection = Connection::Revoked,
        // unreachable server with an empty queue: the flush is Idle and silent, so this is the only signal
        StatusPoll::Failed if matches!(st.connection, Connection::Ok { .. }) => {
            st.connection = Connection::Offline { queued: 0 };
        }
        StatusPoll::Failed => return false,
    }
    true
}

/// Store a flush result unless the token was removed meanwhile (an in-flight flush must not undo that).
fn apply_conn(st: &mut AppState, conn: Connection) -> bool {
    if st.connection == Connection::NoToken {
        return false;
    }
    st.connection = conn;
    true
}

/// Every 10 min, and at once on a wake message.
pub fn spawn_status(app: AppHandle) {
    let (tx, rx) = mpsc::channel();
    app.manage(StatusWake(tx));
    std::thread::spawn(move || loop {
        run_status(&app);
        if let Err(mpsc::RecvTimeoutError::Disconnected) = rx.recv_timeout(Duration::from_secs(600)) {
            return;
        }
    });
}

#[derive(Debug, PartialEq)]
pub enum Flush {
    /// number of heartbeats accepted
    Sent(usize),
    /// queue was empty
    Idle,
    Offline,
    Revoked,
}

/// A refusal that retrying cannot fix (bad data, body too large): not auth, timeout or rate limit.
fn is_permanent(code: u16) -> bool {
    (400..500).contains(&code) && ![401, 408, 429].contains(&code)
}

/// Send the queue oldest first in batches of 100, at most 10 batches per call. A batch is acked only after the server
/// accepted it, or refused it for good (4xx other than 401/408/429): that batch is dropped and counted in `dropped`,
/// so one bad entry cannot jam the queue forever.
pub fn flush(q: &mut Queue, api: &Api, token: &str, now: DateTime<Utc>, dropped: &mut u32) -> Flush {
    let mut sent = 0;
    for _ in 0..MAX_BATCHES {
        let batch = q.peek_batch(BATCH, now);
        if batch.is_empty() {
            break;
        }
        match api.send_heartbeats(token, &batch) {
            Ok(()) => {
                if q.ack(batch.len()).is_err() {
                    return Flush::Offline;
                }
                sent += batch.len();
            }
            Err(SendError::Server(c)) if is_permanent(c) => {
                if q.ack(batch.len()).is_err() {
                    return Flush::Offline;
                }
                *dropped += batch.len() as u32;
            }
            Err(SendError::Unauthorized) => return Flush::Revoked,
            Err(SendError::Network(_) | SendError::Server(_)) => return Flush::Offline,
        }
    }
    let _ = q.prune(now); // entries that expired while the queue was never sent
    if sent == 0 { Flush::Idle } else { Flush::Sent(sent) }
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
        let _ = write_atomic(&dir.join("today.json"), serde_json::to_string(self).unwrap_or_default().as_bytes());
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
    // no token: remove_token / startup already show NoToken, so there is nothing to flush or to report
    let Some(t) = token::get() else { return };
    let now = Utc::now();
    let mut dropped = 0;
    let conn = match flush(q, &Api::new(&server), &t, now, &mut dropped) {
        Flush::Sent(_) => Some(Connection::Ok { last_sent_at: Some(now.timestamp()) }),
        Flush::Offline => Some(Connection::Offline { queued: q.live_len(now) as u32 }),
        Flush::Revoked => Some(Connection::Revoked),
        Flush::Idle => None, // nothing sent: no new information about the server
    };
    let changed = {
        let mut st = shared.state.lock_ok();
        st.dropped_heartbeats += dropped;
        conn.is_some_and(|c| apply_conn(&mut st, c)) || dropped > 0
    };
    if changed {
        publish(app);
    }
}

/// Once per game session, upload its icon on a background thread (never delays the flush).
fn upload_new_icons(app: &AppHandle, dir: &Path, tried: &mut std::collections::HashSet<String>) {
    let playing = app.state::<Shared>().state.lock_ok().playing.clone();
    tried.retain(|k| playing.iter().any(|g| &g.key == k));
    for g in playing.into_iter().filter(|g| tried.insert(g.key.clone())) {
        let (app, dir) = (app.clone(), dir.to_path_buf());
        std::thread::spawn(move || {
            let shared = app.state::<Shared>();
            let server = shared.settings.lock_ok().server_url.clone();
            if let Some(t) = token::get() {
                crate::icons::send_once(&Api::new(&server), &t, &shared.settings, &dir, &g);
            }
        });
    }
}

/// 60 s loop: one heartbeat per running game into the queue, then flush. A message on the wake channel flushes only.
pub fn spawn(app: AppHandle, dir: std::path::PathBuf) {
    let (tx, rx) = mpsc::channel();
    app.manage(Wake(tx));
    std::thread::spawn(move || {
        let mut q = Queue::open(dir.join("queue.jsonl"));
        let _ = q.prune(Utc::now());
        let mut today = Today::load(&dir, &today_str());
        let mut icon_tried = std::collections::HashSet::new(); // keys tried this session
        app.state::<Shared>().state.lock_ok().today_seconds = today.seconds;
        loop {
            match rx.recv_timeout(TICK) {
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let now = Utc::now();
                    let _ = q.prune(now); // expired entries go even while offline
                    if today.roll(&dir, &today_str()) {
                        app.state::<Shared>().state.lock_ok().today_seconds = 0;
                        publish(&app);
                    }
                    let hbs = heartbeats(&app.state::<Shared>().state.lock_ok(), now);
                    upload_new_icons(&app, &dir, &mut icon_tried);
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

    fn status(s: &str, exp: Option<&str>) -> TrackerStatus {
        TrackerStatus {
            psn: Some(crate::api::PsnStatus { status: s.into(), expires_at: exp.map(|e| e.parse().unwrap()) }),
        }
    }

    #[test]
    fn poll_after_token_removal_is_dropped() {
        let b = || StatusPoll::Banner(Some(PsnBanner { status: "expired".into(), days: None }));
        let mut st = AppState::new(false, false);
        assert!(!apply_poll(&mut st, b()));
        assert!(st.psn.is_none());
        assert!(!apply_poll(&mut st, StatusPoll::Revoked));
        assert_eq!(st.connection, Connection::NoToken);
        let mut st = AppState::new(true, false);
        assert!(apply_poll(&mut st, b()));
        assert!(st.psn.is_some());
    }

    #[test]
    fn psn_banner_cases() {
        let b = psn_banner(&status("expiring", Some("2026-12-03T14:00:00Z")), now()).unwrap(); // 9.17 days
        assert_eq!((b.status.as_str(), b.days), ("expiring", Some(10)));
        let b = psn_banner(&status("expiring", Some("2026-11-25T10:00:00Z")), now()).unwrap(); // exactly 1 day
        assert_eq!(b.days, Some(1));
        let b = psn_banner(&status("expiring", Some("2026-11-24T09:00:00Z")), now()).unwrap(); // already past
        assert_eq!((b.status.as_str(), b.days), ("expired", None));
        assert_eq!(psn_banner(&status("expired", None), now()).unwrap().status, "expired");
        assert!(psn_banner(&status("expiring", None), now()).is_none());
        for s in ["ok", "failing", "disabled"] {
            assert!(psn_banner(&status(s, None), now()).is_none());
        }
        assert!(psn_banner(&TrackerStatus { psn: None }, now()).is_none());
    }

    #[test]
    fn status_401_is_revoked_and_200_parses() {
        let mut s = mockito::Server::new();
        let m = s.mock("GET", "/games/tracker/status").match_header("authorization", "Bearer t").with_status(401).create();
        assert_eq!(poll_status(&Api::new(&s.url()), "t", now()), StatusPoll::Revoked);
        m.remove();
        s.mock("GET", "/games/tracker/status")
            .with_body(r#"{"psn":{"status":"expired","expiresAt":null}}"#)
            .create();
        assert!(matches!(poll_status(&Api::new(&s.url()), "t", now()), StatusPoll::Banner(Some(_))));
        s.mock("GET", "/games/tracker/status").with_status(500).create();
        assert_eq!(poll_status(&Api::new(&s.url()), "t", now()), StatusPoll::Failed);
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
    fn backlog_goes_in_batches_of_100_capped_at_10_per_flush() {
        let dir = tempfile::tempdir().unwrap();
        let mut q = Queue::open(dir.path().join("q.jsonl"));
        q.push(&hbs(1050, now())).unwrap();
        let mut s = mockito::Server::new();
        let m = s.mock("POST", "/games/tracker/heartbeats").with_status(200).expect(10).create();
        assert_eq!(flush(&mut q, &Api::new(&s.url()), "t", now(), &mut 0), Flush::Sent(1000));
        m.assert();
        assert_eq!(q.len(), 50);
        assert_eq!(flush(&mut q, &Api::new(&s.url()), "t", now(), &mut 0), Flush::Sent(50)); // the next tick drains the rest
        assert_eq!(q.len(), 0);
    }

    #[test]
    fn bad_request_drops_that_batch_and_sends_the_next() {
        let dir = tempfile::tempdir().unwrap();
        let mut q = Queue::open(dir.path().join("q.jsonl"));
        q.push(&hbs(150, now())).unwrap();
        let mut s = mockito::Server::new();
        // first batch (g0..g99) is refused for good, the second (g100..g149) is accepted
        let bad = s.mock("POST", "/games/tracker/heartbeats").match_body(mockito::Matcher::Regex(r#""title":"g0""#.into())).with_status(400).expect(1).create();
        let good = s.mock("POST", "/games/tracker/heartbeats").match_body(mockito::Matcher::Regex(r#""title":"g100""#.into())).with_status(200).expect(1).create();
        let mut dropped = 0;
        assert_eq!(flush(&mut q, &Api::new(&s.url()), "t", now(), &mut dropped), Flush::Sent(50));
        bad.assert();
        good.assert();
        assert_eq!((dropped, q.len()), (100, 0));
    }

    #[test]
    fn retryable_4xx_keeps_the_queue() {
        for code in [408, 429] {
            let dir = tempfile::tempdir().unwrap();
            let mut q = Queue::open(dir.path().join("q.jsonl"));
            q.push(&hbs(3, now())).unwrap();
            let mut s = mockito::Server::new();
            s.mock("POST", "/games/tracker/heartbeats").with_status(code).create();
            let mut dropped = 0;
            assert_eq!(flush(&mut q, &Api::new(&s.url()), "t", now(), &mut dropped), Flush::Offline);
            assert_eq!((dropped, q.len()), (0, 3));
        }
    }

    #[test]
    fn offline_counts_only_live_entries_and_prunes() {
        use chrono::Duration as D;
        let dir = tempfile::tempdir().unwrap();
        let mut q = Queue::open(dir.path().join("q.jsonl"));
        q.push(&hbs(2, now() - D::days(31))).unwrap();
        q.push(&hbs(3, now())).unwrap();
        assert_eq!((q.len(), q.live_len(now())), (5, 3));
        q.prune(now()).unwrap();
        assert_eq!(Queue::open(dir.path().join("q.jsonl")).len(), 3);
    }

    #[test]
    fn flush_result_never_overwrites_no_token() {
        let mut st = AppState::new(false, false);
        assert!(!apply_conn(&mut st, Connection::Ok { last_sent_at: Some(1) }));
        assert!(!apply_conn(&mut st, Connection::Revoked));
        assert_eq!(st.connection, Connection::NoToken);
        let mut st = AppState::new(true, false);
        assert!(apply_conn(&mut st, Connection::Offline { queued: 2 }));
        assert_eq!(st.connection, Connection::Offline { queued: 2 });
    }

    #[test]
    fn failed_poll_while_idle_shows_offline_and_recovers() {
        let mut st = AppState::new(true, false);
        assert!(apply_poll(&mut st, StatusPoll::Failed));
        assert_eq!(st.connection, Connection::Offline { queued: 0 });
        assert!(!apply_poll(&mut st, StatusPoll::Failed));
        assert!(apply_poll(&mut st, StatusPoll::Banner(None)));
        assert_eq!(st.connection, Connection::Ok { last_sent_at: None });
        st.connection = Connection::Offline { queued: 4 }; // queued entries: only a flush may clear this
        apply_poll(&mut st, StatusPoll::Banner(None));
        assert_eq!(st.connection, Connection::Offline { queued: 4 });
    }

    #[test]
    fn heartbeat_fields_are_clamped() {
        let long = "é".repeat(300);
        let h = Heartbeat::new(now(), "steam", Some(&"x".repeat(65)), &long, Some(&long)).unwrap();
        assert_eq!(h.game.title.encode_utf16().count(), 255);
        assert_eq!(h.game.exe.unwrap().encode_utf16().count(), 255);
        assert_eq!(h.game.store_id, None);
        assert_eq!(Heartbeat::new(now(), "steam", Some(&"x".repeat(64)), "t", None).unwrap().game.store_id.unwrap().len(), 64);
        // astral chars are 2 units: 128 of them would be 256, so the 128th is cut, not split
        let t = "😀".repeat(128);
        assert_eq!(Heartbeat::new(now(), "steam", None, &t, None).unwrap().game.title.chars().count(), 127);
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
        assert_eq!(flush(&mut q, &Api::new(&url), "t", now(), &mut 0), Flush::Offline);
        assert_eq!(q.len(), 500);
        assert_eq!(Queue::open(dir.path().join("q.jsonl")).peek_batch(1, now())[0].game.title, "g100");
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
        assert_eq!(flush(&mut q, &Api::new(&s.url()), "t", now(), &mut 0), Flush::Revoked);
        assert_eq!(q.len(), 5);
    }

    #[test]
    fn server_error_is_offline() {
        let dir = tempfile::tempdir().unwrap();
        let mut q = Queue::open(dir.path().join("q.jsonl"));
        q.push(&hbs(2, now())).unwrap();
        let mut s = mockito::Server::new();
        s.mock("POST", "/games/tracker/heartbeats").with_status(503).create();
        assert_eq!(flush(&mut q, &Api::new(&s.url()), "t", now(), &mut 0), Flush::Offline);
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
            exe_path: "C:/g/h.exe".into(),
            logo: None,
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
