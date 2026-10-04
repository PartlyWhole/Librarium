/**
 * Librarium's mark (from assets/brand/librarium-icon-kit/masters/librarium-current-color.svg):
 * an open book with a house, drawn in the surrounding text colour.
 */
const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" aria-hidden="true" focusable="false"><g transform="translate(50 46) scale(.9)" fill="none" stroke="currentColor" stroke-width="54"><path d="M160 210 C310 204 431 232 500 310 C569 232 690 204 840 210 L840 690 C785 688 740 694 700 707 C617 733 548 760 500 800 C452 760 383 733 300 707 C260 694 215 688 160 690 Z" stroke-linejoin="round"/><path d="M300 707 L300 514 L500 402 L700 514 L700 707" stroke-linejoin="round" stroke-linecap="butt"/><g fill="currentColor" stroke="none"><rect x="443.0" y="551" width="48" height="48"/><rect x="509.0" y="551" width="48" height="48"/><rect x="443.0" y="617" width="48" height="48"/><rect x="509.0" y="617" width="48" height="48"/></g></g></svg>`;

/** The mark, `size` pixels square. */
export function logo(size = 64): HTMLElement {
  const s = document.createElement("span");
  s.className = "logo";
  s.style.width = s.style.height = `${size}px`;
  s.innerHTML = MARK;
  return s;
}
