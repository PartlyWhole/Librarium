/**
 * A quotation as it reads, not as it was laid out on the page: line breaks inside a paragraph
 * become spaces, a word hyphenated across a line is joined again ("suf-" + "fering"; a hyphen
 * before a capital stays, as in "Indo-European"), a dash at
 * the end of a line joins without a space, and paragraph breaks stay. (What anchors a capture,
 * its exact quote, keeps the source's text unchanged; this is for showing and storing the
 * quotation.)
 */
export function flowQuote(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((para) =>
      para
        .replace(/(\p{L})[-\u00AD]\n[ \t]*(\p{Ll})/gu, "$1$2")
        .replace(/(\p{L})-\n[ \t]*(\p{Lu})/gu, "$1-$2")
        .replace(/([—–])[ \t]*\n[ \t]*/g, "$1")
        .replace(/[ \t]*\n[ \t]*/g, " ")
        .replace(/[ \t]{2,}/g, " ")
        .trim(),
    )
    .filter(Boolean)
    .join("\n\n");
}
