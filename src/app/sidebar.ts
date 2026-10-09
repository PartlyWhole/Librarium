/**
 * The sidebar: a Filter box over one tree with a section for each folder space (Notes,
 * Library). Folding is remembered; captures and such start folded under their record.
 */
import { h } from "../ui/dom";
import { contextMenu, type MenuItem } from "../ui/menu";
import { effect, signal } from "../ui/signal";
import { Tree, type TreeNode } from "../ui/tree";
import { dropOnTop, goFolder, newFolderIn, SPACES, spaceTree, topMenu } from "./folders";
import { isOpen } from "./library";
import { pref } from "./prefs";
import { getRecord } from "./records";
import { showRecordMenu } from "./recordmenu";

export function sidebar(): HTMLElement {
  const folded = pref<string[]>("ui.folded", []);
  // Rows that start folded (an item's captures) are open only once unfolded.
  const unfolded = pref<string[]>("ui.unfolded", []);
  const query = signal("");
  const filter = h("input", { class: "sidebar-filter", type: "search", placeholder: "Filter", "aria-label": "Filter the sidebar", spellcheck: false });
  filter.addEventListener("input", () => query.set(filter.value));

  const tree = new Tree("Notes and library", (id, open) => {
    folded.update((f) => (open ? f.filter((x) => x !== id) : [...new Set([...f, id])]));
    unfolded.update((u) => (open ? [...new Set([...u, id])] : u.filter((x) => x !== id)));
  });
  tree.onContext = (ids, at) => showRecordMenu(ids.map((id) => getRecord(id)!).filter(Boolean), at);
  const scroll = h("div", { class: "sidebar-scroll" }, tree.el);
  // The empty space below: go to a space, or make a folder in one.
  scroll.addEventListener("contextmenu", (e) => {
    if ((e.target as Element).closest("[role=treeitem]") || !isOpen()) return;
    e.preventDefault();
    const items: MenuItem[] = [...SPACES.map((sp) => ({ label: `Go to ${sp.title}`, run: () => goFolder(sp, "") })), "separator", ...SPACES.map((sp) => ({ label: `New folder in ${sp.title}…`, run: () => void newFolderIn(sp, "") }))];
    contextMenu(items, { x: e.clientX, y: e.clientY });
  });

  effect(() => {
    const q = query().trim().toLowerCase();
    const f = folded();
    const unf = unfolded();
    const keep = (n: TreeNode): TreeNode | null => {
      if (!n.children) return !q || n.label.toLowerCase().includes(q) ? n : null;
      const kids = n.children.map(keep).filter((x) => !!x);
      const expanded = q ? true : n.startCollapsed ? unf.includes(n.id) : !f.includes(n.id);
      return kids.length || n.label.toLowerCase().includes(q) ? { ...n, children: kids, expanded } : null;
    };
    tree.render(!isOpen() ? [] : SPACES.map((sp): TreeNode => {
      const id = `section:${sp.kind}`;
      const items = spaceTree(sp).map(keep).filter((x) => !!x);
      return {
        id,
        label: sp.title,
        drop: dropOnTop(sp),
        onContext: (at) => contextMenu(topMenu(sp), at, sp.title),
        expanded: q ? true : !f.includes(id),
        children: items.length ? items : [{ id: `empty:${sp.kind}`, label: q ? "Nothing matches" : sp.emptyText, placeholder: true }],
      };
    }));
  });
  return h("aside", { class: "app-sidebar", "aria-label": "Sidebar" }, h("div", { class: "sidebar-top" }, filter), scroll);
}
