//! Registries: ordered, and duplicate IDs are rejected at startup.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DuplicateId {
    pub slot: &'static str,
    pub id: String,
}

impl fmt::Display for DuplicateId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "slot {} already has a contribution with id {:?}", self.slot, self.id)
    }
}

/// One contribution, remembered with the module that made it.
#[derive(Debug, Clone)]
pub struct Entry<T> {
    pub id: String,
    pub contributor: String,
    pub value: T,
}

/// A slot's registry: contributions in an explicit order (registration order).
#[derive(Debug, Clone)]
pub struct Registry<T> {
    slot: &'static str,
    entries: Vec<Entry<T>>,
}

impl<T> Registry<T> {
    pub fn new(slot: &'static str) -> Self {
        Registry { slot, entries: Vec::new() }
    }
    pub fn slot(&self) -> &'static str {
        self.slot
    }
    pub fn add(&mut self, contributor: &str, id: &str, value: T) -> Result<(), DuplicateId> {
        if self.entries.iter().any(|e| e.id == id) {
            return Err(DuplicateId { slot: self.slot, id: id.to_string() });
        }
        self.entries.push(Entry { id: id.to_string(), contributor: contributor.to_string(), value });
        Ok(())
    }
    pub fn get(&self, id: &str) -> Option<&T> {
        self.entries.iter().find(|e| e.id == id).map(|e| &e.value)
    }
    pub fn iter(&self) -> impl Iterator<Item = &Entry<T>> {
        self.entries.iter()
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    /// (id, contributor) pairs, for the architecture report.
    pub fn contributors(&self) -> Vec<(String, String)> {
        self.entries.iter().map(|e| (e.id.clone(), e.contributor.clone())).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_order_and_rejects_duplicates() {
        let mut r = Registry::new("test.slot");
        r.add("a", "one", 1).unwrap();
        r.add("b", "two", 2).unwrap();
        assert_eq!(r.add("c", "one", 3).unwrap_err().id, "one");
        let ids: Vec<_> = r.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["one", "two"]);
        assert_eq!(r.get("two"), Some(&2));
    }
}
