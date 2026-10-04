// foliate-js's EPUB CFI module, vendored (pinned commit, see vendor/foliate-js/COMMIT).
declare module "*/foliate-js/epubcfi.js" {
  /* eslint-disable @typescript-eslint/no-explicit-any -- foliate-js has no types */
  export const isCFI: RegExp;
  export function joinIndir(...xs: string[]): string;
  export function parse(cfi: string): any;
  export function fromRange(range: Range, filter?: unknown): string;
  export function toRange(doc: Document, parts: any, filter?: unknown): Range;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
