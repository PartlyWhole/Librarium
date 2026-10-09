//! A line-by-line three-way merge, for saves based on a version that has changed since.

use similar::{capture_diff_slices, Algorithm, DiffOp};

/// For each base line range a side changed: (start, end, replacement lines).
fn hunks<'a>(base: &[&'a str], side: &[&'a str]) -> Vec<(usize, usize, Vec<&'a str>)> {
    capture_diff_slices(Algorithm::Myers, base, side)
        .into_iter()
        .filter_map(|op| match op {
            DiffOp::Equal { .. } => None,
            DiffOp::Delete { old_index, old_len, .. } => Some((old_index, old_index + old_len, vec![])),
            DiffOp::Insert { old_index, new_index, new_len } => {
                Some((old_index, old_index, side[new_index..new_index + new_len].to_vec()))
            }
            DiffOp::Replace { old_index, old_len, new_index, new_len } => {
                Some((old_index, old_index + old_len, side[new_index..new_index + new_len].to_vec()))
            }
        })
        .collect()
}

/// Merges `ours` and `theirs`, both edited from `base`, line by line. `None` when their edits
/// overlap (identical edits merge).
pub fn merge3(base: &str, ours: &str, theirs: &str) -> Option<String> {
    if ours == theirs || theirs == base {
        return Some(ours.to_string());
    }
    if ours == base {
        return Some(theirs.to_string());
    }
    let (b, o, t): (Vec<&str>, Vec<&str>, Vec<&str>) = (
        base.split_inclusive('\n').collect(),
        ours.split_inclusive('\n').collect(),
        theirs.split_inclusive('\n').collect(),
    );
    let (ho, ht) = (hunks(&b, &o), hunks(&b, &t));
    let mut out = String::new();
    let (mut i, mut j, mut pos) = (0, 0, 0);
    loop {
        let (hunk, take_o, take_t) = match (ho.get(i), ht.get(j)) {
            (None, None) => break,
            (Some(a), None) => (a, true, false),
            (None, Some(c)) => (c, false, true),
            (Some(a), Some(c)) => {
                let overlap = (a.0 < c.1.max(c.0 + 1) && c.0 < a.1.max(a.0 + 1)) || a.0 == c.0;
                match (overlap, a == c) {
                    (true, true) => (a, true, true),
                    (true, false) => return None,
                    _ if a.0 < c.0 => (a, true, false),
                    _ => (c, false, true),
                }
            }
        };
        let (start, end, repl) = hunk;
        if *start < pos {
            return None;
        }
        out.extend(b[pos..*start].iter().copied());
        out.extend(repl.iter().copied());
        pos = *end;
        i += take_o as usize;
        j += take_t as usize;
    }
    out.extend(b[pos..].iter().copied());
    Some(out)
}
