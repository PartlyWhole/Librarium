/** Formatters for calm, short UI text. */

export function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** "2026-10-02" → "Friday, 2 October 2026" */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export function shortPath(p: string, max = 48): string {
  if (p.length <= max) return p;
  return "…" + p.slice(p.length - max + 1);
}
