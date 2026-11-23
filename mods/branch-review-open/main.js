// ctrl-b shift-v: opens branch-review in a new tab, for the focused pane's repo.
// A key can't pass props to tab.new, so this popup does it and closes.
import { View, div } from "gpui-kit";
import { closeOverlay, focused, panes, props, run, spaces } from "herdr";

export default class BranchReviewOpen extends View {
  init(_props, cx) {
    const f = focused(), space = spaces().find((s) => s.active);
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    const folder = pane?.cwd || f?.cwd || space?.folder;
    const spaceId = f?.space ?? space?.id;
    const name = `review: ${pane?.branch || (folder ?? "").replace(/\/+$/, "").split("/").pop() || "repo"}`;
    cx.spawn(async () => {
      // Closing this popup hands focus back to the pane it was opened from, so close it first
      // and open the tab after: the new tab then has the focus.
      closeOverlay(props().overlay);
      run("tab.new", { name, ...(spaceId ? { space: spaceId } : {}), mod: "branch-review", props: { folder, on: space?.machine ?? null, space: spaceId } });
    });
  }

  render() {
    return div();
  }
}
