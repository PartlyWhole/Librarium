//! Identity: UUID v7 (RFC 9562), always in canonical lowercase form.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::str::FromStr;
use ts_rs::TS;

/// A permanent record ID, independent of the record's name and location.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, TS)]
#[ts(type = "string")]
pub struct Id(uuid::Uuid);

impl Id {
    pub fn from_uuid(u: uuid::Uuid) -> Self {
        Id(u)
    }
    pub fn as_uuid(&self) -> &uuid::Uuid {
        &self.0
    }
    /// Parses only the canonical form: 36 characters, lowercase hex, hyphenated.
    pub fn parse_canonical(s: &str) -> Option<Id> {
        let b = s.as_bytes();
        if b.len() != 36 {
            return None;
        }
        for (i, c) in b.iter().enumerate() {
            let ok = match i {
                8 | 13 | 18 | 23 => *c == b'-',
                _ => c.is_ascii_digit() || (b'a'..=b'f').contains(c),
            };
            if !ok {
                return None;
            }
        }
        uuid::Uuid::parse_str(s).ok().map(Id)
    }
    /// Parses any form the uuid crate accepts (used when repairing damaged IDs).
    pub fn parse_lenient(s: &str) -> Option<Id> {
        uuid::Uuid::parse_str(s.trim()).ok().map(Id)
    }
}

impl fmt::Display for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0.hyphenated())
    }
}
impl fmt::Debug for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Id({})", self.0.hyphenated())
    }
}
impl FromStr for Id {
    type Err = String;
    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        Id::parse_canonical(s).ok_or_else(|| format!("not a canonical UUID: {s}"))
    }
}
impl Serialize for Id {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}
impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        s.parse().map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_round_trip() {
        let s = "0192f3a4-7c1e-7b2a-9f00-3e5d8c1a2b44";
        let id: Id = s.parse().unwrap();
        assert_eq!(id.to_string(), s);
        assert_eq!(serde_json::to_string(&id).unwrap(), format!("\"{s}\""));
    }

    #[test]
    fn rejects_non_canonical() {
        assert!(Id::parse_canonical("0192F3A4-7C1E-7B2A-9F00-3E5D8C1A2B44").is_none());
        assert!(Id::parse_canonical("0192f3a47c1e7b2a9f003e5d8c1a2b44").is_none());
        assert!(Id::parse_canonical("{0192f3a4-7c1e-7b2a-9f00-3e5d8c1a2b44}").is_none());
        assert!(Id::parse_lenient("0192F3A4-7C1E-7B2A-9F00-3E5D8C1A2B44").is_some());
    }
}
