/**
 * Serves an EPUB to Readium from memory (plan: docs/plans/epub-readium.md, decision 0045).
 *
 * Readium reads a publication from a manifest and fetchable resources, usually from a server.
 * Here the EPUB is unzipped on demand (fflate), its package document (OPF) becomes a Readium
 * manifest, and a Fetcher serves its chapters:
 * - each chapter is made safe (epub-safe.ts) and marked with its path;
 * - every resource it uses (images, stylesheets, fonts, media), and the resources stylesheets
 *   use, is given as a blob URL, so frames never fetch anything by address;
 * - chapter links (`<a href>`) stay relative; they resolve against a base that never
 *   resolves (BASE), and Readium turns clicks on them into navigation.
 * The book's script files are never served.
 */
import { unzipSync } from "fflate";
import { Locator, Manifest, Publication, Link, Resource, type Fetcher } from "@readium/shared";
import { addMeta, BOOK_CSP, isMarkup, neutralize, parsePage } from "../epub-safe";

/** The base chapters resolve against. `.invalid` never resolves, so nothing is fetched there. */
export const BASE = "https://book.librarium.invalid/";

/** One item of the spine, in package order (including non-linear items), for CFIs. */
export interface SpineItem {
  href: string;
  type: string;
  /** The item's CFI in the package document, as EPUB CFIs start (`/6/4[id]`). */
  cfi: string;
  linear: boolean;
}

export interface TocEntry {
  title: string;
  /** A path in the book, with a fragment if any. */
  href: string;
  depth: number;
}

export interface Book {
  publication: Publication;
  positions: Locator[];
  spine: SpineItem[];
  toc: TocEntry[];
  title: string;
  fixed: boolean;
  /** The text of a chapter, for find (cleaned, without markup). */
  chapterText(href: string): Promise<string>;
  close(): void;
}

export interface StreamerOptions {
  /** Makes a URL for a blob (URL.createObjectURL; replaceable in tests). */
  objectURL?: (b: Blob) => string;
  revokeURL?: (url: string) => void;
}

const OPS_NS = "http://www.idpf.org/2007/ops";
const XHTML = "application/xhtml+xml";
const SCRIPT_TYPES = /^(text|application)\/(x-)?(java|ecma)script$|^text\/javascript|^module$/i;
const BY_EXTENSION: Record<string, string> = {
  xhtml: XHTML, xht: XHTML, html: "text/html", htm: "text/html", css: "text/css", svg: "image/svg+xml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2", mp3: "audio/mpeg", m4a: "audio/mp4",
  mp4: "video/mp4", webm: "video/webm", ncx: "application/x-dtbncx+xml", xml: "application/xml", smil: "application/smil+xml",
  js: "text/javascript",
};

/** A path in the book, from a reference relative to another path (no fragment or query). */
export function resolvePath(from: string, ref: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//")) return null; // elsewhere
  try {
    const u = new URL(ref, `https://z/${from.split("/").map(encodeURIComponent).join("/")}`);
    return decodeURIComponent(u.pathname.slice(1));
  } catch {
    return null;
  }
}

/** A path as a manifest href (each segment encoded). */
const toHref = (path: string) => path.split("/").map(encodeURIComponent).join("/");
/** A manifest href (relative or absolute against BASE) as a path, without fragment. */
const fromHref = (href: string) => {
  let h = href.startsWith(BASE) ? href.slice(BASE.length) : href;
  h = h.split("#")[0]!.split("?")[0]!;
  try {
    return decodeURIComponent(h);
  } catch {
    return h;
  }
};

class Zip {
  readonly sizes = new Map<string, number>();
  constructor(private readonly bytes: Uint8Array) {
    unzipSync(bytes, {
      filter: (f) => {
        if (!f.name.endsWith("/")) this.sizes.set(f.name, f.originalSize);
        return false;
      },
    });
  }
  has(path: string): boolean {
    return this.sizes.has(path);
  }
  read(paths: Iterable<string>): Map<string, Uint8Array> {
    const want = new Set([...paths].filter((p) => this.sizes.has(p)));
    if (!want.size) return new Map();
    return new Map(Object.entries(unzipSync(this.bytes, { filter: (f) => want.has(f.name) })));
  }
  text(path: string): string | null {
    const b = this.read([path]).get(path);
    return b ? new TextDecoder().decode(b) : null;
  }
}

const textOf = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const kids = (el: Element, local: string) => [...el.children].filter((c) => c.localName === local);

/** Opens an EPUB's bytes as a Readium publication. */
export async function openBook(bytes: ArrayBuffer | Uint8Array, id: string, opts: StreamerOptions = {}): Promise<Book> {
  const objectURL = opts.objectURL ?? ((b: Blob) => URL.createObjectURL(b));
  const revokeURL = opts.revokeURL ?? ((u: string) => URL.revokeObjectURL(u));
  const zip = new Zip(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const xml = (path: string) => {
    const t = zip.text(path);
    return t === null ? null : new DOMParser().parseFromString(t, "application/xml");
  };

  // The package document.
  const container = xml("META-INF/container.xml");
  const opfPath = container?.querySelector("rootfile")?.getAttribute("full-path");
  if (!opfPath) throw new Error("This EPUB has no package document.");
  const opf = xml(opfPath);
  if (!opf || opf.querySelector("parsererror")) throw new Error("This EPUB's package document can't be read.");
  const pkg = opf.documentElement;
  const metadataEl = kids(pkg, "metadata")[0];
  const manifestEl = kids(pkg, "manifest")[0];
  const spineEl = kids(pkg, "spine")[0];
  if (!manifestEl || !spineEl) throw new Error("This EPUB's package document has no manifest or spine.");

  const items = new Map<string, { path: string; type: string; props: string[] }>();
  for (const it of kids(manifestEl, "item")) {
    const href = it.getAttribute("href");
    const path = href ? resolvePath(opfPath, href) : null;
    if (!path) continue;
    const ext = path.split(".").pop()!.toLowerCase();
    items.set(it.getAttribute("id") ?? path, { path, type: it.getAttribute("media-type") || BY_EXTENSION[ext] || "application/octet-stream", props: (it.getAttribute("properties") ?? "").split(/\s+/).filter(Boolean) });
  }
  const typeOfPath = new Map([...items.values()].map((i) => [i.path, i.type]));
  const typeOf = (path: string) => typeOfPath.get(path) ?? BY_EXTENSION[path.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";

  // Metadata.
  const dc = (name: string) => (metadataEl ? [...metadataEl.getElementsByTagNameNS("http://purl.org/dc/elements/1.1/", name)] : []);
  const metas = metadataEl ? kids(metadataEl, "meta") : [];
  const metaProp = (p: string) => textOf(metas.find((m) => m.getAttribute("property") === p));
  const title = textOf(dc("title")[0]) || "Untitled";
  const languages = dc("language").map(textOf).filter(Boolean);
  const fixed = metaProp("rendition:layout") === "pre-paginated";
  const direction = spineEl.getAttribute("page-progression-direction");

  // The spine: every itemref, with its CFI (as foliate made them, so captures keep working).
  const itemrefs = kids(spineEl, "itemref");
  const spine: SpineItem[] = [];
  const cfiOf = cfisOfItemrefs(itemrefs);
  itemrefs.forEach((ref, i) => {
    const it = items.get(ref.getAttribute("idref") ?? "");
    if (!it) return;
    spine.push({ href: it.path, type: it.type, cfi: cfiOf[i]!, linear: ref.getAttribute("linear") !== "no" });
  });
  const pageOf = (ref: Element) => {
    const p = (ref.getAttribute("properties") ?? "").split(/\s+/);
    return p.includes("page-spread-left") ? "left" : p.includes("page-spread-right") ? "right" : p.includes("page-spread-center") || p.includes("rendition:page-spread-center") ? "center" : undefined;
  };
  const readingOrder = itemrefs
    .map((ref) => ({ ref, it: items.get(ref.getAttribute("idref") ?? "") }))
    .filter((x) => x.it && x.ref.getAttribute("linear") !== "no")
    .map(({ ref, it }) => ({ href: toHref(it!.path), type: it!.type, ...(pageOf(ref) ? { properties: { page: pageOf(ref) } } : {}) }));
  if (!readingOrder.length) throw new Error("This EPUB has nothing to read in its spine.");
  const inOrder = new Set(readingOrder.map((l) => fromHref(l.href)));
  const resources = [...items.values()].filter((i) => !inOrder.has(i.path) && !SCRIPT_TYPES.test(i.type)).map((i) => ({ href: toHref(i.path), type: i.type, ...(i.props.length ? { properties: { contains: i.props } } : {}) }));

  // The contents: EPUB 3 navigation document, or EPUB 2 NCX.
  const toc = readToc(zip, items, spineEl);
  const tocTree = (entries: TocEntry[]) => {
    const root: { title: string; href: string; children: unknown[] }[] = [];
    const stack: { depth: number; children: unknown[] }[] = [{ depth: -1, children: root }];
    for (const e of entries) {
      while (stack.length > 1 && stack[stack.length - 1]!.depth >= e.depth) stack.pop();
      const node = { title: e.title, href: toHref(e.href.split("#")[0]!) + (e.href.includes("#") ? `#${e.href.split("#")[1]}` : ""), children: [] as unknown[] };
      stack[stack.length - 1]!.children.push(node);
      stack.push({ depth: e.depth, children: node.children });
    }
    const strip = (n: { children: unknown[] }): unknown => ({ ...n, children: n.children.length ? n.children.map((c) => strip(c as { children: unknown[] })) : undefined });
    return root.map(strip);
  };

  const manifest = Manifest.deserialize({
    metadata: {
      title,
      conformsTo: "https://readium.org/webpub-manifest/profiles/epub",
      ...(languages.length ? { language: languages } : {}),
      ...(dc("creator")[0] ? { author: textOf(dc("creator")[0]) } : {}),
      ...(direction === "rtl" || direction === "ltr" ? { readingProgression: direction } : {}),
      layout: fixed ? "fixed" : "reflowable",
    },
    links: [{ rel: "self", href: `${BASE}${encodeURIComponent(id)}/manifest.json`, type: "application/webpub+json" }],
    readingOrder,
    resources,
    toc: tocTree(toc),
  });
  if (!manifest) throw new Error("This EPUB couldn't be described for the reader.");

  // Resources as blob URLs (made once, freed on close).
  const urls = new Map<string, Promise<string>>();
  const made: string[] = [];
  const blobURL = (data: BlobPart, type: string) => {
    const u = objectURL(new Blob([data], { type }));
    made.push(u);
    return u;
  };
  const resourceURL = (path: string, seen: Set<string> = new Set()): Promise<string> | null => {
    if (!zip.has(path) || SCRIPT_TYPES.test(typeOf(path)) || (isMarkup(typeOf(path)) && typeOf(path) !== "image/svg+xml")) return null;
    let u = urls.get(path);
    if (!u) {
      const type = typeOf(path);
      u = type === "text/css" && !seen.has(path)
        ? rewriteCSS(zip.text(path) ?? "", path, new Set([...seen, path])).then((css) => blobURL(css, "text/css"))
        : type === "image/svg+xml"
          ? Promise.resolve(blobURL(safeSVG(zip.text(path) ?? ""), type))
          : Promise.resolve(blobURL(zip.read([path]).get(path) as BlobPart, type));
      urls.set(path, u);
    }
    return u;
  };
  const rewriteCSS = async (css: string, from: string, seen: Set<string>): Promise<string> => {
    const refs = [...css.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)|@import\s+(["'])([^"']+)\3/gi)];
    let out = "";
    let last = 0;
    for (const m of refs) {
      const ref = (m[2] ?? m[4] ?? "").trim();
      const path = resolvePath(from, ref);
      const url = path ? await resourceURL(path, seen) : null;
      out += css.slice(last, m.index) + (url ? (m[4] !== undefined ? `@import "${url}"` : `url("${url}")`) : m[0]);
      last = m.index! + m[0].length;
    }
    return out + css.slice(last);
  };

  /** A chapter, made safe, its resources as blob URLs, marked with its path. */
  const prepared = new Map<string, Promise<string>>();
  const prepareChapter = (path: string): Promise<string> => {
    let p = prepared.get(path);
    if (!p) {
      p = (async () => {
        const doc = parsePage(zip.text(path) ?? "", typeOf(path));
        neutralize(doc);
        const swap = async (el: Element, attr: string) => {
          const v = el.getAttribute(attr);
          const target = v ? resolvePath(path, v) : null;
          const url = target ? await resourceURL(target) : null;
          if (url) el.setAttribute(attr, url);
        };
        for (const el of [...doc.querySelectorAll("[src]")]) await swap(el, "src");
        for (const el of [...doc.querySelectorAll("[poster]")]) await swap(el, "poster");
        for (const el of [...doc.querySelectorAll("link[href]")]) await swap(el, "href");
        for (const el of [...doc.querySelectorAll("*")]) {
          if (el.localName === "a") continue; // links navigate; they aren't resources
          for (const a of [...el.attributes]) {
            if (a.localName === "href" && (a.namespaceURI === "http://www.w3.org/1999/xlink" || el.namespaceURI === "http://www.w3.org/2000/svg")) {
              const target = resolvePath(path, a.value);
              const url = target ? await resourceURL(target) : null;
              if (url) el.setAttributeNS(a.namespaceURI, a.name, url);
            }
          }
        }
        for (const el of [...doc.querySelectorAll("[srcset]")]) {
          const parts = await Promise.all((el.getAttribute("srcset") ?? "").split(",").map(async (part) => {
            const [ref, ...rest] = part.trim().split(/\s+/);
            const target = ref ? resolvePath(path, ref) : null;
            const url = target ? await resourceURL(target) : null;
            return [url ?? ref, ...rest].join(" ");
          }));
          el.setAttribute("srcset", parts.join(", "));
        }
        for (const el of [...doc.querySelectorAll("style")]) el.textContent = await rewriteCSS(el.textContent ?? "", path, new Set());
        for (const el of [...doc.querySelectorAll("[style]")]) el.setAttribute("style", await rewriteCSS(el.getAttribute("style") ?? "", path, new Set()));
        addMeta(doc, { name: "librarium-href", content: path });
        addMeta(doc, { "http-equiv": "Content-Security-Policy", content: BOOK_CSP });
        return new XMLSerializer().serializeToString(doc);
      })();
      prepared.set(path, p);
    }
    return p;
  };

  class BookResource extends Resource {
    constructor(private readonly l: Link) {
      super();
    }
    async link() {
      return this.l;
    }
    async length() {
      return zip.sizes.get(fromHref(this.l.href));
    }
    async read(): Promise<Uint8Array | undefined> {
      const path = fromHref(this.l.href);
      const type = typeOf(path);
      if (!zip.has(path) || SCRIPT_TYPES.test(type)) return undefined;
      if (isMarkup(type) && type !== "image/svg+xml") return new TextEncoder().encode(await prepareChapter(path));
      if (type === "image/svg+xml") return new TextEncoder().encode(safeSVG(zip.text(path) ?? ""));
      if (type === "text/css") return new TextEncoder().encode(await rewriteCSS(zip.text(path) ?? "", path, new Set([path])));
      return zip.read([path]).get(path);
    }
    close() {}
  }
  const fetcher: Fetcher = {
    links: () => [...items.values()].map((i) => new Link({ href: toHref(i.path), type: i.type })),
    get: (link: Link) => new BookResource(link),
    close: () => {},
  };
  const publication = new Publication({ manifest, fetcher });

  // Positions, as Readium counts them: one per 1,024 bytes of a reflowable chapter, one per
  // page of a fixed-layout book.
  const counts = readingOrder.map((l) => (fixed ? 1 : Math.max(1, Math.ceil((zip.sizes.get(fromHref(l.href)) ?? 0) / 1024))));
  const total = counts.reduce((a, b) => a + b, 0);
  const positions: Locator[] = [];
  let n = 0;
  readingOrder.forEach((l, i) => {
    const title = toc.find((t) => t.href.split("#")[0] === fromHref(l.href))?.title;
    for (let k = 0; k < counts[i]!; k++) {
      positions.push(Locator.deserialize({ href: l.href, type: l.type, ...(title ? { title } : {}), locations: { position: n + 1, progression: k / counts[i]!, totalProgression: n / total } })!);
      n++;
    }
  });

  return {
    publication,
    positions,
    spine,
    toc,
    title,
    fixed,
    async chapterText(href: string) {
      const path = fromHref(href);
      const doc = parsePage(zip.text(path) ?? "", typeOf(path));
      for (const el of [...doc.querySelectorAll("script, style, head")]) el.remove();
      return (doc.body ?? doc.documentElement).textContent ?? "";
    },
    close() {
      for (const u of made) revokeURL(u);
      made.length = 0;
      urls.clear();
      prepared.clear();
    },
  };
}

/** An SVG file with nothing left that could run. */
function safeSVG(text: string): string {
  const doc = parsePage(text, "image/svg+xml");
  neutralize(doc);
  return new XMLSerializer().serializeToString(doc);
}

/** The EPUB CFIs of the spine's itemrefs (`/6/<2(n+1)>[id]`), as foliate-js made them. */
function cfisOfItemrefs(itemrefs: Element[]): string[] {
  if (!itemrefs.length) return [];
  const spine = itemrefs[0]!.parentElement!;
  const step = (el: Element) => 2 * ([...el.parentElement!.children].indexOf(el) + 1);
  const esc = (s: string) => s.replace(/[\^[\](),;=]/g, "^$&");
  const spineId = spine.getAttribute("id");
  const base = `/${step(spine)}${spineId ? `[${esc(spineId)}]` : ""}`;
  return itemrefs.map((ref) => {
    const id = ref.getAttribute("id");
    return `epubcfi(${base}/${step(ref)}${id ? `[${esc(id)}]` : ""})`;
  });
}

function readToc(zip: Zip, items: Map<string, { path: string; type: string; props: string[] }>, spineEl: Element): TocEntry[] {
  const out: TocEntry[] = [];
  const nav = [...items.values()].find((i) => i.props.includes("nav"));
  if (nav) {
    const doc = parsePage(zip.text(nav.path) ?? "", nav.type);
    const navs = [...doc.getElementsByTagName("nav")];
    const tocNav = navs.find((n) => (n.getAttributeNS(OPS_NS, "type") ?? n.getAttribute("epub:type") ?? "").split(/\s+/).includes("toc")) ?? navs[0];
    const walk = (ol: Element | undefined, depth: number) => {
      for (const li of ol ? kids(ol, "li") : []) {
        const a = kids(li, "a")[0] ?? kids(li, "span")[0];
        const href = a?.getAttribute("href");
        const path = href ? resolvePath(nav.path, href) : null;
        if (a && path) out.push({ title: textOf(a) || "Untitled", href: path + (href!.includes("#") ? `#${href!.split("#")[1]}` : ""), depth });
        walk(kids(li, "ol")[0], depth + 1);
      }
    };
    walk(tocNav ? kids(tocNav, "ol")[0] : undefined, 0);
    if (out.length) return out;
  }
  const ncx = items.get(spineEl.getAttribute("toc") ?? "") ?? [...items.values()].find((i) => i.type === "application/x-dtbncx+xml");
  if (ncx) {
    const doc = new DOMParser().parseFromString(zip.text(ncx.path) ?? "", "application/xml");
    const walk = (parent: Element | null | undefined, depth: number) => {
      for (const np of parent ? kids(parent, "navPoint") : []) {
        const src = kids(np, "content")[0]?.getAttribute("src");
        const path = src ? resolvePath(ncx.path, src) : null;
        const label = textOf(kids(np, "navLabel")[0]);
        if (path) out.push({ title: label || "Untitled", href: path + (src!.includes("#") ? `#${src!.split("#")[1]}` : ""), depth });
        walk(np, depth + 1);
      }
    };
    walk(doc.getElementsByTagName("navMap")[0], 0);
  }
  return out;
}
