use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::types::{MentionResult, Position, Sentiment};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainDayStat {
    pub day: String,
    pub total: usize,
    pub mentioned: usize,
    pub cited: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishSnapshot {
    pub id: i64,
    pub domain: String,
    pub note: Option<String>,
    /// Mention rate (0–100) captured at publish time.
    pub mention_rate: f64,
    pub mention_count: usize,
    pub total_queries: usize,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: i64,
    pub domain: String,
    pub niche: Option<String>,
    pub notes: Option<String>,
    pub last_audited: Option<String>,
    pub created_at: String,
}

pub struct Storage {
    conn: Connection,
}

impl Storage {
    pub fn open(base_dir: &PathBuf) -> Result<Self> {
        std::fs::create_dir_all(base_dir)?;
        let conn = Connection::open(base_dir.join("mentions.db"))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS mentions (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                domain       TEXT NOT NULL,
                prompt       TEXT NOT NULL,
                model        TEXT NOT NULL,
                timestamp    TEXT NOT NULL,
                mentioned    INTEGER NOT NULL,
                cited        INTEGER NOT NULL,
                position     TEXT NOT NULL,
                sentiment    TEXT NOT NULL,
                snippet      TEXT,
                raw_response TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_domain_ts ON mentions(domain, timestamp);
            CREATE TABLE IF NOT EXISTS projects (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                domain       TEXT NOT NULL UNIQUE,
                niche        TEXT,
                notes        TEXT,
                last_audited TEXT,
                created_at   TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS publish_snapshots (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                domain        TEXT NOT NULL,
                note          TEXT,
                mention_rate  REAL NOT NULL,
                mention_count INTEGER NOT NULL,
                total_queries INTEGER NOT NULL,
                timestamp     TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_snapshots_domain ON publish_snapshots(domain, timestamp);",
        )?;
        Ok(Self { conn })
    }

    pub fn insert(&self, r: &MentionResult) -> Result<()> {
        self.conn.execute(
            "INSERT INTO mentions
             (domain,prompt,model,timestamp,mentioned,cited,position,sentiment,snippet,raw_response)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                r.domain,
                r.prompt,
                r.model,
                r.timestamp.to_rfc3339(),
                r.mentioned as i32,
                r.cited as i32,
                r.position.to_string(),
                r.sentiment.to_string(),
                r.snippet,
                r.raw_response,
            ],
        )?;
        Ok(())
    }

    pub fn query_domain(&self, domain: &str, days: u32) -> Result<Vec<MentionResult>> {
        let since = Utc::now() - chrono::Duration::days(days as i64);
        let mut stmt = self.conn.prepare(
            "SELECT domain,prompt,model,timestamp,mentioned,cited,position,sentiment,snippet,raw_response
             FROM mentions WHERE domain=?1 AND timestamp>=?2 ORDER BY timestamp DESC",
        )?;

        let rows = stmt.query_map(params![domain, since.to_rfc3339()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i32>(4)? != 0,
                row.get::<_, i32>(5)? != 0,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, String>(9)?,
            ))
        })?;

        let mut results = Vec::new();
        for row in rows {
            let (domain, prompt, model, ts, mentioned, cited, pos_s, sent_s, snippet, raw) = row?;
            let timestamp = chrono::DateTime::parse_from_rfc3339(&ts)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now());
            results.push(MentionResult {
                domain,
                prompt,
                model,
                timestamp,
                mentioned,
                cited,
                position: parse_position(&pos_s),
                sentiment: parse_sentiment(&sent_s),
                snippet,
                raw_response: raw,
            });
        }
        Ok(results)
    }

    /// Returns (mentioned, total) for the run just before `before_ts` for trend display.
    pub fn previous_run_stats(
        &self,
        domain: &str,
        before_ts: &str,
    ) -> Result<Option<(usize, usize)>> {
        // Find the date of the most recent batch before the current run,
        // then aggregate within that date only.
        let prev_date: Option<String> = self
            .conn
            .query_row(
                "SELECT DATE(timestamp) FROM mentions
                 WHERE domain=?1 AND timestamp < ?2
                 ORDER BY timestamp DESC
                 LIMIT 1",
                params![domain, before_ts],
                |r| r.get(0),
            )
            .optional()?;
        let Some(prev_date) = prev_date else {
            return Ok(None);
        };
        let (mentioned, total): (i64, i64) = self.conn.query_row(
            "SELECT COALESCE(SUM(mentioned), 0), COUNT(*)
             FROM mentions
             WHERE domain=?1 AND DATE(timestamp)=?2",
            params![domain, prev_date],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if total > 0 {
            return Ok(Some((mentioned as usize, total as usize)));
        }
        Ok(None)
    }

    // ── Project management ───────────────────────────────────────────────────

    pub fn upsert_project(
        &self,
        domain: &str,
        niche: Option<&str>,
        notes: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO projects (domain, niche, notes, created_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(domain) DO UPDATE SET
               niche = COALESCE(?2, niche),
               notes = COALESCE(?3, notes)",
            params![domain, niche, notes, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, domain, niche, notes, last_audited, created_at
             FROM projects ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                domain: row.get(1)?,
                niche: row.get(2)?,
                notes: row.get(3)?,
                last_audited: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        let mut projects = Vec::new();
        for p in rows {
            projects.push(p?);
        }
        Ok(projects)
    }

    pub fn remove_project(&self, domain: &str) -> Result<bool> {
        let n = self
            .conn
            .execute("DELETE FROM projects WHERE domain = ?1", params![domain])?;
        Ok(n > 0)
    }

    /// Update last_audited timestamp for a project, if it exists. No-op otherwise.
    pub fn touch_project_last_audited(&self, domain: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE projects SET last_audited = ?1 WHERE domain = ?2",
            params![Utc::now().to_rfc3339(), domain],
        )?;
        Ok(())
    }

    /// Returns all distinct domains tracked in the database.
    pub fn list_domains(&self) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT DISTINCT domain FROM mentions ORDER BY domain")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut domains = Vec::new();
        for row in rows {
            domains.push(row?);
        }
        Ok(domains)
    }

    /// Returns per-day mention stats for a domain within the given number of days.
    pub fn domain_stats(&self, domain: &str, days: u32) -> Result<Vec<DomainDayStat>> {
        let since = Utc::now() - chrono::Duration::days(days as i64);
        let mut stmt = self.conn.prepare(
            "SELECT DATE(timestamp) as day,
                    COUNT(*) as total,
                    SUM(mentioned) as mentioned,
                    SUM(cited) as cited
             FROM mentions
             WHERE domain = ?1 AND timestamp >= ?2
             GROUP BY DATE(timestamp)
             ORDER BY day DESC",
        )?;
        let rows = stmt.query_map(params![domain, since.to_rfc3339()], |row| {
            Ok(DomainDayStat {
                day: row.get::<_, String>(0)?,
                total: row.get::<_, i64>(1)? as usize,
                mentioned: row.get::<_, i64>(2)? as usize,
                cited: row.get::<_, i64>(3)? as usize,
            })
        })?;
        let mut stats = Vec::new();
        for row in rows {
            stats.push(row?);
        }
        Ok(stats)
    }

    // ── Publish snapshots ────────────────────────────────────────────────────

    /// Record a publish checkpoint with the current mention rate.
    pub fn record_publish_snapshot(
        &self,
        domain: &str,
        note: Option<&str>,
        mention_rate: f64,
        mention_count: usize,
        total_queries: usize,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO publish_snapshots
             (domain, note, mention_rate, mention_count, total_queries, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                domain,
                note,
                mention_rate,
                mention_count as i64,
                total_queries as i64,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    /// Returns all publish snapshots for a domain, newest first.
    pub fn list_publish_snapshots(&self, domain: &str) -> Result<Vec<PublishSnapshot>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, domain, note, mention_rate, mention_count, total_queries, timestamp
             FROM publish_snapshots WHERE domain = ?1 ORDER BY timestamp DESC",
        )?;
        let rows = stmt.query_map(params![domain], |row| {
            Ok(PublishSnapshot {
                id: row.get(0)?,
                domain: row.get(1)?,
                note: row.get(2)?,
                mention_rate: row.get(3)?,
                mention_count: row.get::<_, i64>(4)? as usize,
                total_queries: row.get::<_, i64>(5)? as usize,
                timestamp: row.get(6)?,
            })
        })?;
        let mut snaps = Vec::new();
        for r in rows {
            snaps.push(r?);
        }
        Ok(snaps)
    }

    /// Returns the most recent mention stats for a domain (last 7 days).
    pub fn current_mention_stats(&self, domain: &str) -> Result<(f64, usize, usize)> {
        let since = Utc::now() - chrono::Duration::days(7);
        let total: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM mentions WHERE domain=?1 AND timestamp>=?2",
            params![domain, since.to_rfc3339()],
            |r| r.get(0),
        )?;
        let mentioned: i64 = self.conn.query_row(
            "SELECT SUM(mentioned) FROM mentions WHERE domain=?1 AND timestamp>=?2",
            params![domain, since.to_rfc3339()],
            |r| r.get::<_, Option<i64>>(0).map(|v| v.unwrap_or(0)),
        )?;
        let rate = if total > 0 {
            (mentioned as f64 / total as f64) * 100.0
        } else {
            0.0
        };
        Ok((rate, mentioned as usize, total as usize))
    }

    /// Deletes records older than `days` days. Returns number of rows deleted.
    pub fn prune_old(&self, days: u32) -> Result<usize> {
        let cutoff = Utc::now() - chrono::Duration::days(days as i64);
        let deleted = self.conn.execute(
            "DELETE FROM mentions WHERE timestamp < ?1",
            params![cutoff.to_rfc3339()],
        )?;
        Ok(deleted)
    }
}

fn parse_position(s: &str) -> Position {
    match s {
        "Top" => Position::Top,
        "Middle" => Position::Middle,
        "Bottom" => Position::Bottom,
        _ => Position::NotMentioned,
    }
}

fn parse_sentiment(s: &str) -> Sentiment {
    match s {
        "Positive" => Sentiment::Positive,
        "Neutral" => Sentiment::Neutral,
        "Negative" => Sentiment::Negative,
        _ => Sentiment::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::DateTime;
    use tempfile::TempDir;

    fn mention_at(domain: &str, ts: &str, mentioned: bool) -> MentionResult {
        MentionResult {
            domain: domain.to_string(),
            prompt: "p".to_string(),
            model: "mock".to_string(),
            timestamp: DateTime::parse_from_rfc3339(ts)
                .unwrap()
                .with_timezone(&Utc),
            mentioned,
            cited: false,
            position: Position::NotMentioned,
            sentiment: Sentiment::Unknown,
            snippet: None,
            raw_response: "{}".to_string(),
        }
    }

    #[test]
    fn test_previous_run_stats_scoped_to_prior_batch() {
        let dir = TempDir::new().unwrap();
        let storage = Storage::open(&dir.path().to_path_buf()).unwrap();
        // Old batch (2026-01-01): 4 rows, 1 mentioned.
        for (i, m) in [true, false, false, false].iter().enumerate() {
            let mut r = mention_at("example.com", "2026-01-01T10:00:00Z", *m);
            r.prompt = format!("old-{i}");
            storage.insert(&r).unwrap();
        }
        // New batch (2026-01-02): 2 rows, both mentioned.
        for i in 0..2 {
            let mut r = mention_at("example.com", "2026-01-02T10:00:00Z", true);
            r.prompt = format!("new-{i}");
            storage.insert(&r).unwrap();
        }
        // Previous run relative to the new batch is the old batch only:
        // (1 mentioned, 4 total), not whole-history (3, 6). Timestamps use
        // the stored RFC3339 offset format so the new batch itself is
        // excluded by the strict `<` comparison.
        assert_eq!(
            storage
                .previous_run_stats("example.com", "2026-01-02T10:00:00+00:00")
                .unwrap(),
            Some((1, 4))
        );
        // A `before` after every batch resolves to the latest batch.
        assert_eq!(
            storage
                .previous_run_stats("example.com", "2026-01-03T00:00:00+00:00")
                .unwrap(),
            Some((2, 2))
        );
        // Nothing before the old batch.
        assert_eq!(
            storage
                .previous_run_stats("example.com", "2026-01-01T10:00:00+00:00")
                .unwrap(),
            None
        );
    }
}
