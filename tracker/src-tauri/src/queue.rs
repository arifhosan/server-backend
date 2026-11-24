use crate::api::Heartbeat;
use chrono::{DateTime, Duration, Utc};
use std::{cell::Cell, fs, io::{self, Write}, path::PathBuf};

/// JSON-lines file of heartbeats waiting to be sent, oldest first.
pub struct Queue {
    path: PathBuf,
    items: Vec<Heartbeat>,
    /// `now` of the last peek, so `ack` counts the same non-expired entries.
    last_now: Cell<Option<DateTime<Utc>>>,
}

impl Queue {
    pub fn open(path: impl Into<PathBuf>) -> Queue {
        let path = path.into();
        // a torn last line (crash mid-append) must not swallow the next entry
        if let Ok(b) = fs::read(&path) {
            if b.last().is_some_and(|c| *c != b'\n') {
                let _ = fs::OpenOptions::new().append(true).open(&path).and_then(|mut f| f.write_all(b"\n"));
            }
        }
        let items = fs::read_to_string(&path)
            .map(|t| t.lines().filter_map(|l| serde_json::from_str(l).ok()).collect())
            .unwrap_or_default();
        Queue { path, items, last_now: Cell::new(None) }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn push(&mut self, hbs: &[Heartbeat]) -> io::Result<()> {
        if hbs.is_empty() {
            return Ok(());
        }
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let mut f = fs::OpenOptions::new().create(true).append(true).open(&self.path)?;
        f.write_all(lines(hbs)?.as_bytes())?;
        self.items.extend_from_slice(hbs);
        Ok(())
    }

    fn fresh(&self, now: DateTime<Utc>) -> impl Iterator<Item = &Heartbeat> {
        let cutoff = now - Duration::days(30);
        self.items.iter().filter(move |h| h.at >= cutoff)
    }

    /// Up to `max` oldest entries, skipping those older than 30 days (removed on the next `ack`).
    pub fn peek_batch(&self, max: usize, now: DateTime<Utc>) -> Vec<Heartbeat> {
        self.last_now.set(Some(now));
        self.fresh(now).take(max).cloned().collect()
    }

    /// Remove the first `n` entries returned by the last `peek_batch` (and expired ones); rewrite atomically.
    pub fn ack(&mut self, n: usize) -> io::Result<()> {
        let now = self.last_now.get().unwrap_or_else(Utc::now);
        let rest: Vec<Heartbeat> = self.fresh(now).skip(n).cloned().collect();
        if rest.len() == self.items.len() {
            return Ok(()); // nothing acked or expired: leave the file alone
        }
        crate::settings::write_atomic(&self.path, lines(&rest)?.as_bytes())?;
        self.items = rest;
        Ok(())
    }

    /// Non-expired entries (what is really waiting to be sent).
    pub fn live_len(&self, now: DateTime<Utc>) -> usize {
        self.fresh(now).count()
    }

    /// Drop expired entries from memory and disk.
    pub fn prune(&mut self, now: DateTime<Utc>) -> io::Result<()> {
        self.last_now.set(Some(now));
        self.ack(0)
    }
}

fn lines(hbs: &[Heartbeat]) -> io::Result<String> {
    let mut s = String::new();
    for h in hbs {
        s += &serde_json::to_string(h).map_err(io::Error::other)?;
        s.push('\n');
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn hb(at: DateTime<Utc>, t: &str) -> Heartbeat {
        Heartbeat::new(at, "steam", Some("1"), t, None).unwrap()
    }

    #[test]
    fn survives_reopen_and_acks_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("q").join("queue.jsonl");
        let now = Utc.with_ymd_and_hms(2026, 11, 24, 10, 0, 0).unwrap();
        let mut q = Queue::open(&p);
        q.push(&[hb(now, "a"), hb(now, "b"), hb(now, "c")]).unwrap();
        let mut q = Queue::open(&p);
        assert_eq!(q.len(), 3);
        assert_eq!(q.peek_batch(2, now).len(), 2);
        q.ack(2).unwrap();
        let q = Queue::open(&p);
        assert_eq!(q.peek_batch(10, now)[0].game.title, "c");
        assert_eq!(q.len(), 1);
    }

    #[test]
    fn torn_last_line_does_not_eat_next_push() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("queue.jsonl");
        let now = Utc.with_ymd_and_hms(2026, 11, 24, 10, 0, 0).unwrap();
        let mut q = Queue::open(&p);
        q.push(&[hb(now, "a")]).unwrap();
        fs::OpenOptions::new().append(true).open(&p).unwrap().write_all(br#"{"at":"2026-11-24T10:0"#).unwrap();
        let mut q = Queue::open(&p);
        q.push(&[hb(now, "b")]).unwrap();
        let q = Queue::open(&p);
        let t: Vec<_> = q.peek_batch(10, now).into_iter().map(|h| h.game.title).collect();
        assert_eq!(t, ["a", "b"]);
    }

    #[test]
    fn drops_entries_older_than_30_days() {
        let dir = tempfile::tempdir().unwrap();
        let now = Utc.with_ymd_and_hms(2026, 11, 24, 10, 0, 0).unwrap();
        let mut q = Queue::open(dir.path().join("queue.jsonl"));
        q.push(&[hb(now - Duration::days(31), "old"), hb(now - Duration::days(29), "new")]).unwrap();
        let b = q.peek_batch(10, now);
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].game.title, "new");
        q.ack(1).unwrap();
        assert_eq!(q.len(), 0);
    }
}
