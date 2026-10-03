// jsdom has no layout; CodeMirror measures text ranges. Give them empty boxes.
const empty = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON() {} }) as DOMRect;
if (typeof Range !== "undefined") {
  Range.prototype.getClientRects = function () {
    return Object.assign([], { item: () => null }) as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect = empty;
}
if (typeof document !== "undefined" && !document.elementFromPoint) document.elementFromPoint = () => null;
