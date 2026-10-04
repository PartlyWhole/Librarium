/**
 * Pasted HTML as Markdown: headings, paragraphs, emphasis, strikethrough, highlight, code,
 * links, lists (nested, numbered, tasks), quotes, tables, rules and images (as their alt text
 * and address). The HTML is parsed with DOMParser into an inert document: no script runs and
 * nothing is fetched. Anything unknown gives its text.
 */

const BLOCK = new Set(["P", "DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "ASIDE", "NAV", "FIGURE", "FIGCAPTION", "DETAILS", "SUMMARY", "ADDRESS"]);
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "OBJECT", "SVG", "CANVAS", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "HEAD", "META", "LINK"]);

/** Markdown's special characters in plain text, escaped where they would start markup. */
function escapeText(s: string): string {
  return s.replace(/([\\`*_[\]])/g, "\\$1").replace(/^(\s*)([#>+-]|\d+\.)(?=\s)/gm, "$1\\$2");
}

function inlineWrap(mark: string, inner: string): string {
  const t = inner.trim();
  if (!t) return inner;
  // Keep the outer spaces outside the marks (`**a** b`, not `** a**b`).
  const lead = /^\s*/.exec(inner)![0];
  const tail = /\s*$/.exec(inner)![0];
  return `${lead}${mark}${t}${mark}${tail}`;
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

interface Ctx {
  /** Inside <pre>: whitespace is kept. */
  pre: boolean;
  /** List nesting: the indentation of the current list's items' text. */
  indent: string;
}

function inline(node: Node, ctx: Ctx): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = node.textContent ?? "";
    return ctx.pre ? t : escapeText(t.replace(/\s+/g, " "));
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = el.tagName;
  if (SKIP.has(tag)) return "";
  const kids = () => [...el.childNodes].map((c) => inline(c, ctx)).join("");
  switch (tag) {
    case "STRONG":
    case "B":
      return inlineWrap("**", kids());
    case "EM":
    case "I":
    case "CITE":
      return inlineWrap("*", kids());
    case "DEL":
    case "S":
    case "STRIKE":
      return inlineWrap("~~", kids());
    case "MARK":
      return inlineWrap("==", kids());
    case "CODE": {
      const t = el.textContent ?? "";
      const fence = t.includes("`") ? "``" : "`";
      return `${fence}${t}${fence}`;
    }
    case "BR":
      return "  \n";
    case "A": {
      const href = el.getAttribute("href") ?? "";
      const text = kids().trim();
      if (!href || href.startsWith("javascript:") || href.startsWith("#")) return text;
      if (!text || text === href) return `<${href}>`;
      return `[${text}](${href.replace(/[()\s]/g, encodeURIComponent)})`;
    }
    case "IMG": {
      const alt = (el.getAttribute("alt") ?? "").replace(/[[\]]/g, "");
      const src = el.getAttribute("src") ?? "";
      return src && !src.startsWith("data:") ? `![${alt}](${src.replace(/[()\s]/g, encodeURIComponent)})` : alt;
    }
    default:
      return kids();
  }
}

function blocks(parent: Node, ctx: Ctx): string[] {
  const out: string[] = [];
  let run = "";
  const flush = () => {
    const t = run.replace(/[ \t]+\n/g, "\n").trim();
    if (t) out.push(t);
    run = "";
  };
  for (const node of parent.childNodes) {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      run += inline(node, ctx);
      continue;
    }
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (SKIP.has(tag)) continue;
    const h = /^H([1-6])$/.exec(tag);
    if (h) {
      flush();
      out.push(`${"#".repeat(Number(h[1]))} ${[...el.childNodes].map((c) => inline(c, ctx)).join("").trim()}`);
    } else if (tag === "UL" || tag === "OL") {
      flush();
      out.push(list(el, ctx));
    } else if (tag === "BLOCKQUOTE") {
      flush();
      out.push(blocks(el, ctx).join("\n\n").split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
    } else if (tag === "PRE") {
      flush();
      const code = el.textContent ?? "";
      const lang = /language-(\w+)/.exec(el.querySelector("code")?.className ?? el.className)?.[1] ?? "";
      const fence = code.includes("```") ? "````" : "```";
      out.push(`${fence}${lang}\n${code.replace(/\n$/, "")}\n${fence}`);
    } else if (tag === "HR") {
      flush();
      out.push("---");
    } else if (tag === "TABLE") {
      flush();
      out.push(table(el, ctx));
    } else if (BLOCK.has(tag) || tag === "LI") {
      flush();
      out.push(...blocks(el, ctx));
    } else {
      run += inline(el, ctx);
    }
  }
  flush();
  return out;
}

function list(el: HTMLElement, ctx: Ctx): string {
  const ordered = el.tagName === "OL";
  let n = Number(el.getAttribute("start") ?? 1) || 1;
  const lines: string[] = [];
  for (const li of el.children) {
    if (li.tagName !== "LI") continue;
    const box = li.querySelector(":scope > input[type=checkbox]") as HTMLInputElement | null;
    const marker = ordered ? `${n++}.` : "-";
    const task = box ? (box.checked || box.hasAttribute("checked") ? "[x] " : "[ ] ") : "";
    const inner: Ctx = { ...ctx, indent: ctx.indent + " ".repeat(marker.length + 1) };
    const parts = blocks(li, inner);
    const [first = "", ...rest] = parts;
    lines.push(`${ctx.indent}${marker} ${task}${first.split("\n").join(`\n${inner.indent}`)}`);
    for (const p of rest) lines.push(p.startsWith(inner.indent) || /^\s*([-*+]|\d+\.)\s/.test(p) ? p : p.split("\n").map((l) => inner.indent + l).join("\n"));
  }
  return lines.join("\n");
}

function table(el: HTMLElement, ctx: Ctx): string {
  const rows = [...el.querySelectorAll("tr")].map((tr) => [...tr.children].filter((c) => c.tagName === "TD" || c.tagName === "TH").map((c) => cell([...c.childNodes].map((n) => inline(n, ctx)).join(""))));
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
  const [head, ...body] = rows.map(pad);
  return [`| ${head!.join(" | ")} |`, `| ${head!.map(() => "---").join(" | ")} |`, ...body.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

/** Converts pasted HTML to Markdown. */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return blocks(doc.body, { pre: false, indent: "" })
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
