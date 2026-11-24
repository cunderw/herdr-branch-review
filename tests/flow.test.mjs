// The pane end to end against a real git repo, with the app stubbed (tests/harness).
// node --import ./branch-review/tests/harness/register.mjs --test branch-review/tests/flow.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { world, log } from "./harness/herdr.mjs";
import { calls } from "./harness/gpui.mjs";

globalThis.localStorage = { m: new Map(), getItem(k) { return this.m.get(k) ?? null; }, setItem(k, v) { this.m.set(k, v); } };

const repo = mkdtempSync(join(tmpdir(), "br-flow-"));
const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
const src = (map = (s) => s) => map(Array.from({ length: 40 }, (_, i) => `export function f${i}(x) {\n  // step ${i}\n  return x + ${i};\n}\n`).join(""));

before(() => {
  git("init", "-q", "-b", "main"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  writeFileSync(join(repo, "src.js"), src());
  git("add", "-A"); git("commit", "-qm", "base"); git("switch", "-q", "-c", "feat/x");
  writeFileSync(join(repo, "src.js"), src((s) => s.replace("return x + 5;", "return x * 5;").replace("return x + 20;", "return x * 20;")));
  git("commit", "-qam", "change f5 and f20");
  writeFileSync(join(repo, "cart.js"), "export const TAX = 0.2;\nexport const total = (a) => a * (1 + TAX);\n");
  git("add", "cart.js"); git("commit", "-qm", "cart");
  writeFileSync(join(repo, "notes.txt"), "untracked\nnotes\n");
});

// A context like the app's: spawned tasks are tracked so a test can wait for them.
const tasks = new Set();
const cx = {
  notify() {}, stop_propagation() {}, write_to_clipboard(t) { cx.clip = t; },
  focus_handle: () => ({ focus() {}, is_focused: () => false }),
  spawn(fn) { const p = Promise.resolve().then(() => fn(cx)).catch((e) => { cx.failed = e; }); tasks.add(p); p.finally(() => tasks.delete(p)); return p; },
  timer: { every() {}, after(ms, fn) { if (ms <= 50) { const p = Promise.resolve().then(() => fn(cx)); tasks.add(p); p.finally(() => tasks.delete(p)); } } },
};
globalThis.__cx = cx;
const settle = async () => { for (let i = 0; i < 200 && (tasks.size || view?.loading); i++) await new Promise((r) => setTimeout(r, 5)); if (cx.failed) throw cx.failed; };
const key = (k, mods = {}) => (view.render(cx), view.onKey({ keystroke: k, key: k.replace(/^shift-/, ""), key_char: k.length === 1 ? k : "", modifiers: mods }, cx));
const draw = () => { calls.texts.length = 0; view.render(cx); return calls.texts.join("\n"); };

let view;
const { default: BranchReview } = await import("../mods/branch-review/main.js");

test("opens on the branch view with its commits and files", async () => {
  world.props = { folder: repo, on: null, space: "s1" };
  view = new BranchReview(); view.init({}, cx);
  await settle();
  assert.equal(view.branch, "feat/x");
  assert.equal(view.commits.length, 2);
  assert.deepEqual(view.files.map((f) => `${f.status} ${f.path}`), ["A cart.js", "M src.js"]);
  const text = draw();
  assert.match(text, /Branch vs main/);
  assert.match(text, /Send review/);
});

test("number keys, h/l and tab move between panels; [ ] change the scope; esc leaves the diff", async () => {
  assert.equal(view.section, "files");
  key("1"); assert.equal(view.section, "scope");
  key("l"); assert.equal(view.section, "files");
  key("tab"); assert.equal(view.section, "commits");
  key("h"); key("h"); assert.equal(view.section, "scope");
  key("h"); assert.equal(view.section, "diff", "wraps to the main panel (no GitHub panel without a PR)");
  key("escape"); assert.equal(view.section, "scope", "esc goes back to the side panel");
  key("j"); await settle(); assert.equal(view.scope.kind, "last");
  key("]"); await settle(); assert.equal(view.scope.kind, "uncommitted");
  key("]"); await settle(); assert.equal(view.scope.kind, "branch");
  key("2"); key("enter"); assert.equal(view.section, "diff");
  assert.match(draw(), /\[2\]/);
  key("?"); assert.ok(view.showHelp); assert.match(draw(), /Keys · Main panel/);
  key("?"); assert.ok(!view.showHelp);
});

test("j/k over files, then v j c makes a range comment that renders", async () => {
  view.section = "files"; key("j"); await settle();
  assert.equal(view.open, "src.js");
  view.section = "diff"; draw();
  // Find the "return x * 5" row and select it plus the line above.
  const i = view.display.findIndex((d) => d.row?.text === "  return x * 5;");
  view.cursor = i - 2; draw(); key("v"); key("j"); key("j"); key("c");
  assert.equal(view.editing.kind, "range");
  view.input.set_value("Why multiply?\nSecond line");
  view.input.emit("submit", { shift: true });
  assert.ok(view.editing, "shift-enter does not save");
  view.input.emit("submit", {});
  assert.equal(view.comments.length, 1);
  const c = view.comments[0];
  assert.deepEqual(c.lines.map((l) => l.kind + l.text), ["   // step 5", "-  return x + 5;", "+  return x * 5;"]);
  const text = draw();
  assert.match(text, /Comment · lines 22–23/);
  assert.ok(view.display.some((d) => d.comment?.id === c.id));
});

test("a comment follows its lines when code above moves, and goes outdated when they change", async () => {
  writeFileSync(join(repo, "src.js"), "// new header\n// more\n" + readFileSync(join(repo, "src.js"), "utf8"));
  view.setScope({ kind: "uncommitted" }, cx); await settle();
  view.setScope({ kind: "branch" }, cx); await settle();
  // Branch view compares commits, so the working-tree edit doesn't show there: lines unchanged.
  view.section = "files"; view.open = null; view.pickFile("src.js", cx); await settle();
  assert.equal(view.place.outdated.size, 0);
  // In the uncommitted view the same text is gone: a comment made there goes outdated when edited.
  view.setScope({ kind: "uncommitted" }, cx); await settle();
  view.pickFile("src.js", cx); await settle();
  view.section = "diff"; draw();
  const i = view.display.findIndex((d) => d.row?.text === "// more");
  view.cursor = i; key("c"); view.input.set_value("header?"); view.input.emit("submit", {});
  const mine = view.comments.find((c) => c.text === "header?");
  assert.ok(view.place.at.has(mine.id));
  writeFileSync(join(repo, "src.js"), "// new header\n// changed\n" + readFileSync(join(repo, "src.js"), "utf8").split("\n").slice(2).join("\n"));
  view.refresh(cx, true); await settle();
  assert.ok(view.place.outdated.has(mine.id));
  assert.match(draw(), /Outdated/);
});

test("last commit and uncommitted include untracked files", async () => {
  view.setScope({ kind: "last" }, cx); await settle();
  assert.ok(view.files.some((f) => f.path === "notes.txt" && f.untracked));
  view.pickFile("notes.txt", cx); await settle();
  assert.deepEqual(view.rows.filter((r) => r.kind === "+").map((r) => r.text), ["untracked", "notes"]);
  draw();
});

test("C comments on the whole file; e and E expand context", async () => {
  view.setScope({ kind: "branch" }, cx); await settle();
  view.pickFile("src.js", cx); await settle();
  view.section = "diff";
  const before = view.rows.length;
  key("e"); await settle();
  assert.ok(view.rows.length > before, "more context");
  key("E"); await settle();
  assert.ok(!view.rows.some((r) => r.kind === "more"), "whole file has no more rows");
  key("C"); view.input.set_value("split this file"); view.input.emit("submit", {});
  assert.ok(view.comments.some((c) => c.kind === "file"));
  assert.match(draw(), /Whole file/);
});

test("a asks about the cursor line through the dialog; nothing is saved", async () => {
  const n = view.comments.length;
  view.section = "diff";
  draw(); view.cursor = view.display.findIndex((d) => d.row?.text === "  return x * 20;");
  key("a");
  const o = log.overlays.at(-1);
  assert.equal(o.props.dialog, "ask");
  assert.match(o.props.context, /return x \* 20/);
  assert.equal(view.comments.length, n);
});

test("X clears every comment on the branch and U brings them all back", async () => {
  const before = view.comments.map((c) => c.id).sort();
  assert.ok(before.length >= 2, "needs comments from earlier tests");
  assert.match(draw(), /^Clear$/m, "the bottom bar has a Clear button");
  key("X");
  assert.equal(view.comments.length, 0);
  assert.equal(JSON.parse(localStorage.getItem(view.storeKey())).length, 0, "the clear is saved");
  assert.match(log.notes.at(-1).title, new RegExp(`${before.length} comments cleared`));
  key("U");
  assert.deepEqual(view.comments.map((c) => c.id).sort(), before);
  assert.equal(JSON.parse(localStorage.getItem(view.storeKey())).length, before.length);
});

test("s checks comments and opens the review dialog; the dialog's sent key clears them", async () => {
  key("s"); await settle();
  const o = log.overlays.at(-1);
  assert.equal(o.props.dialog, "review");
  assert.match(o.props.context, /### src.js, whole file/);
  assert.match(o.props.context, /Why multiply\?\nSecond line/);
  assert.ok(o.props.sendId);
  world.shared.set("branch-review.sent", { id: o.props.sendId, at: Date.now() });
  draw();
  assert.equal(view.comments.length, 0);
});

test("the dialog sends with --if, refuses blocked agents, and reports a status race", async () => {
  const { default: BranchReview } = await import("../mods/branch-review/main.js");
  world.props = { dialog: "review", title: "t", context: "REVIEW", target: "t1", sendId: "S1", overlay: "ov" };
  const d = new BranchReview(); d.init({}, cx);
  d.render(cx);
  d.dialog.input.set_value("note");
  d.dialog.send(cx); await settle();
  assert.deepEqual(log.hc.at(-1), ["send", "--if", "idle", "t1", "note\n\nREVIEW"]);
  assert.equal(world.shared.get("branch-review.sent").id, "S1");
  world.agents[0].status = "blocked";
  const before = log.hc.length;
  d.dialog.sending = false; d.dialog.send(cx); await settle();
  assert.equal(log.hc.length, before, "blocked: not sent");
  world.agents[0].status = "idle";
  world.hcResult = { code: 1, stdout: "", stderr: "status is working" };
  setTimeout(() => { world.agents[0].status = "working"; }, 0);
  d.dialog.send(cx); await settle();
  assert.match(d.dialog.error, /went from idle to working|Not sent/);
  world.hcResult = { code: 0, stdout: "", stderr: "" };
  d.render(cx);
});

test("every view renders with the GitHub view and help open", async () => {
  view.threads = [{ id: "T", path: "src.js", line: 21, side: "new", isResolved: false, isOutdated: false, url: "u", version: "1:x",
    comments: [{ id: "x", author: "kim", body: "Use a constant?", at: new Date().toISOString() }] }];
  view.pr = { number: 7, title: "Feat", url: "https://github.com/o/r/pull/7", host: "github.com" }; view.gh = "ready";
  view.showHelp = true; draw();
  key("p"); assert.equal(view.view, "diff", "the keys popup takes every key but esc and ?");
  key("escape"); assert.equal(view.showHelp, false);
  key("4"); draw();
  assert.equal(view.view, "github");
  key("i"); assert.equal(view.comments.filter((c) => c.kind === "github").length, 1);
  key("R"); assert.equal(view.replying.id, "T"); draw();
  view.cancelReply(cx);
  key("f"); assert.match(log.overlays.at(-1).props.context, /kim: Use a constant/);
  key("enter"); await settle();
  assert.equal(view.view, "diff");
  assert.ok(view.display.some((d) => d.thread?.id === "T"), "thread shows inline in the branch view");
  draw();
});

test("the GitHub view loads a PR's threads through gh", async () => {
  const pr = { number: 9, url: "https://github.com/o/r/pull/9", title: "T", state: "OPEN" };
  const page = { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [
    { id: "G1", path: "src.js", line: 3, isResolved: false, isOutdated: false, diffSide: "RIGHT", comments: { nodes: [{ id: "c", body: "hm", author: { login: "kim" } }] } }] } } } } };
  world.gh = (args) => ({ code: 0, stderr: "", stdout: JSON.stringify(args[0] === "pr" ? pr : page) });
  view.pr = null; view.threads = []; view.gh = "idle";
  key("2"); key("p"); await settle();
  assert.equal(view.gh, "ready", view.ghError);
  assert.equal(view.threads[0].id, "G1");
  draw();
  world.gh = null;
});

test("q closes the tab when the pane is alone in it, else only the pane", async () => {
  world.panes = [{ pane: "pm", mod: "branch-review", tab: "tr", focused: true }];
  view.closePane();
  assert.deepEqual(log.runs.at(-1), ["tab.close", { id: "tr" }]);
  world.panes.push({ pane: "pt", terminal: "t1", tab: "tr", focused: false });
  view.closePane();
  assert.deepEqual(log.runs.at(-1), ["pane.close", { pane: "pm" }]);
  world.panes = null;
});

test("ctrl-b shift-v opens a review tab named for the branch, with the pane's folder", async () => {
  const { default: Open } = await import("../mods/branch-review-open/main.js");
  world.panes = [{ pane: "p1", terminal: "t1", tab: "tb", cwd: repo, branch: "feat/x", focused: true }];
  world.focused = { space: "s1", tab: "tb", pane: "p1" };
  world.props = { overlay: "ov" };
  new Open().init({}, cx); await settle();
  assert.deepEqual(log.runs.at(-1), ["tab.new", { name: "review: feat/x", space: "s1", mod: "branch-review", props: { folder: repo, on: null, space: "s1" } }]);
  world.panes = null; world.focused = null;
});

test("splitters resize the side column and trade height between side panels, and are kept per repo", async () => {
  view.width = 1200;
  view.drag = { id: "split-col", kind: "col", x: 100, from: 300 };
  view.dragTo({ position: { x: 160, y: 0 } }, cx);
  assert.equal(view.leftWidth(), 360);
  view.dragTo({ position: { x: 5000, y: 0 } }, cx);
  assert.equal(view.leftWidth(), 1200 - 320, "the main panel keeps 320px");
  view.endDrag(cx);
  assert.equal(view.drag, null);
  view.drag = { id: "split-files-commits", kind: "row", y: 50, a: "files", b: "commits", ha: 200, hb: 200 };
  view.dragTo({ position: { x: 0, y: 130 } }, cx);
  assert.deepEqual([view.layout.weights.files, view.layout.weights.commits], [280, 120]);
  view.dragTo({ position: { x: 0, y: 900 } }, cx);
  assert.deepEqual([view.layout.weights.files, view.layout.weights.commits], [340, 60], "each panel keeps 60px");
  view.endDrag(cx);
  const kept = JSON.parse(localStorage.getItem(`layout:${view.root}`));
  assert.equal(kept.left, 1200 - 320);
  assert.equal(kept.weights.files, 340);
  view.showHelp = true; draw(); view.showHelp = false;
});
