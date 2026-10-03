//! Clock and IdGenerator ports: the system clock and UUID v7 (RFC 9562).

use librarium_contracts::ports::{Clock, IdGenerator};
use librarium_contracts::Id;

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
        d.as_millis() as i64
    }
    fn local_offset_s(&self, at_ms: i64) -> i32 {
        let t: libc::time_t = (at_ms.div_euclid(1000)) as libc::time_t;
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        // SAFETY: localtime_r writes into our tm and reads only t.
        let ok = unsafe { !libc::localtime_r(&t, &mut tm).is_null() };
        if ok {
            tm.tm_gmtoff as i32
        } else {
            0
        }
    }
}

/// UUID v7: time-ordered, random in the low bits. Monotonic within this process.
pub struct UuidV7;

impl IdGenerator for UuidV7 {
    fn next_id(&self) -> Id {
        Id::from_uuid(uuid::Uuid::now_v7())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_v7_canonical_and_ordered() {
        let g = UuidV7;
        let a = g.next_id();
        let b = g.next_id();
        assert_eq!(a.as_uuid().get_version_num(), 7);
        assert!(a < b);
        assert!(Id::parse_canonical(&a.to_string()).is_some());
    }

    #[test]
    fn clock_is_after_2026() {
        assert!(SystemClock.now_ms() > 1_767_225_600_000);
    }
}
