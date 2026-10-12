"""
Builds bible.db: English Bibles, the Hebrew and Greek texts word by word, and their lexicons,
in one SQLite file, every verse addressed the same way so that versions line up.

    python3 tools/bible/build.py --cache <dir> -o bible.db

Sources (downloaded into the cache once; nothing else is read):
- STEPBible-Data (Tyndale House, Cambridge; CC BY 4.0), at a pinned commit: TAHOT (Hebrew OT)
  and TAGNT (Greek NT) word by word; TBESH and TBESG (brief lexicons); TEHMC and TEGMC (what
  the grammar codes mean). TBESH's long definitions (Abridged BDB, used by STEPBible with
  permission from OnlineBible) are left out; its glosses are kept.
- eBible.org USFM: KJV with Strong's (eng-kjv2006), YLT, LSV (CC BY-SA 4.0), ASV, Darby, RV,
  WEB. Only the KJV's Strong's numbers are kept: eBible's on the others are machine-made and
  often wrong.
- bereanbible.com: the BSB (public domain) as USFM, and its tables, which align each English
  phrase with the Hebrew or Greek word it translates.

Verses are addressed by STEPBible's book names (Gen … Rev) and English (KJV) chapter and verse
numbers. A Psalm's title is its verse 0, as in STEPBible. The Hebrew text's own numbering, where
it differs, is kept beside each Hebrew word.

Standard library only (Python 3.9+).
"""
from __future__ import annotations

import argparse
import csv
import datetime
import hashlib
import io
import json
import os
import re
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
import zipfile

SCHEMA_VERSION = "1"
AGENT = "Librarium-bible-builder/1"
STEP_COMMIT = "aca7d691414e00b0d669157d98bfd68195e64e1e"
STEP = f"https://raw.githubusercontent.com/STEPBible/STEPBible-Data/{STEP_COMMIT}/"
STEP_FILES = {
    "tahot": [f"Translators Amalgamated OT+NT/TAHOT {r} - Translators Amalgamated Hebrew OT - STEPBible.org CC BY.txt" for r in ("Gen-Deu", "Jos-Est", "Job-Sng", "Isa-Mal")],
    "tagnt": [f"Translators Amalgamated OT+NT/TAGNT {r} - Translators Amalgamated Greek NT - STEPBible.org CC-BY.txt" for r in ("Mat-Jhn", "Act-Rev")],
    "tbesh": ["Lexicons/TBESH - Translators Brief lexicon of Extended Strongs for Hebrew - STEPBible.org CC BY.txt"],
    "tbesg": ["Lexicons/TBESG - Translators Brief lexicon of Extended Strongs for Greek - STEPBible.org CC BY.txt"],
    "tehmc": ["Morphology codes/TEHMC - Translators Expansion of Hebrew Morphology Codes - STEPBible.org CC BY.txt"],
    "tegmc": ["Morphology codes/TEGMC - Translators Expansion of Greek Morphhology Codes - STEPBible.org CC BY.txt"],
}

# id, name, year, source zip, licence, attribution, whether its Strong's numbers are kept
VERSIONS = [
    ("kjv", "King James Version", 1769, "https://ebible.org/Scriptures/eng-kjv2006_usfm.zip", "Public domain",
     "King James Version (1769), with Strong's numbers, from the CrossWire Bible Society via eBible.org.", True),
    ("bsb", "Berean Standard Bible", 2023, "https://bereanbible.com/bsb_usfm.zip", "Public domain",
     "The Holy Bible, Berean Standard Bible, BSB is produced in cooperation with Bible Hub, Discovery Bible, OpenBible.com, and the Berean Bible Translation Committee. Dedicated to the public domain.", False),
    ("ylt", "Young's Literal Translation", 1898, "https://ebible.org/Scriptures/engylt_usfm.zip", "Public domain",
     "Young's Literal Translation (1898), via eBible.org.", False),
    ("lsv", "Literal Standard Version", 2020, "https://ebible.org/Scriptures/englsv_usfm.zip", "CC BY-SA 4.0",
     "Literal Standard Version (LSV), © 2020 Covenant Press, CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/), via eBible.org. Changed: footnotes, headings and eBible's word tags left out.", False),
    ("asv", "American Standard Version", 1901, "https://ebible.org/Scriptures/eng-asv_usfm.zip", "Public domain",
     "American Standard Version (1901), via eBible.org.", False),
    ("rv", "Revised Version", 1885, "https://ebible.org/Scriptures/eng-rv_usfm.zip", "Public domain",
     "Revised Version (NT 1881, OT 1885), via eBible.org.", False),
    ("dby", "Darby Translation", 1890, "https://ebible.org/Scriptures/engDBY_usfm.zip", "Public domain",
     "Darby Translation (1890), via eBible.org.", False),
    ("web", "World English Bible", 2020, "https://ebible.org/Scriptures/engwebp_usfm.zip", "Public domain",
     "World English Bible (2020 text), public domain, via eBible.org. \"World English Bible\" is a trademark of eBible.org.", False),
]
BSB_TABLES = "https://bereanbible.com/bsb_tables.tsv"
STEP_ATTRIBUTION = ("Hebrew and Greek texts, lexicons and grammar codes: STEP Bible (www.STEPBible.org), "
                    "based on work at Tyndale House, Cambridge; CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/), "
                    f"from github.com/STEPBible/STEPBible-Data at {STEP_COMMIT[:12]}. Changed: reformatted into tables; "
                    "TBESH's long definitions (Abridged BDB) left out.")

# STEPBible's book names, in order, with USFM's codes and the English names the BSB tables use.
BOOKS = [
    ("Gen", "GEN", "Genesis"), ("Exo", "EXO", "Exodus"), ("Lev", "LEV", "Leviticus"), ("Num", "NUM", "Numbers"),
    ("Deu", "DEU", "Deuteronomy"), ("Jos", "JOS", "Joshua"), ("Jdg", "JDG", "Judges"), ("Rut", "RUT", "Ruth"),
    ("1Sa", "1SA", "1 Samuel"), ("2Sa", "2SA", "2 Samuel"), ("1Ki", "1KI", "1 Kings"), ("2Ki", "2KI", "2 Kings"),
    ("1Ch", "1CH", "1 Chronicles"), ("2Ch", "2CH", "2 Chronicles"), ("Ezr", "EZR", "Ezra"), ("Neh", "NEH", "Nehemiah"),
    ("Est", "EST", "Esther"), ("Job", "JOB", "Job"), ("Psa", "PSA", "Psalms"), ("Pro", "PRO", "Proverbs"),
    ("Ecc", "ECC", "Ecclesiastes"), ("Sng", "SNG", "Song of Solomon"), ("Isa", "ISA", "Isaiah"), ("Jer", "JER", "Jeremiah"),
    ("Lam", "LAM", "Lamentations"), ("Ezk", "EZK", "Ezekiel"), ("Dan", "DAN", "Daniel"), ("Hos", "HOS", "Hosea"),
    ("Jol", "JOL", "Joel"), ("Amo", "AMO", "Amos"), ("Oba", "OBA", "Obadiah"), ("Jon", "JON", "Jonah"),
    ("Mic", "MIC", "Micah"), ("Nam", "NAM", "Nahum"), ("Hab", "HAB", "Habakkuk"), ("Zep", "ZEP", "Zephaniah"),
    ("Hag", "HAG", "Haggai"), ("Zec", "ZEC", "Zechariah"), ("Mal", "MAL", "Malachi"),
    ("Mat", "MAT", "Matthew"), ("Mrk", "MRK", "Mark"), ("Luk", "LUK", "Luke"), ("Jhn", "JHN", "John"),
    ("Act", "ACT", "Acts"), ("Rom", "ROM", "Romans"), ("1Co", "1CO", "1 Corinthians"), ("2Co", "2CO", "2 Corinthians"),
    ("Gal", "GAL", "Galatians"), ("Eph", "EPH", "Ephesians"), ("Php", "PHP", "Philippians"), ("Col", "COL", "Colossians"),
    ("1Th", "1TH", "1 Thessalonians"), ("2Th", "2TH", "2 Thessalonians"), ("1Ti", "1TI", "1 Timothy"), ("2Ti", "2TI", "2 Timothy"),
    ("Tit", "TIT", "Titus"), ("Phm", "PHM", "Philemon"), ("Heb", "HEB", "Hebrews"), ("Jas", "JAS", "James"),
    ("1Pe", "1PE", "1 Peter"), ("2Pe", "2PE", "2 Peter"), ("1Jn", "1JN", "1 John"), ("2Jn", "2JN", "2 John"),
    ("3Jn", "3JN", "3 John"), ("Jud", "JUD", "Jude"), ("Rev", "REV", "Revelation"),
]
BOOK_IDS = {b[0] for b in BOOKS}
FROM_USFM = {u: b for b, u, _ in BOOKS}
FROM_NAME = {n: b for b, _, n in BOOKS} | {"Psalm": "Psa", "Song of Songs": "Sng"}

SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE books (id TEXT PRIMARY KEY, ord INTEGER NOT NULL, name TEXT NOT NULL, testament TEXT NOT NULL);
CREATE TABLE versions (id TEXT PRIMARY KEY, ord INTEGER NOT NULL, name TEXT NOT NULL, year INTEGER,
  license TEXT NOT NULL, attribution TEXT NOT NULL, source TEXT NOT NULL, strongs INTEGER NOT NULL);
-- One row per verse of each English version; verse 0 is a Psalm's title.
CREATE TABLE verses (version TEXT NOT NULL, book TEXT NOT NULL, chapter INTEGER NOT NULL, verse INTEGER NOT NULL,
  text TEXT NOT NULL, UNIQUE (version, book, chapter, verse));
-- A verse's words in an English version with Strong's numbers (KJV, BSB), in reading order:
-- `text` is what is read (with the spaces and punctuation around it), `strongs` what it translates.
CREATE TABLE tags (version TEXT NOT NULL, book TEXT NOT NULL, chapter INTEGER NOT NULL, verse INTEGER NOT NULL,
  pos INTEGER NOT NULL, text TEXT NOT NULL, strongs TEXT, PRIMARY KEY (version, book, chapter, verse, pos)) WITHOUT ROWID;
-- The Hebrew and Greek texts word by word (TAHOT, TAGNT), in the English numbering.
CREATE TABLE words (id INTEGER PRIMARY KEY, book TEXT NOT NULL, chapter INTEGER NOT NULL, verse INTEGER NOT NULL,
  pos TEXT NOT NULL, lang TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, translit TEXT, gloss TEXT,
  strongs TEXT, strongs_all TEXT, grammar TEXT, lemma TEXT, own_ref TEXT, editions TEXT);
CREATE INDEX words_verse ON words (book, chapter, verse);
CREATE INDEX words_strongs ON words (strongs);
CREATE INDEX tags_strongs ON tags (strongs);
-- Brief lexicons (TBESH, TBESG), by extended Strong's number.
CREATE TABLE lexicon (strongs TEXT PRIMARY KEY, base TEXT NOT NULL, lang TEXT NOT NULL, lemma TEXT,
  translit TEXT, grammar TEXT, gloss TEXT, definition TEXT, relation TEXT) WITHOUT ROWID;
CREATE INDEX lexicon_base ON lexicon (base);
-- What grammar codes mean (TEHMC, TEGMC).
CREATE TABLE grammar (code TEXT PRIMARY KEY, lang TEXT NOT NULL, brief TEXT, description TEXT) WITHOUT ROWID;
CREATE VIRTUAL TABLE verses_fts USING fts5 (text, content='verses', content_rowid=rowid, tokenize='unicode61 remove_diacritics 2');
"""


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def fetch(url: str, cache: str) -> str:
    """The file at `url`, from the cache (downloaded there once, with a few tries)."""
    name = hashlib.sha1(url.encode()).hexdigest()[:10] + "-" + os.path.basename(urllib.parse.unquote(urllib.parse.urlparse(url).path)).replace(" ", "_")
    dest = os.path.join(cache, name)
    if os.path.exists(dest):
        return dest
    os.makedirs(cache, exist_ok=True)
    for attempt in range(4):
        try:
            log(f"  downloading {url}")
            req = urllib.request.Request(urllib.parse.quote(url, safe=":/"), headers={"User-Agent": AGENT})
            with urllib.request.urlopen(req, timeout=120) as res, open(dest + ".part", "wb") as fh:
                while chunk := res.read(1 << 20):
                    fh.write(chunk)
            os.replace(dest + ".part", dest)
            return dest
        except OSError as e:
            log(f"  failed ({e}); trying again")
            time.sleep(5 * (attempt + 1))
    raise SystemExit(f"could not download {url}")


def lines(path: str):
    with open(path, encoding="utf-8-sig") as fh:
        for line in fh:
            yield line.rstrip("\n").rstrip("\r")


# ---- STEPBible ------------------------------------------------------------------------------

WORD_ROW = re.compile(r"^([1-3][A-Z][a-z]|[A-Z][a-z]{2})\.(\d+)\.(\d+)(\S*?)#(\d+)=(\S*)\t")
OWN_REF = re.compile(r"\((\d+)\.(\d+)\)")
KJV_REF = re.compile(r"\[(\d+)\.(\d+)\]")


def read_tahot(path: str):
    """Hebrew words: (book, chapter, verse, pos, lang, kind, text, translit, gloss, strongs, all, grammar, lemma, own ref, editions)."""
    for line in lines(path):
        m = WORD_ROW.match(line)
        if not m:
            continue
        book, ch, vs, extra, pos, kind = m.groups()
        cols = line.split("\t")
        own = OWN_REF.search(extra)
        dstrongs = cols[4] if len(cols) > 4 else ""
        core = re.search(r"\{([HG]\d{4,5}[A-Za-z]?)\}", dstrongs)
        grammar = cols[5] if len(cols) > 5 else ""
        lang = "A" if grammar.startswith("A") else "H"
        expanded = cols[11] if len(cols) > 11 else ""
        lemma = re.search(r"\{[HG]\d{4,5}[A-Za-z]?=([^=]*)=", expanded)
        yield (book, int(ch), int(vs), pos, lang, kind, cols[1].replace("/", "").replace("\\", ""), cols[2].replace("/", ""),
               cols[3].replace("/", "").strip(), core.group(1) if core else None, dstrongs, grammar, lemma.group(1) if lemma else None,
               f"{own.group(1)}.{own.group(2)}" if own else None, None)


def read_tagnt(path: str):
    """Greek words, in the KJV's numbering where it differs (in square brackets)."""
    for line in lines(path):
        m = WORD_ROW.match(line)
        if not m:
            continue
        book, ch, vs, extra, pos, kind = m.groups()
        cols = line.split("\t")
        kjv = KJV_REF.search(extra)
        own = OWN_REF.search(extra)
        if kjv:
            ch, vs = kjv.group(1), kjv.group(2)
        greek, _, translit = cols[1].partition(" (")
        strongs, _, grammar = (cols[3] if len(cols) > 3 else "").partition("=")
        lemma = (cols[4] if len(cols) > 4 else "").partition("=")[0]
        yield (book, int(ch), int(vs), pos, "G", kind, greek.strip(), translit.rstrip(")").strip(), cols[2].strip(),
               strongs or None, cols[3] if len(cols) > 3 else None, grammar or None, lemma or None,
               f"{own.group(1)}.{own.group(2)}" if own else None, cols[5] if len(cols) > 5 else None)


LEX_ROW = re.compile(r"^([HG]\d{4,5}[A-Za-z]?)\t")


def read_lexicon(path: str, lang: str, definitions: bool):
    for line in lines(path):
        if not LEX_ROW.match(line):
            continue
        c = (line.split("\t") + [""] * 8)[:8]
        estrong, dstrong, ustrong, lemma, translit, grammar, gloss, meaning = c
        # Keyed as the texts' words are (`H0430G`); `base` is the plain Strong's number.
        key = dstrong.partition("=")[0].strip() or estrong.strip()
        relation = dstrong.partition("=")[2].strip() or None
        yield (key, re.sub(r"[A-Za-z]$", "", key), lang, lemma or None, translit or None, grammar or None,
               gloss or None, (meaning.strip() or None) if definitions else None, relation)


def read_grammar(path: str, lang: str):
    """Brief codes (`H:N-M`) and the full ones (records between `$` lines)."""
    full = False
    record: list[str] = []
    for line in lines(path):
        if line.startswith("FULL MORPHOLOGY CODES"):
            full = True
            continue
        if not full:
            c = line.split("\t")
            if len(c) >= 3 and re.match(r"^[HAG]:", c[0]):
                yield (c[0], lang, c[2].strip(), None)
            continue
        if line.strip() == "$":
            if record:
                code = record[0].split("\t")[0].strip()
                parts = [r.strip() for r in record[1:] if r.strip()]
                if code:
                    yield (code, lang, parts[0] if parts else None, parts[1] if len(parts) > 1 else None)
            record = []
        elif line.strip():
            record.append(line)


# ---- English (USFM) -------------------------------------------------------------------------

# Lines that aren't the text: titles, headings, introductions, remarks.
SKIP_LINE = re.compile(r"^\\(id|ide|h|toc\d?|mt\d?|mte\d?|ms\d?|mr|s\d?|sr|r|rem|sts|cl|cd|sp|imt\d?|is\d?|ip|ipi|im|io\d?|iot|ie|periph|restore)\b")
NOTE = re.compile(r"\\(f|fe|x)\s.*?\\\1\*", re.S)
WORD = re.compile(r"\\\+?w\s+([^|\\]*?)\|([^\\]*?)\\\+?w\*")
MARK = re.compile(r"\\\+?[a-z]+\d*\*?")


def usfm_verses(text: str, keep_strongs: bool):
    """(chapter, verse, plain text, [(text, strongs)] or None) for one book's USFM."""
    kept = []
    for line in text.splitlines():
        s = line.strip()
        if not s or SKIP_LINE.match(s):
            continue
        # A Psalm's title is its verse 0.
        if s.startswith("\\d "):
            s = "\\v 0 " + s[3:]
        kept.append(s)
    body = NOTE.sub("", " ".join(kept))
    chapter = 0
    for part in re.split(r"(\\c\s+\d+|\\v\s+\d+[a-z]?(?:-\d+[a-z]?)?)", body):
        if not part:
            continue
        c = re.match(r"\\c\s+(\d+)", part)
        if c:
            chapter = int(c.group(1))
            verse = None
            continue
        v = re.match(r"\\v\s+(\d+)", part)
        if v:
            verse = int(v.group(1))
            continue
        if not chapter or verse is None:
            continue
        pieces: list[tuple[str, str | None]] = []
        last = 0
        for m in WORD.finditer(part):
            pieces.append((part[last:m.start()], None))
            strong = re.search(r'strong="([^"]+)"', m.group(2))
            pieces.append((m.group(1), strong.group(1).replace(" ", ",") if strong and keep_strongs else None))
            last = m.end()
        pieces.append((part[last:], None))
        clean = [(re.sub(r"\s+", " ", MARK.sub("", t).replace("¶", "")), s) for t, s in pieces]
        plain = "".join(t for t, _ in clean).strip()
        if plain:
            yield chapter, verse, plain, ([(t, s) for t, s in clean if t] if keep_strongs else None)


def read_usfm_zip(path: str, keep_strongs: bool):
    with zipfile.ZipFile(path) as z:
        for name in sorted(z.namelist()):
            if not name.lower().endswith((".usfm", ".sfm")):
                continue
            text = z.read(name).decode("utf-8-sig")
            m = re.search(r"\\id\s+(\w+)", text)
            book = FROM_USFM.get(m.group(1).upper()) if m else None
            if not book:
                continue  # the Apocrypha, front matter, glossaries
            for ch, vs, plain, pieces in usfm_verses(text, keep_strongs):
                yield book, ch, vs, plain, pieces


def read_bsb_tables(path: str):
    """The BSB's words with the Strong's numbers they translate: (book, ch, vs, pos, text, strongs)."""
    ref = None
    pos = 0
    with open(path, encoding="utf-8-sig", newline="") as fh:
        rows = csv.reader(fh, delimiter="\t", quoting=csv.QUOTE_NONE)
        head = next(rows)
        col = {name.strip(): i for i, name in enumerate(head)}
        get = lambda r, k: r[col[k]] if col.get(k, 99) < len(r) else ""
        for r in rows:
            vid = get(r, "VerseId").strip()
            if vid:
                m = re.match(r"^(.*\S)\s+(\d+):(\d+)$", vid)
                if not m or m.group(1) not in FROM_NAME:
                    raise SystemExit(f"BSB tables: a verse I can't place: {vid!r}")
                ref = (FROM_NAME[m.group(1)], int(m.group(2)), int(m.group(3)))
                pos = 0
            words = get(r, "BSB version").strip()
            if not ref or not words:
                continue
            if words == "-":
                continue  # translated by nothing (a direct object marker)
            text = f"{get(r, 'begQ')}{words}{get(r, 'pnc')}{get(r, 'endQ')}".strip()
            num = (get(r, "Str Heb") or get(r, "Str Grk")).strip()
            lang = "H" if get(r, "Language").strip() in ("Hebrew", "Aramaic") else "G"
            pos += 1
            yield (*ref, pos, text + " ", f"{lang}{int(num):04d}" if num.isdigit() else None)


# ---- The build ------------------------------------------------------------------------------

def build(out: str, cache: str) -> None:
    tmp = out + ".part"
    if os.path.exists(tmp):
        os.remove(tmp)
    db = sqlite3.connect(tmp)
    db.executescript(SCHEMA)
    db.executemany("INSERT INTO books VALUES (?,?,?,?)", [(b, i + 1, n, "OT" if i < 39 else "NT") for i, (b, _, n) in enumerate(BOOKS)])

    log("reading the Hebrew and Greek texts (STEPBible TAHOT, TAGNT)")
    for kind, reader in (("tahot", read_tahot), ("tagnt", read_tagnt)):
        for f in STEP_FILES[kind]:
            rows = list(reader(fetch(STEP + f, cache)))
            bad = {r[0] for r in rows} - BOOK_IDS
            if bad:
                raise SystemExit(f"{f}: books I don't know: {sorted(bad)}")
            db.executemany("INSERT INTO words (book, chapter, verse, pos, lang, kind, text, translit, gloss, strongs, strongs_all, grammar, lemma, own_ref, editions) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
            log(f"  {os.path.basename(f)[:20]}: {len(rows):,} words")

    log("reading the lexicons and grammar codes (TBESH, TBESG, TEHMC, TEGMC)")
    for kind, lang, defs in (("tbesh", "H", False), ("tbesg", "G", True)):
        db.executemany("INSERT OR IGNORE INTO lexicon VALUES (?,?,?,?,?,?,?,?,?)", read_lexicon(fetch(STEP + STEP_FILES[kind][0], cache), lang, defs))
    for kind, lang in (("tehmc", "H"), ("tegmc", "G")):
        db.executemany("INSERT OR IGNORE INTO grammar VALUES (?,?,?,?)", read_grammar(fetch(STEP + STEP_FILES[kind][0], cache), lang))

    log("reading the English versions")
    for i, (vid, name, year, url, licence, attribution, strongs) in enumerate(VERSIONS):
        db.execute("INSERT INTO versions VALUES (?,?,?,?,?,?,?,?)", (vid, i + 1, name, year, licence, attribution, url, int(strongs or vid == "bsb")))
        n = 0
        for book, ch, vs, plain, pieces in read_usfm_zip(fetch(url, cache), strongs):
            db.execute("INSERT OR REPLACE INTO verses VALUES (?,?,?,?,?)", (vid, book, ch, vs, plain))
            if pieces:
                db.executemany("INSERT OR REPLACE INTO tags VALUES (?,?,?,?,?,?,?)", [(vid, book, ch, vs, p, t, s) for p, (t, s) in enumerate(pieces)])
            n += 1
        log(f"  {name}: {n:,} verses")
        if n < 7000:
            raise SystemExit(f"{name}: only {n} verses: the source must have changed")

    log("aligning the BSB with the Hebrew and Greek (bsb_tables)")
    rows = list(read_bsb_tables(fetch(BSB_TABLES, cache)))
    db.executemany("INSERT OR REPLACE INTO tags VALUES ('bsb',?,?,?,?,?,?)", rows)
    log(f"  {len(rows):,} words")

    log("indexing")
    db.execute("INSERT INTO verses_fts (rowid, text) SELECT rowid, text FROM verses")
    attribution = " ".join([STEP_ATTRIBUTION] + [v[5] for v in VERSIONS])
    counts = {t: db.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in ("verses", "tags", "words", "lexicon", "grammar")}
    meta = {"schema_version": SCHEMA_VERSION, "built_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
            "step_commit": STEP_COMMIT, "attribution": attribution, "counts": json.dumps(counts)}
    db.executemany("INSERT INTO meta VALUES (?,?)", meta.items())
    db.commit()
    db.execute("ANALYZE")
    db.commit()
    db.execute("VACUUM")
    db.close()
    os.replace(tmp, out)
    log(f"done: {out} {counts}")


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--cache", required=True, help="where downloads are kept (and reused)")
    p.add_argument("-o", "--out", default="bible.db")
    a = p.parse_args(argv)
    build(a.out, a.cache)


if __name__ == "__main__":
    main()
