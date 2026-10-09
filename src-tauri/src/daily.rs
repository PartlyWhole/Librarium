//! Daily notes: an ordinary note with `daily.date`, a local date fixed at creation. The day
//! starts at 4 a.m. unless the user chooses otherwise, so writing after midnight lands on the
//! day it belongs to.

use crate::error::Result;
use crate::store::frontmatter::FmValue;
use crate::store::{record, save, Library};
use crate::types::Written;
use crate::util::{local_date, local_offset_s, now_ms};

pub const DATE_FIELD: &str = "daily.date";
pub const DEFAULT_DAY_START: u32 = 4;

/// Opens or creates today's note, under the write lock, so two presses never make two. With
/// two notes for one date, the earlier one opens.
pub fn today(lib: &Library, day_start: Option<u32>) -> Result<Written> {
    let now = now_ms();
    let date = local_date(now, local_offset_s(now), day_start.unwrap_or(DEFAULT_DAY_START).min(12));
    let w = lib.write();
    let mut found: Vec<_> = lib.index.with_field(DATE_FIELD, &date)?.into_iter().filter(|e| e.kind == "note").collect();
    found.sort_by(|a, b| a.created.cmp(&b.created).then(a.id.cmp(&b.id)));
    let e = match found.into_iter().next() {
        Some(e) => e,
        None => save::create(&w, "note", &date, vec![(DATE_FIELD.into(), FmValue::Str(date.clone()))], "", None)?,
    };
    Ok(Written { info: record::info(lib, &e), seq: w.seq() })
}
