//! File-name slugs that follow the title.

use unicode_normalization::UnicodeNormalization;

const MAX: usize = 60;

/// "Jacques Ellul: la Technique" → "jacques-ellul-la-technique". Accents are dropped, other
/// letters kept; everything else becomes a single hyphen.
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
        if out.chars().count() >= MAX {
            break;
        }
    }
    out.nfc().collect()
}

#[cfg(test)]
mod tests {
    use super::slugify;

    #[test]
    fn slugs() {
        assert_eq!(slugify("Jacques Ellul"), "jacques-ellul");
        assert_eq!(slugify("  Éthique — et  Technique! "), "ethique-et-technique");
        assert_eq!(slugify("2026-10-02"), "2026-10-02");
        assert_eq!(slugify("技術と社会"), "技術と社会");
        assert_eq!(slugify("???"), "");
        assert!(slugify(&"word ".repeat(40)).chars().count() <= 64);
    }
}
