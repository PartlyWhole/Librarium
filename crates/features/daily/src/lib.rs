//! Daily: any note can be a day. A daily note is an ordinary note with `daily.date`, a local
//! calendar date fixed at creation. The day starts at 4 a.m. unless the user changes it.

use librarium_contracts::api::Written;
use librarium_contracts::Result;
use librarium_kernel::frontmatter::FmValue;
use librarium_kernel::kinds::{Kinds, SlugField};
use librarium_kernel::methods::{ApiMethod, MethodCtx};
use librarium_kernel::registry::{DuplicateId, Registry};
use librarium_kernel::writer::Lane;
use serde_json::{json, Value};
use std::sync::Arc;

pub const ID: &str = "daily";
pub const DATE_FIELD: &str = "daily.date";
/// The per-device setting: the hour the day starts.
pub const DAY_START: &str = "daily.dayStart";
pub const DEFAULT_DAY_START: u32 = 4;
const NOTE: &str = "note";

/// A daily note's slug is its date.
pub fn contribute_kinds(k: &mut Kinds) -> Result<(), DuplicateId> {
    k.add_slug_field(ID, SlugField { kind: NOTE.into(), field: DATE_FIELD.into() })
}

pub fn contribute_methods(r: &mut Registry<ApiMethod>) -> Result<(), DuplicateId> {
    r.add(ID, "daily.today", Arc::new(|ctx: &MethodCtx, _p: Value| Ok(serde_json::to_value(today(ctx)?).unwrap())))?;
    Ok(())
}

/// Today's date, as the user's day counts it.
pub fn today_date(ctx: &MethodCtx) -> String {
    let start =
        (ctx.setting)(DAY_START).and_then(|v| v.as_u64()).map(|h| h.min(12) as u32).unwrap_or(DEFAULT_DAY_START);
    let clock = &ctx.library.store.clock;
    let now = clock.now_ms();
    librarium_kernel::time::local_date(now, clock.local_offset_s(now), start)
}

/// Opens or creates today's note: one writer operation, so two presses never make two notes.
/// Waits for the startup check. With two notes for a date, the earlier one opens.
pub fn today(ctx: &MethodCtx) -> Result<Written> {
    ctx.library.store.wait_ready();
    let date = today_date(ctx);
    let (e, seq) = ctx.library.write(Lane::Interactive, move |tx| {
        let mut found = tx.store.find_by_field(Some(NOTE), DATE_FIELD, &json!(date));
        found.sort_by(|a, b| a.created.cmp(&b.created).then(a.id.cmp(&b.id)));
        match found.into_iter().next() {
            Some(e) => Ok((e, tx.store.changes.last_seq())),
            None => tx.create(NOTE, &date, vec![(DATE_FIELD.into(), FmValue::Str(date.clone()))], "", None),
        }
    })?;
    Ok(Written { info: e.info(), seq })
}
