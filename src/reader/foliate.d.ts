// foliate-js is vendored plain JavaScript (pinned commit, see vendor/foliate-js/COMMIT).
declare module "*/foliate-js/view.js" {
  export class View extends HTMLElement {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- foliate-js has no types
  export function makeBook(file: File): Promise<any>;
}
declare module "*/foliate-js/overlayer.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- foliate-js has no types
  export const Overlayer: any;
}
