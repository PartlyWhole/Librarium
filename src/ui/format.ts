/** Formatters for calm, short UI text. */

export function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** "2 Oct 2026" */
export function shortDate(when: string | number): string {
  return new Date(when).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
