//! Business clock. The *business date* ("today" for leave rules) comes from
//! `settings.demo_today` in demo mode and from the real clock in production.
//! `now_utc()` is the real timestamp used for created_at columns — except under
//! a fixed clock, which exists for tests and for the demo seed time-travel.

use rusqlite::Connection;
use time::format_description::well_known::Rfc3339;
use time::macros::time;
use time::{Date, OffsetDateTime};

use crate::Res;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Demo,
    Production,
}

#[derive(Clone, Debug)]
pub struct Clock {
    mode: Mode,
    fixed_today: Option<Date>,
    fixed_now: Option<OffsetDateTime>,
}

impl Clock {
    pub fn demo() -> Self {
        Self { mode: Mode::Demo, fixed_today: None, fixed_now: None }
    }

    pub fn production() -> Self {
        Self { mode: Mode::Production, fixed_today: None, fixed_now: None }
    }

    /// Fully deterministic clock for tests / seed time travel.
    /// `now` is pinned to `today` at 12:00 UTC.
    pub fn fixed(today: Date) -> Self {
        Self {
            mode: Mode::Demo,
            fixed_today: Some(today),
            fixed_now: Some(today.with_time(time!(12:00)).assume_utc()),
        }
    }

    /// Deterministic clock with an explicit timestamp.
    pub fn fixed_at(today: Date, now: OffsetDateTime) -> Self {
        Self { mode: Mode::Demo, fixed_today: Some(today), fixed_now: Some(now) }
    }

    /// Business date per DESIGN §1.
    pub fn today(&self, conn: &Connection) -> Res<Date> {
        if let Some(d) = self.fixed_today {
            return Ok(d);
        }
        match self.mode {
            Mode::Production => Ok(OffsetDateTime::now_utc().date()),
            Mode::Demo => {
                let s: Option<String> = conn
                    .query_row(
                        "SELECT value FROM settings WHERE key='demo_today'",
                        [],
                        |r| r.get(0),
                    )
                    .ok();
                match s {
                    Some(v) => crate::model::parse_date(&v),
                    None => Ok(OffsetDateTime::now_utc().date()),
                }
            }
        }
    }

    pub fn now(&self) -> OffsetDateTime {
        self.fixed_now.unwrap_or_else(OffsetDateTime::now_utc)
    }

    /// RFC3339 UTC timestamp for `created_at` columns.
    pub fn now_ts(&self) -> String {
        self.now()
            .format(&Rfc3339)
            .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
    }
}
