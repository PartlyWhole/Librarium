//! Three-way merge of text, line by line (diff3). A clean merge is applied automatically;
//! otherwise both versions are shown.

use similar::{capture_diff_slices, Algorithm, DiffOp};

/// For each base line range changed by a side: (base_start, base_end, replacement lines).
fn hunks<'a>(base: &[&'a str], side: &[&'a str]) -> Vec<(usize, usize, Vec<&'a str>)> {
    let mut out = vec![];
    for op in capture_diff_slices(Algorithm::Myers, base, side) {
        match op {
            DiffOp::Equal { .. } => {}
            DiffOp::Delete { old_index, old_len, .. } => out.push((old_index, old_index + old_len, vec![])),
            DiffOp::Insert { old_index, new_index, new_len } => {
                out.push((old_index, old_index, side[new_index..new_index + new_len].to_vec()))
            }
            DiffOp::Replace { old_index, old_len, new_index, new_len } => {
                out.push((old_index, old_index + old_len, side[new_index..new_index + new_len].to_vec()))
            }
        }
    }
    out
}

fn lines(s: &str) -> Vec<&str> {
    s.split_inclusive('\n').collect()
}

/// Merges `ours` and `theirs`, both edited from `base`. `None` when they conflict.
pub fn merge3(base: &str, ours: &str, theirs: &str) -> Option<String> {
    if ours == theirs || theirs == base {
        return Some(ours.to_string());
    }
    if ours == base {
        return Some(theirs.to_string());
    }
    let (b, o, t) = (lines(base), lines(ours), lines(theirs));
    let (ho, ht) = (hunks(&b, &o), hunks(&b, &t));
    // Merge hunks in base order; overlapping or touching hunks from both sides conflict
    // unless identical.
    let mut out = String::new();
    let (mut i, mut j, mut pos) = (0, 0, 0);
    loop {
        let next = match (ho.get(i), ht.get(j)) {
            (None, None) => break,
            (Some(a), None) => (a.clone(), true, false),
            (None, Some(c)) => (c.clone(), false, true),
            (Some(a), Some(c)) => {
                let overlap = a.0 < c.1.max(c.0 + 1) && c.0 < a.1.max(a.0 + 1) || (a.0 == c.0);
                if overlap {
                    if a == c {
                        (a.clone(), true, true)
                    } else {
                        return None;
                    }
                } else if a.0 < c.0 {
                    (a.clone(), true, false)
                } else {
                    (c.clone(), false, true)
                }
            }
        };
        let ((start, end, repl), adv_o, adv_t) = next;
        if start < pos {
            return None;
        }
        out.extend(b[pos..start].iter().copied());
        out.extend(repl.iter().copied());
        pos = end;
        if adv_o {
            i += 1;
        }
        if adv_t {
            j += 1;
        }
    }
    out.extend(b[pos..].iter().copied());
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::merge3;

    #[test]
    fn merges_separate_edits() {
        let base = "a\nb\nc\nd\n";
        assert_eq!(merge3(base, "A\nb\nc\nd\n", "a\nb\nc\nD\n").as_deref(), Some("A\nb\nc\nD\n"));
        assert_eq!(merge3(base, "a\nb\nx\nc\nd\n", "a\nb\nc\nd\ne\n").as_deref(), Some("a\nb\nx\nc\nd\ne\n"));
        assert_eq!(merge3(base, base, "z\n").as_deref(), Some("z\n"));
    }

    #[test]
    fn refuses_overlapping_edits() {
        assert_eq!(merge3("a\nb\nc\n", "a\nB\nc\n", "a\nβ\nc\n"), None);
        assert_eq!(merge3("a\n", "a\nx\n", "a\ny\n"), None);
    }

    #[test]
    fn identical_edits_merge() {
        assert_eq!(merge3("a\nb\n", "a\nB\n", "a\nB\n").as_deref(), Some("a\nB\n"));
    }
}
