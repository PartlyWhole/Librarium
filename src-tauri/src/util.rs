//! Small shared helpers: IDs, slugs, hashes, time and the JSON the app writes.

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

/// A record's permanent ID: a UUID v7, always written in canonical form.
pub type Id = uuid::Uuid;

pub fn new_id() -> Id {
    uuid::Uuid::now_v7()
}

/// Parses only the canonical form: 36 characters, lowercase hex, hyphens at 8, 13, 18, 23.
/// Uppercase or short forms are damaged IDs.
pub fn parse_id(s: &str) -> Option<Id> {
    let b = s.as_bytes();
    let ok = b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_digit() || (b'a'..=b'f').contains(c),
        });
    ok.then(|| uuid::Uuid::parse_str(s).ok()).flatten()
}

/// The version of a file: the lowercase hex SHA-256 of its bytes.
pub fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

const SLUG_MAX: usize = 60;

/// "  Éthique — et  Technique! " → "ethique-et-technique": accents dropped, other letters
/// kept, runs of anything else become one hyphen.
pub fn slugify(title: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in title.nfd() {
        if unicode_normalization::char::is_combining_mark(c) {
            continue;
        }
        if c.is_alphanumeric() {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.extend(c.to_lowercase());
        } else {
            dash = true;
        }
        if out.chars().count() >= SLUG_MAX {
            break;
        }
    }
    out.nfc().collect()
}

/// A title as stored: lines trimmed, empty lines dropped, the rest joined with one space.
pub fn clean_title(t: &str) -> String {
    t.split(['\n', '\r']).map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ")
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Days since 1970-01-01 → (year, month, day) (Howard Hinnant's civil_from_days).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// "2026-10-02T09:14:00Z"
pub fn iso_utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let s = secs.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", s / 3600, (s / 60) % 60, s % 60)
}

/// The local calendar date a moment belongs to, when the day starts at `day_start` o'clock:
/// writing at 1 a.m. with the day starting at 4 lands on the day before.
pub fn local_date(ms: i64, offset_s: i64, day_start: u32) -> String {
    let local = ms.div_euclid(1000) + offset_s - day_start as i64 * 3600;
    let (y, m, d) = civil_from_days(local.div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

/// This Mac's offset from UTC at a moment, in seconds.
pub fn local_offset_s(ms: i64) -> i64 {
    let t = ms.div_euclid(1000) as libc::time_t;
    // SAFETY: an all-zero `tm` is valid; localtime_r only writes into it and reads `t`.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: both pointers are valid for the call.
    let ok = unsafe { !libc::localtime_r(&t, &mut tm).is_null() };
    if ok {
        tm.tm_gmtoff
    } else {
        0
    }
}

/// JSON as the app writes it: pretty, 2-space indent, keys sorted by byte order at every
/// level, non-ASCII literal, `/` not escaped.
pub fn json_bytes(v: &Value, trailing_newline: bool) -> Vec<u8> {
    let mut out = serde_json::to_vec_pretty(&sorted(v)).expect("JSON values always serialise");
    if trailing_newline {
        out.push(b'\n');
    }
    out
}

fn sorted(v: &Value) -> Value {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            Value::Object(keys.into_iter().map(|k| (k.clone(), sorted(&m[k]))).collect::<Map<_, _>>())
        }
        Value::Array(a) => Value::Array(a.iter().map(sorted).collect()),
        other => other.clone(),
    }
}
