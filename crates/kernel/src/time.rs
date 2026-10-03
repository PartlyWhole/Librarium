//! Dates without a calendar crate: ISO 8601 in UTC, and local calendar dates.

/// Days since 1970-01-01 → (year, month, day). Howard Hinnant's civil_from_days.
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// "2026-10-02T09:14:00Z"
pub fn iso_utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let s = secs.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", s / 3600, (s / 60) % 60, s % 60)
}

/// "2026-10-02T091400Z": safe in file names.
pub fn iso_compact(ms: i64) -> String {
    iso_utc(ms).replace(':', "")
}

/// The local calendar date a moment belongs to, when the day starts at `day_start_hour`.
/// Writing at 1 a.m. with the default 4 a.m. start lands on the previous day.
pub fn local_date(ms: i64, offset_s: i32, day_start_hour: u32) -> String {
    let local = ms.div_euclid(1000) + offset_s as i64 - day_start_hour as i64 * 3600;
    let (y, m, d) = civil_from_days(local.div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

/// Parses "YYYY-MM-DD".
pub fn parse_date(s: &str) -> Option<(i64, u32, u32)> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y = s[0..4].parse().ok()?;
    let m: u32 = s[5..7].parse().ok()?;
    let d: u32 = s[8..10].parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let back = civil_from_days(days_from_civil(y, m, d));
    (back == (y, m, d)).then_some((y, m, d))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats() {
        assert_eq!(iso_utc(1_790_932_440_000), "2026-10-02T09:14:00Z");
        assert_eq!(iso_compact(1_790_932_440_000), "2026-10-02T091400Z");
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn local_dates_and_day_start() {
        // 2026-10-02T09:14Z in UTC-7 is 02:14 local: before 4 a.m., so still Oct 1.
        assert_eq!(local_date(1_790_932_440_000, -7 * 3600, 4), "2026-10-01");
        assert_eq!(local_date(1_790_932_440_000, -7 * 3600, 0), "2026-10-02");
        assert_eq!(local_date(1_790_932_440_000, 2 * 3600, 4), "2026-10-02");
    }

    #[test]
    fn round_trips() {
        for days in [-1000, 0, 19_000, 20_728, 60_000] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
        assert_eq!(parse_date("2026-02-29"), None);
        assert_eq!(parse_date("2028-02-29"), Some((2028, 2, 29)));
    }
}
