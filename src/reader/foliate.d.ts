// foliate-js is vendored plain JavaScript (pinned commit, see vendor/foliate-js/COMMIT).
declare module "*/foliate-js/view.js" {
  export class View extends HTMLElement {}
}
declare module "*/foliate-js/overlayer.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- foliate-js has no types
  export const Overlayer: any;
}
