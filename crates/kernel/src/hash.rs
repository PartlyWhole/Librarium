//! A record's version is its content hash.

use sha2::{Digest, Sha256};

pub fn version_of(bytes: &[u8]) -> String {
    let d = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in d {
        s.push_str(&format!("{b:02x}"));
    }
    s
}
