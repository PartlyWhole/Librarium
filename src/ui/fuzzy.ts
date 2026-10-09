/** Subsequence matching with a simple score: consecutive and word-start matches rank higher. */
function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    score += found === prev + 1 ? 3 : 1;
    if (found === 0 || /[\s\-_/.]/.test(t[found - 1] ?? "")) score += 2;
    prev = found;
    ti = found + 1;
  }
  if (t.startsWith(q)) score += 5;
  return score - t.length * 0.01;
}

export function fuzzyFilter<T>(items: T[], query: string, text: (t: T) => string, limit = 200): T[] {
  if (!query.trim()) return items.slice(0, limit);
  const scored: [T, number][] = [];
  for (const it of items) {
    const s = fuzzyScore(query, text(it));
    if (s !== null) scored.push([it, s]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  return scored.slice(0, limit).map((x) => x[0]);
}
