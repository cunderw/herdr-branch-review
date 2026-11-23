// Review a branch's diff (the whole branch vs its base, the last commit, picked commits, or uncommitted
// work), comment on lines, ranges or whole files, and send the comments to an agent through a send
// dialog (dialog.js, this mod opened as an overlay of itself). The GitHub view reads the branch's PR
// review threads with `gh` (github.js): fix one, queue it with the review, or reply on GitHub.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Scrollbar, v_virtual_list, VirtualListScrollHandle, TextView } from "gpui-base";
import { spaces, panes, focused, exec, run, theme, settings, props, notify, nextCommand, openOverlay, shared, readTextFile, watchFolder } from "herdr";
import * as R from "./review.js";
import { tokenize, styleFor } from "./syntax.js";
import { Dialog, rankAgents, SENT_KEY } from "./dialog.js";
import { findPr, fetchThreads, replyToThread, visibleThreads } from "./github.js";

// Reads write nothing under .git (no index refresh or lock), as in the changes mod.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const BASES = ["origin/main", "main", "origin/master", "master"];
const MAX_LINES = 3000;
const MAX_UNTRACKED = 100;
const PAGE = 15;
const CONTEXT = 3, STEP = 20, FULL = 1000000;
const ROW = 20, MORE = 24, THREAD = 22, GH_ROW = 46, LIST_ROW = 22;
const GH_POLL = 5 * 60 * 1000;
const ICON = (name) => `mods/branch-review/${name}.svg`;
// Comment prose reads better in the UI font than in the diff's code font.
const UI_FONT = () => settings().ui_font ?? settings().ui_font_family ?? "Geist";
const CODE_FONT = () => settings().font_family ?? "JetBrains Mono";
const SCOPES = ["branch", "last", "uncommitted"];
// The side panels, as in lazygit: a number key jumps to each. The main panel (the diff, or the
// selected GitHub thread) is "diff", on 0.
const PANELS = [["scope", "1", "Scope"], ["files", "2", "Files"], ["commits", "3", "Commits"], ["github", "4", "GitHub"]];

// Keys per panel, for the bottom bar (the first few) and the ? popup (all of them).
const GLOBAL_KEYS = [["1-4 0", "jump to a panel"], ["h l / tab", "previous / next panel"], ["[ ]", "previous / next scope"], ["s", "send the review"], ["t", "next recipient"], ["r", "refresh"], ["?", "keys"], ["q", "close"]];
const PANEL_KEYS = {
  scope: [["j k", "pick a scope"], ["b u", "branch / uncommitted"], ["enter", "go to files"]],
  files: [["j k", "pick a file"], ["enter", "go to the diff"], ["c", "comment on the file"], ["a", "ask about the file"], ["e E", "more context / whole file"]],
  commits: [["j k", "move"], ["enter", "show this commit (again: back)"], ["shift-enter", "show the range to here"], ["v", "pick a range, then enter"]],
  github: [["j k", "pick a thread"], ["enter", "show in diff"], ["f", "fix: send to agent"], ["i", "add to / remove from review"], ["R", "reply on GitHub"], ["o O", "open thread / PR"], ["H", "show resolved"]],
  diff: [["c enter", "comment (or edit)"], ["v", "pick lines, then c"], ["a", "ask"], ["C", "comment on the file"], ["x U", "delete / undo"], ["e E", "more context / whole file"], ["ctrl-d ctrl-u", "page"], ["gg G", "top / bottom"], ["esc", "back to the panel"]],
};

// The folder this pane reviews: its props from the opener, else the focused pane's.
function startFolder() {
  const p = props() ?? {};
  const space = spaces().find((s) => s.active), f = focused();
  if (p.folder) return { cwd: p.folder, on: p.on ?? null, space: p.space ?? f?.space ?? space?.id };
  const pane = f?.pane ? panes().find((x) => x.pane === f.pane) : null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on: space?.machine ?? null, space: f?.space ?? space?.id };
}

// Tokens for each row. Old and new sides keep their own block-comment state.
function highlight(rows, path) {
  const style = styleFor(path), oldState = {}, newState = {};
  for (const row of rows) {
    if (row.kind === "-") row.tokens = tokenize(row.text, style, oldState);
    else if (row.kind === "+") row.tokens = tokenize(row.text, style, newState);
    else if (row.kind === " ") { row.tokens = tokenize(row.text, style, newState); oldState.block = newState.block; }
  }
  return rows;
}

const ago = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 90 ? "now" : s < 5400 ? `${Math.round(s / 60)}m` : s < 129600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};
const split = (path) => { const i = path.lastIndexOf("/"); return i < 0 ? ["", path] : [path.slice(0, i + 1), path.slice(i + 1)]; };
// A theme color at an alpha. Colors can already carry one (#rrggbbaa), so that one is replaced.
const tint = (c, a) => (typeof c === "string" && c.length === 9 ? c.slice(0, 7) : c) + a;
const STATUS = { A: "ansi2", U: "ansi2", D: "ansi1", M: "blocked", R: "accent", T: "dim" };

export default class BranchReview extends View {
  init(p, cx) {
    // The send dialog is this mod opened as an overlay: hand that copy over before anything runs git.
    if (props()?.dialog) { this.dialog = new Dialog(); this.dialog.init(p, cx); return; }
    Object.assign(this, startFolder());
    this.scope = { kind: "branch" };
    this.commits = []; this.files = []; this.rows = []; this.comments = [];
    this.open = null; this.editing = null; this.target = null; this.gen = 0;
    this.ctx = new Map(); this.place = { at: new Map(), outdated: new Set() };
    // section: the focused panel. side: the last side panel focused, which picks what the main panel shows.
    this.cursor = 0; this.commitCursor = 0; this.section = "files"; this.side = "files"; this.pending = null;
    this.visual = null; this.vrow = null;
    this.threads = []; this.pr = null; this.gh = "idle"; this.ghCursor = 0; this.showResolved = false; this.seen = {};
    this.width = 800;
    this.layout = { left: null, weights: {} }; this.heights = {}; this.drag = null;
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.commitScroll = VirtualListScrollHandle.new();
    this.fileScroll = VirtualListScrollHandle.new();
    this.ghScroll = VirtualListScrollHandle.new();
    this.input = TextareaState.new({ placeholder: "Write a comment…", rows: 2 });
    this.input.set_auto_grow(2, 8);
    // Enter saves; Shift-Enter is a new line, which the textarea inserts itself.
    this.input.on("submit", (e, cx) => { if (!e?.shift) this.saveComment(cx); });
    this.input.on("focus", (_e, cx) => { this.typing = "comment"; cx.notify(); });
    this.input.on("blur", (_e, cx) => { if (this.typing === "comment") this.typing = null; this.catchUp(cx); cx.notify(); });
    this.replyInput = TextareaState.new({ placeholder: "Reply on GitHub… (⌘-Enter posts)", rows: 2 });
    this.replyInput.set_auto_grow(2, 8);
    this.replyInput.on("focus", (_e, cx) => { this.typing = "reply"; cx.notify(); });
    this.replyInput.on("blur", (_e, cx) => { if (this.typing === "reply") this.typing = null; this.catchUp(cx); cx.notify(); });
    this.refresh(cx);
    cx.timer.every(15000, (cx) => { if (!this.typing) this.refresh(cx); });
    cx.timer.every(GH_POLL, (cx) => this.loadThreads(cx));
    // pane.go and a fresh pane hand this copy the keyboard through "focus".
    // Focusing during init can come before the pane is on screen, so try again once it has drawn.
    for (const ms of [50, 300]) cx.timer.after(ms, (cx) => { if (!this.typing && !this.handle.is_focused()) { this.handle.focus(); cx.notify(); } });
    cx.spawn(async (cx) => {
      this.handle.focus();
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.handle.focus();
        else if (c === "close") this.closePane();
        else if (c === "send") this.send(cx);
        else if (c === "ask") this.ask(cx);
        else if (c === "refresh") this.refresh(cx, true);
        else if (c === "github") this.toggleView(cx);
        cx.notify();
      }
    });
  }

  // What the main panel shows: the GitHub panel's thread, or the diff of the picked file.
  get view() { return this.side === "github" ? "github" : "diff"; }
  set view(v) { if (v === "github") this.side = "github"; else if (this.side === "github") this.side = "files"; }

  // ---- git ---------------------------------------------------------------------------------------

  git(args) { return exec("git", [...READ, ...args], { cwd: this.root, on: this.on }); }
  async out(args) {
    const r = await this.git(args);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `git ${args[0]} failed`);
    return r.stdout;
  }
  runGh(args) { return exec("gh", args, { cwd: this.root, on: this.on }); }

  storeKey() { return `comments:${this.root}:${this.branch}`; }
  // Splitter sizes, kept per repo: the side column's width and the side panels' shares of its height.
  loadLayout() {
    try { Object.assign(this.layout, JSON.parse(localStorage.getItem(`layout:${this.root}`) ?? "{}")); } catch {}
  }
  saveLayout() { try { localStorage.setItem(`layout:${this.root}`, JSON.stringify(this.layout)); } catch {} }

  loadComments() {
    try { this.comments = JSON.parse(localStorage.getItem(this.storeKey()) ?? "[]").map(R.migrate); } catch { this.comments = []; }
    try { this.seen = JSON.parse(localStorage.getItem(`gh-seen:${this.root}`) ?? "{}"); } catch { this.seen = {}; }
  }
  saveComments() { localStorage.setItem(this.storeKey(), JSON.stringify(this.comments)); }
  saveSeen() { localStorage.setItem(`gh-seen:${this.root}`, JSON.stringify(this.seen)); }

  label() { return R.scopeLabel(this.scope, this.base, this.commits, this.last); }
  refs() { return R.diffRefs(this.scope, { mergeBase: this.mergeBase, commits: this.commits, headParent: this.headParent }); }
  refArgs() { const r = this.refs(); return r ? [r.from, ...(r.to ? [r.to] : [])] : null; }

  // `force`: Refresh pressed. Timer and watch refreshes skip while one is running.
  refresh(cx, force = false) {
    if (!this.cwd) return;
    if (this.loading) { if (force) this.again = true; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: this.cwd, on: this.on });
        if (top.code !== 0) { this.error = "Not a git repository"; this.root = null; return; }
        const root = top.stdout.trim();
        const branch = (await exec("git", ["branch", "--show-current"], { cwd: root, on: this.on })).stdout.trim() || "HEAD";
        if (root !== this.root || branch !== this.branch) {
          const newRoot = root !== this.root;
          this.root = root; this.branch = branch; this.base = null; this.pr = null; this.threads = []; this.gh = "idle";
          this.scope = { kind: "branch" }; this.open = null; this.editing = null; this.ctx = new Map();
          this.loadComments(); this.loadLayout();
          if (newRoot) this.watch(cx);
        }
        if (!this.base) this.base = await this.findBase();
        this.mergeBase = (await this.out(["merge-base", "HEAD", this.base])).trim();
        const parent = await this.git(["rev-parse", "--verify", "--quiet", "HEAD~1"]);
        this.headParent = parent.code === 0 ? parent.stdout.trim() : null;
        const head = (await this.out(["log", "-1", "--format=%h%x1f%s"])).trim().split("\x1f");
        this.last = { short: head[0], subject: head[1] ?? "" };
        const log = await this.out(["log", "--format=%H%x1f%h%x1f%P%x1f%s%x1f%ar", "-n", "200", `${this.mergeBase}..HEAD`]);
        this.commits = log.split("\n").filter(Boolean).map((l) => {
          const [sha, short, parents, subject, when] = l.split("\x1f");
          return { sha, short, parent: parents.split(" ")[0] ?? "", subject, when };
        });
        if (this.scope.kind === "commits") {
          const shas = this.scope.shas.filter((s) => this.commits.some((c) => c.sha === s));
          this.scope = shas.length ? { kind: "commits", shas } : { kind: "branch" };
        }
        this.error = null;
        await this.loadFiles();
        if (this.gh === "idle") this.loadThreads(cx);
      } catch (e) { this.error = String(e.message ?? e); }
      finally {
        this.loading = false; cx.notify();
        if (this.again) { this.again = false; this.refresh(cx); }
      }
    });
  }

  // Refresh soon after files change under the repo (local repos; a remote one has the 15 s timer).
  watch(cx) {
    if (this.on) return;
    const root = this.root;
    cx.spawn(async (cx) => {
      while (this.root === root) {
        let paths;
        try { paths = await watchFolder(root); } catch { return; }
        if (this.root !== root) return;
        const real = paths.filter((p) => !/\/\.git\/(objects|logs)\//.test(p) && !p.endsWith(".lock"));
        if (!real.length || this.soon) continue;
        // Don't move the diff under someone typing: refresh once they leave the box.
        if (this.typing) { this.dirty = true; continue; }
        this.soon = true;
        cx.timer.after(400, (cx) => { this.soon = false; this.refresh(cx); });
      }
    });
  }

  // A change seen while typing refreshes once the typing stops.
  catchUp(cx) { if (this.dirty && !this.typing) { this.dirty = false; this.refresh(cx); } }

  async findBase() {
    const head = await this.git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (head.code === 0 && head.stdout.trim()) return head.stdout.trim();
    for (const b of BASES) if ((await this.git(["rev-parse", "--verify", "--quiet", b])).code === 0) return b;
    throw new Error("No origin/main, main, origin/master or master to compare with");
  }

  async loadFiles() {
    const gen = ++this.gen, refs = this.refArgs();
    if (!refs) { this.files = []; this.rows = []; return; }
    const [stat, names] = await Promise.all([
      this.out(["diff", ...refs, "--numstat", "-z", "--no-renames"]),
      this.out(["diff", ...refs, "--name-status", "-z", "--no-renames"]),
    ]);
    if (gen !== this.gen) return;
    const status = new Map(), parts = names.split("\0");
    for (let i = 0; i + 1 < parts.length; i += 2) status.set(parts[i + 1], parts[i][0]);
    const files = stat.split("\0").filter(Boolean).map((entry) => {
      const [a, d, ...rest] = entry.split("\t"), path = rest.join("\t");
      return { path, add: Number(a) || 0, del: Number(d) || 0, binary: a === "-", status: status.get(path) ?? "M" };
    }).filter((f) => f.path);
    if (R.withUntracked(this.scope)) {
      const list = (await this.out(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
      for (const path of list.slice(0, MAX_UNTRACKED)) {
        const r = await this.git(["diff", "--no-index", "--numstat", "--", "/dev/null", path]);
        const [a] = r.stdout.split("\t");
        files.push({ path, add: Number(a) || 0, del: 0, binary: a === "-", status: "U", untracked: true });
      }
      this.untrackedCut = Math.max(0, list.length - MAX_UNTRACKED);
    } else this.untrackedCut = 0;
    if (gen !== this.gen) return;
    this.files = files.sort((a, b) => a.path.localeCompare(b.path));
    if (!this.files.some((f) => f.path === this.open)) this.open = this.files[0]?.path ?? null;
    await this.loadDiff(gen);
  }

  file(path = this.open) { return this.files.find((f) => f.path === path); }
  contextFor(path) { return this.ctx.get(path) ?? CONTEXT; }

  // A file's diff text as lines, from its first hunk, cut to MAX_LINES.
  async diffLines(path, n) {
    const f = this.file(path);
    let text;
    if (f?.untracked) {
      const r = await this.git(["diff", "--no-index", "--no-color", "--no-ext-diff", `-U${n}`, "--", "/dev/null", path]);
      if (r.code > 1) throw new Error(r.stderr.trim() || "git diff failed");
      text = r.stdout;
    } else text = await this.out(["diff", ...this.refArgs(), "--no-ext-diff", "--no-textconv", "--no-color", `-U${n}`, "--", path]);
    const all = text.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
    if (first < 0) return null;
    return all.slice(first, first + MAX_LINES).map((l) => (l.length > 2000 ? l.slice(0, 2000) + "…" : l));
  }

  // How many lines the new side of a file has, so the diff knows if there is more below its last hunk.
  async lineCount(path) {
    const f = this.file(path), to = this.refs()?.to;
    if (f?.status === "D") return 0;
    let text = null;
    if (!to) text = await readTextFile(`${this.root}/${path}`, { on: this.on }).catch(() => null);
    else { const r = await this.git(["show", `${to}:${path}`]); text = r.code === 0 ? r.stdout : null; }
    if (text == null) return null;
    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  }

  async rowsFor(path) {
    const n = this.contextFor(path), lines = await this.diffLines(path, n);
    if (!lines) return [{ kind: "", text: this.file(path)?.binary ? "Binary file: no text diff. Comment on the whole file instead." : "No text diff (a mode change or an empty file)." }];
    const end = n >= FULL ? null : await this.lineCount(path);
    return highlight(R.diffRows(lines, { more: n < FULL, end }), path);
  }

  async loadDiff(gen = this.gen) {
    const path = this.open;
    if (!path || !this.refArgs()) { this.rows = []; return; }
    const before = this.rows, rows = await this.rowsFor(path);
    if (gen !== this.gen || path !== this.open) return;
    // An open comment box keeps its lines when the diff under it changes.
    const ed = this.editing;
    if (ed?.kind === "range" && ed.path === path && before !== rows) {
      const draft = R.rangeComment(before, ed.a, ed.b, { path, label: ed.label, text: "" });
      const at = draft && R.locate(rows, draft);
      if (at) { ed.a = at.from; ed.b = at.to; ed.lost = false; } else if (draft) ed.lost = true;
    }
    this.rows = rows;
    this.placeComments();
    this.cursor = Math.min(this.cursor, Math.max(0, this.displayRows().length - 1));
    this.diffWidth = Math.max(300, ...rows.map((r) => Math.min(r.text.length, 2000) * 6.7 + 110));
  }

  // Where this view's comments on the open file are now. Moved lines take their new numbers.
  placeComments() {
    const label = this.label(), mine = this.comments.filter((c) => c.path === this.open && c.label === label);
    this.place = R.placeAll(this.rows, mine);
    let moved = false;
    this.comments = this.comments.map((c) => {
      const p = this.place.at.get(c.id);
      if (!p) return c;
      const next = R.refreshed(this.rows, c, p);
      if (JSON.stringify(next.lines) !== JSON.stringify(c.lines)) { moved = true; return next; }
      return c;
    });
    if (moved) this.saveComments();
  }

  reload(cx) {
    cx.spawn(async (cx) => {
      try { await this.loadFiles(); this.error = null; } catch (e) { this.error = String(e.message ?? e); }
      cx.notify();
    });
    cx.notify();
  }

  setScope(scope, cx) {
    if (scope.kind !== "commits") this.anchor = null;
    this.scope = scope; this.open = null; this.cursor = 0; this.editing = null; this.vrow = null;
    this.reload(cx);
  }

  clickCommit(sha, e, cx) {
    const current = this.scope.kind === "commits" ? this.scope.shas : [];
    if (e?.modifiers?.shift && this.anchor) this.setScope({ kind: "commits", shas: R.rangeBetween(this.commits, this.anchor, sha) }, cx);
    else if (current.length === 1 && current[0] === sha) this.setScope({ kind: "branch" }, cx);
    else { this.setScope({ kind: "commits", shas: [sha] }, cx); this.anchor = sha; }
  }

  pickFile(path, cx) {
    if (path === this.open) return;
    if (this.editing?.kind === "range" && !this.input.value().trim()) this.editing = null;
    this.open = path; this.rows = []; this.cursor = 0; this.vrow = null;
    this.scroll.scroll_to_item(0);
    cx.spawn(async (cx) => {
      try { await this.loadDiff(); } catch (e) { this.error = String(e.message ?? e); }
      cx.notify();
    });
    cx.notify();
  }

  // More unchanged lines around this file's changes, or all of them.
  expand(cx, full = false) {
    if (!this.open) return;
    const n = this.contextFor(this.open);
    this.ctx.set(this.open, full ? (n >= FULL ? CONTEXT : FULL) : Math.min(FULL, n + STEP));
    cx.spawn(async (cx) => {
      try { await this.loadDiff(); } catch (e) { this.error = String(e.message ?? e); }
      cx.notify();
    });
  }

  // ---- comments ----------------------------------------------------------------------------------

  // Code rows of the hunk a header (or any row) belongs to.
  hunkOf(ri) {
    let lo = ri, hi = ri;
    if (this.rows[ri]?.kind === "@") lo = hi = ri + 1;
    while (lo > 0 && R.isCode(this.rows[lo - 1])) lo--;
    while (hi + 1 < this.rows.length && R.isCode(this.rows[hi + 1])) hi++;
    return R.isCode(this.rows[lo]) ? [lo, hi] : null;
  }

  // Focus again once the box is drawn; not if it was saved or closed in between.
  focusInput(input, cx) {
    input.focus();
    const wanted = () => (input === this.input ? Boolean(this.editing) : Boolean(this.replying));
    cx.timer.after(40, () => { if (wanted()) input.focus(); });
  }

  startRange(a, b, cx) {
    if (!this.open || !R.isCode(this.rows[a]) || !R.isCode(this.rows[b])) return;
    const keep = this.editing?.kind === "range" && this.editing.path === this.open && !this.editing.id;
    this.editing = { kind: "range", path: this.open, label: this.label(), a, b };
    if (!keep) this.input.set_value("");
    this.view = "diff"; this.vrow = null;
    this.focusInput(this.input, cx);
    cx.notify();
  }

  startFile(path, cx) {
    if (!path) return;
    const existing = this.comments.find((c) => c.kind === "file" && c.path === path && c.label === this.label());
    if (existing) return this.editComment(existing, cx);
    this.editing = { kind: "file", path, label: this.label() };
    this.input.set_value("");
    this.focusInput(this.input, cx);
    cx.notify();
  }

  editComment(c, cx) {
    const p = this.place.at.get(c.id);
    this.editing = { kind: c.kind, path: c.path, label: c.label, id: c.id, a: p?.from, b: p?.to, outdated: !p && c.kind === "range" };
    this.input.set_value(c.text);
    this.focusInput(this.input, cx);
    cx.notify();
  }

  saveComment(cx) {
    const ed = this.editing;
    if (!ed) return;
    const text = this.input.value().trim();
    if (!text) return this.cancelComment(cx);
    if (ed.id) {
      const old = this.comments.find((c) => c.id === ed.id);
      let next = { ...old, text };
      // A re-picked range on an edited comment takes the new lines.
      if (ed.kind === "range" && ed.a != null && !ed.lost) next = { ...R.rangeComment(this.rows, ed.a, ed.b, { path: ed.path, label: ed.label, text, id: ed.id }) };
      this.comments = this.comments.map((c) => (c.id === ed.id ? next : c));
    } else if (ed.kind === "file") this.comments.push(R.fileComment({ path: ed.path, label: ed.label, text }));
    else {
      if (ed.lost) return;
      const c = R.rangeComment(this.rows, ed.a, ed.b, { path: ed.path, label: ed.label, text });
      if (c) this.comments.push(c);
    }
    this.saveComments(); this.placeComments();
    this.editing = null; this.input.set_value(""); this.typing = null; this.handle.focus();
    cx.notify();
  }

  cancelComment(cx) {
    this.editing = null; this.input.set_value(""); this.typing = null; this.handle.focus();
    cx.notify();
  }

  deleteComment(id, cx) {
    const c = this.comments.find((x) => x.id === id);
    if (!c) return;
    this.comments = this.comments.filter((x) => x.id !== id);
    if (this.editing?.id === id) { this.editing = null; this.input.set_value(""); this.typing = null; this.handle.focus(); }
    this.saveComments(); this.placeComments();
    this.undo = c;
    notify({ title: "Comment deleted", body: `${c.text.slice(0, 80)} · U brings it back`, level: "info", timeout: 4000 });
    cx.notify();
  }

  // ---- clicks ------------------------------------------------------------------------------------

  // Virtual list rows can't take on_click, so the list reports the clicked row's key (its index).
  clickRow(key, cx) {
    const i = Number(key), item = this.display?.[i];
    this.cursor = i; this.section = "diff";
    if (!item) return;
    if (item.comment) return this.editComment(item.comment, cx);
    if (item.thread) return this.showThread(item.thread, cx);
    const { row, ri } = item;
    if (row.kind === "more") return this.expand(cx);
    if (row.kind === "@") { const h = this.hunkOf(ri); if (h) this.startRange(h[0], h[1], cx); return; }
    if (!R.isCode(row)) return;
    const ed = this.editing;
    // Shift-click stretches the open comment to here.
    if (this.shiftDown && ed?.kind === "range" && ed.path === this.open && !ed.lost) return this.startRange(ed.a, ri, cx);
    const there = this.comments.find((c) => this.place.at.get(c.id)?.to === ri && c.label === this.label() && c.path === this.open);
    if (there && !this.shiftDown) return this.editComment(there, cx);
    this.startRange(ri, ri, cx);
  }

  // Right-click asks about that line, the hunk (on its header), or the selection it's inside.
  secondaryRow(key, cx) {
    const item = this.display?.[Number(key)];
    if (!item?.row) return;
    this.cursor = Number(key);
    const ri = item.ri, sel = this.selection();
    if (sel && ri >= sel[0] && ri <= sel[1]) return this.ask(cx);
    if (item.row.kind === "@") { const h = this.hunkOf(ri); if (h) return this.askRows(h[0], h[1], "the hunk", cx); return; }
    if (R.isCode(item.row)) this.askRows(ri, ri, null, cx);
  }

  // The row range picked right now: v in the diff, or the open comment's lines.
  selection() {
    const ri = this.display?.[this.cursor]?.ri;
    if (this.vrow != null && ri != null) return [Math.min(this.vrow, ri), Math.max(this.vrow, ri)];
    const ed = this.editing;
    if (ed?.kind === "range" && ed.path === this.open && ed.a != null && !ed.lost) return [Math.min(ed.a, ed.b), Math.max(ed.a, ed.b)];
    return null;
  }

  // ---- ask & send --------------------------------------------------------------------------------

  openDialog(dialog, { title, context, sendId, outdated = 0 }) {
    const lines = context.split("\n").length;
    openOverlay({
      mod: "branch-review", kind: "dialog", width: 760, height: Math.min(640, 300 + Math.min(lines, 24) * 15),
      props: { dialog, title, context, sendId, outdated, target: this.currentTarget(), root: this.root, space: this.space },
    });
  }

  askRows(a, b, what, cx) {
    const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
    const rows = this.rows.slice(lo, hi + 1);
    const c = R.rangeComment(this.rows, lo, hi, { path: this.open, label: "", text: "" });
    const title = what ?? (c ? R.linesLabel(c) : "these lines");
    this.vrow = null;
    this.openDialog("ask", { title: `${this.open} · ${title}`, context: R.questionContext({ path: this.open, rows, title: `${title} (${this.label()})` }) });
    cx.notify();
  }

  // a: the selection, else the line under the cursor (its hunk on a header), else the file's whole diff.
  ask(cx) {
    if (!this.open) return;
    if (this.section !== "diff") return this.askFile(cx);
    const sel = this.selection();
    if (sel) return this.askRows(sel[0], sel[1], null, cx);
    const item = this.display?.[this.cursor];
    if (item?.row?.kind === "@") { const h = this.hunkOf(item.ri); if (h) return this.askRows(h[0], h[1], "the hunk", cx); }
    if (item?.row && R.isCode(item.row)) return this.askRows(item.ri, item.ri, null, cx);
    this.askFile(cx);
  }

  askFile(cx) {
    if (!this.open) return;
    this.openDialog("ask", { title: `${this.open} · the diff`, context: R.questionContext({ path: this.open, rows: this.rows, title: `the diff (${this.label()})` }) });
    cx.notify();
  }

  // Checks every commented file of this view against its current diff, then opens the send dialog.
  send(cx) {
    if (!this.comments.length || this.preparing) return;
    this.preparing = true; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const label = this.label(), outdated = new Set();
        const paths = [...new Set(this.comments.filter((c) => c.kind === "range" && c.label === label).map((c) => c.path))];
        for (const path of paths) {
          const rows = path === this.open ? this.rows : await this.rowsFor(path).catch(() => null);
          if (!rows) continue;
          const mine = this.comments.filter((c) => c.path === path && c.label === label);
          const { at, outdated: lost } = R.placeAll(rows, mine);
          for (const id of lost) outdated.add(id);
          this.comments = this.comments.map((c) => (at.has(c.id) ? R.refreshed(rows, c, at.get(c.id)) : c));
        }
        this.saveComments();
        const sendId = R.newId(), list = [...this.comments];
        this.sending = { id: sendId, ids: list.map((c) => c.id) };
        const message = R.reviewMessage({ branch: this.branch, repo: this.root.split("/").pop(), comments: list, outdated });
        const n = list.length;
        this.openDialog("review", { title: `${n} ${n === 1 ? "comment" : "comments"} on ${this.branch}`, context: message, sendId, outdated: outdated.size });
      } catch (e) { this.error = `Couldn't prepare the review: ${e.message ?? e}`; }
      finally { this.preparing = false; cx.notify(); }
    });
  }

  // The dialog says it delivered by setting the shared key to its sendId: drop what it sent.
  checkSent() {
    const s = shared(SENT_KEY);
    if (!this.sending || s?.id !== this.sending.id) return;
    const ids = new Set(this.sending.ids);
    this.comments = this.comments.filter((c) => !ids.has(c.id));
    this.sending = null;
    this.saveComments(); this.placeComments();
  }

  agentsList() { return rankAgents({ target: this.target, root: this.root, space: this.space }); }
  currentTarget() { return this.agentsList()[0]?.address ?? null; }
  // Steps through every agent in a fixed order, starting from the one shown now.
  nextTarget(cx) {
    const list = rankAgents({ target: null, root: this.root, space: this.space });
    if (list.length < 2) return;
    const i = list.findIndex((a) => a.address === this.currentTarget());
    this.target = list[(i + 1) % list.length].address;
    cx.notify();
  }

  // ---- GitHub ------------------------------------------------------------------------------------

  loadThreads(cx) {
    if (!this.root || this.gh === "loading" || this.typing === "reply") return;
    const root = this.root, branch = this.branch;
    this.gh = "loading";
    cx.spawn(async (cx) => {
      try {
        const run = (args) => this.runGh(args);
        if (!this.pr) this.pr = await findPr(run);
        if (root !== this.root || branch !== this.branch) return;
        if (!this.pr) { this.gh = "none"; this.threads = []; return; }
        this.threads = await fetchThreads(run, this.pr);
        this.gh = "ready"; this.ghError = null;
      } catch (e) {
        const msg = String(e?.message ?? e);
        this.gh = "error";
        this.ghError = /ENOENT|not found|No such file|cannot start/i.test(msg) && !/pull/i.test(msg)
          ? "The GitHub CLI (gh) isn't installed here. Install it and run `gh auth login`; local reviews work without it."
          : /auth|login|401|credentials/i.test(msg) ? `gh isn't signed in for this host. Run \`gh auth login${this.pr?.host && this.pr.host !== "github.com" ? ` --hostname ${this.pr.host}` : ""}\`.` : msg;
      } finally { cx.notify(); }
    });
  }

  shownThreads() { return visibleThreads(this.threads, { showResolved: this.showResolved }); }
  isNew(t) { return this.seen[t.id] !== t.version; }
  markSeen(t) { if (t && this.isNew(t)) { this.seen[t.id] = t.version; this.saveSeen(); } }
  queued(t) { return this.comments.some((c) => c.kind === "github" && c.thread?.id === t.id); }

  // p: the GitHub panel, or back to Files from it.
  toggleView(cx) { this.focusPanel(this.view === "github" ? "files" : "github", cx); }

  // The GitHub panel shows once there is a pull request or a gh problem to report, or when asked for.
  hasGithub() { return Boolean(this.pr) || this.gh === "error" || this.side === "github"; }

  focusPanel(name, cx) {
    if (name === "github" && this.side !== "github") {
      this.markSeen(this.shownThreads()[this.ghCursor]);
      if (this.gh === "idle" || this.gh === "none") this.loadThreads(cx);
    }
    if (name !== "diff") this.side = name;
    if (name !== this.section) { this.visual = null; this.vrow = null; }
    this.section = name;
    cx.notify();
  }

  // h / l and tab: the side panels in order, then the main panel.
  cyclePanel(delta, cx) {
    const order = [...PANELS.filter(([name]) => name !== "github" || this.hasGithub()).map(([name]) => name), "diff"];
    const i = Math.max(0, order.indexOf(this.section));
    this.focusPanel(order[(i + delta + order.length) % order.length], cx);
  }

  showThread(t, cx) {
    const i = this.shownThreads().findIndex((x) => x.id === t.id);
    if (i >= 0) this.ghCursor = i;
    this.side = "github"; this.section = "github"; this.markSeen(t);
    this.ghScroll.scroll_to_item(this.ghCursor);
    cx.notify();
  }

  // The thread's line in the diff, when this file and line are in the branch view.
  jumpToThread(t, cx) {
    if (!t) return;
    this.side = "files"; this.section = "diff";
    if (this.scope.kind !== "branch") this.setScope({ kind: "branch" }, cx);
    const go = (cx) => {
      const i = this.display?.findIndex((d) => d.thread?.id === t.id) ?? -1;
      if (i >= 0) { this.cursor = i; this.section = "diff"; this.scroll.scroll_to_item(i, "center"); }
      cx.notify();
    };
    if (this.open === t.path && this.scope.kind === "branch") return go(cx);
    this.open = null;
    cx.spawn(async (cx) => {
      while (this.loading) await new Promise((r) => cx.timer.after(50, r));
      if (this.files.some((f) => f.path === t.path)) { this.open = t.path; this.rows = []; await this.loadDiff().catch(() => {}); this.display = this.displayRows(); }
      go(cx);
    });
  }

  fixThread(t, cx) {
    if (!t) return;
    this.openDialog("ask", { title: `Fix GitHub thread on ${t.path}${t.line ? `:${t.line}` : ""}`, context: `Please address this pull request review thread:\n\n${R.threadText(t)}` });
    cx.notify();
  }

  toggleQueued(t, cx) {
    if (!t) return;
    if (this.queued(t)) this.comments = this.comments.filter((c) => !(c.kind === "github" && c.thread?.id === t.id));
    else this.comments.push({ id: R.newId(), kind: "github", path: t.path, label: "GitHub", text: "", thread: t });
    this.saveComments();
    cx.notify();
  }

  startReply(t, cx) {
    if (!t) return;
    if (this.replying?.id !== t.id) { this.replyInput.set_value(""); this.replyError = null; }
    this.replying = { id: t.id };
    this.focusInput(this.replyInput, cx);
    cx.notify();
  }

  cancelReply(cx) { this.replying = null; this.replyError = null; this.typing = null; this.replyInput.set_value(""); this.handle.focus(); cx.notify(); }

  // Posts as the person. A failure might still have posted, so nothing retries: they check GitHub first.
  postReply(cx) {
    const t = this.threads.find((x) => x.id === this.replying?.id), body = this.replyInput.value().trim();
    if (!t || !body || this.posting || !this.pr) return;
    this.posting = true; this.replyError = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        await replyToThread((args) => this.runGh(args), this.pr, t.id, body);
        notify({ title: "Reply posted", body: `${t.path}${t.line ? `:${t.line}` : ""}`, level: "success", timeout: 4000 });
        this.replying = null; this.replyInput.set_value(""); this.typing = null; this.handle.focus();
        this.gh = "ready"; this.loadThreads(cx);
      } catch (e) {
        this.replyError = `Not confirmed: ${String(e?.message ?? e).split("\n")[0]}. It may still have posted, so check the thread on GitHub before posting again.`;
      } finally { this.posting = false; cx.notify(); }
    });
  }

  // ---- keys --------------------------------------------------------------------------------------

  // Not named close(): Herdr calls a view's close() when its pane goes away.
  // Only ever closes a branch-review pane, never the focused pane by default. Alone in its tab
  // (as ctrl-b shift-v opens it), it closes the tab; in a split, only its pane.
  closePane() {
    const all = panes(), me = all.find((p) => p.mod === "branch-review" && p.focused);
    if (!me) return;
    const alone = me.tab && all.filter((p) => p.tab === me.tab).length === 1;
    if (alone) run("tab.close", { id: me.tab });
    else run("pane.close", { pane: me.pane });
  }

  // The Scope panel's rows: the three scopes, and the picked commits while they're shown.
  scopeItems() {
    const items = SCOPES.map((kind) => ({ kind }));
    if (this.scope.kind === "commits") items.push(this.scope);
    return items;
  }
  scopeIndex() { return Math.max(0, this.scopeItems().findIndex((s) => s.kind === this.scope.kind)); }

  // [ and ]: the three scopes in turn.
  cycleScope(delta, cx) {
    const i = SCOPES.indexOf(this.scope.kind);
    const next = i < 0 ? (delta > 0 ? 0 : SCOPES.length - 1) : (i + delta + SCOPES.length) % SCOPES.length;
    this.setScope({ kind: SCOPES[next] }, cx);
  }

  // j / k move in the GitHub list from its panel and from the thread it shows.
  onThreads() { return this.section === "github" || (this.section === "diff" && this.view === "github"); }

  moveTo(to, cx) {
    if (this.onThreads()) {
      const n = this.shownThreads().length;
      if (!n) return;
      this.ghCursor = Math.max(0, Math.min(n - 1, to));
      this.ghScroll.scroll_to_item(this.ghCursor);
      this.markSeen(this.shownThreads()[this.ghCursor]);
      if (this.replying && !this.replyInput.value().trim()) this.replying = null;
      return cx.notify();
    }
    if (this.section === "diff") {
      const n = this.display?.length ?? 0;
      if (!n) return;
      this.cursor = Math.max(0, Math.min(n - 1, to));
      this.scroll.scroll_to_item(this.cursor);
      return cx.notify();
    }
    if (this.section === "scope") {
      const items = this.scopeItems(), s = items[Math.max(0, Math.min(items.length - 1, to))];
      if (s.kind !== this.scope.kind) this.setScope(s, cx);
      return cx.notify();
    }
    if (this.section === "commits") {
      if (!this.commits.length) return;
      this.commitCursor = Math.max(0, Math.min(this.commits.length - 1, to));
      this.commitScroll.scroll_to_item(this.commitCursor);
      return cx.notify();
    }
    if (!this.files.length) return;
    const i = Math.max(0, Math.min(this.files.length - 1, to));
    this.fileScroll.scroll_to_item(i);
    this.pickFile(this.files[i].path, cx);
  }

  position() {
    if (this.onThreads()) return this.ghCursor;
    if (this.section === "scope") return this.scopeIndex();
    if (this.section === "commits") return this.commitCursor;
    if (this.section === "files") return Math.max(0, this.files.findIndex((f) => f.path === this.open));
    return this.cursor;
  }

  // v: in Commits it starts a commit selection; in the diff, a line selection.
  toggleVisual(cx) {
    if (this.section === "commits" && this.commits.length) this.visual = this.visual == null ? this.commitCursor : null;
    else if (this.section === "diff") {
      const ri = this.display?.[this.cursor]?.ri;
      this.vrow = this.vrow == null && R.isCode(this.rows[ri]) ? ri : null;
    }
    cx.notify();
  }

  enter(shift, cx) {
    if (this.onThreads()) return this.jumpToThread(this.shownThreads()[this.ghCursor], cx);
    if (this.section === "scope") return this.focusPanel("files", cx);
    if (this.section === "commits" && this.visual != null) {
      const [lo, hi] = [Math.min(this.visual, this.commitCursor), Math.max(this.visual, this.commitCursor)];
      this.visual = null;
      this.setScope({ kind: "commits", shas: this.commits.slice(lo, hi + 1).map((c) => c.sha) }, cx);
      this.anchor = this.commits[this.commitCursor].sha;
    } else if (this.section === "commits") {
      const c = this.commits[this.commitCursor];
      if (c) this.clickCommit(c.sha, { modifiers: { shift } }, cx);
    } else if (this.section === "files") this.focusPanel("diff", cx);
    else this.comment(cx);
  }

  // c (and Enter in the diff): comment on the selection, or act on the row under the cursor.
  comment(cx) {
    if (this.section === "files") return this.startFile(this.open, cx);
    this.section = "diff";
    if (this.vrow != null) {
      const ri = this.display?.[this.cursor]?.ri;
      if (ri != null) return this.startRange(this.vrow, ri, cx);
    }
    this.shiftDown = false;
    this.clickRow(String(this.cursor), cx);
  }

  commentAtCursor() {
    const item = this.display?.[this.cursor];
    if (item?.comment) return item.comment;
    if (item?.ri == null) return null;
    return this.comments.find((c) => c.path === this.open && c.label === this.label() && (() => {
      const p = this.place.at.get(c.id);
      return p && item.ri >= p.from && item.ri <= p.to;
    })());
  }

  onKey(e, cx) {
    const m = e.modifiers ?? {};
    if (this.typing) {
      if (e.key === "escape") { cx.stop_propagation(); return this.typing === "reply" ? this.cancelReply(cx) : this.cancelComment(cx); }
      if (e.key === "enter" && (m.platform || m.control)) {
        cx.stop_propagation();
        return this.typing === "reply" ? this.postReply(cx) : this.saveComment(cx);
      }
      return;
    }
    const k = e.keystroke, ch = e.key_char ?? "";
    const pending = this.pending;
    this.pending = null;
    const t = this.shownThreads()[this.ghCursor];
    const none = () => {};
    const gh = this.onThreads() ? {
      "f": () => this.fixThread(t, cx), "i": () => this.toggleQueued(t, cx), "R": () => this.startReply(t, cx),
      "o": () => t?.url && exec("open", [t.url]), "O": () => this.pr?.url && exec("open", [this.pr.url]),
      "H": () => { this.showResolved = !this.showResolved; this.ghCursor = 0; cx.notify(); },
      "c": none, "C": none, "v": none, "x": none, "a": none, "e": none, "E": none,
    } : {};
    const act = {
      "tab": () => this.cyclePanel(1, cx), "shift-tab": () => this.cyclePanel(-1, cx),
      "l": () => this.cyclePanel(1, cx), "h": () => this.cyclePanel(-1, cx),
      "right": () => this.cyclePanel(1, cx), "left": () => this.cyclePanel(-1, cx),
      "1": () => this.focusPanel("scope", cx), "2": () => this.focusPanel("files", cx), "3": () => this.focusPanel("commits", cx),
      "4": () => this.focusPanel("github", cx), "0": () => this.focusPanel("diff", cx),
      "[": () => this.cycleScope(-1, cx), "]": () => this.cycleScope(1, cx),
      "j": () => this.moveTo(this.position() + 1, cx), "down": () => this.moveTo(this.position() + 1, cx),
      "k": () => this.moveTo(this.position() - 1, cx), "up": () => this.moveTo(this.position() - 1, cx),
      "ctrl-d": () => this.moveTo(this.position() + PAGE, cx), "ctrl-u": () => this.moveTo(this.position() - PAGE, cx),
      "G": () => this.moveTo(Infinity, cx),
      "g": () => { if (pending === "g") this.moveTo(0, cx); else this.pending = "g"; },
      "enter": () => this.enter(false, cx), "shift-enter": () => this.enter(true, cx),
      "v": () => this.toggleVisual(cx),
      "escape": () => {
        if (this.showHelp) this.showHelp = false;
        else if (this.vrow != null) this.vrow = null;
        else if (this.visual != null) this.visual = null;
        else if (this.section === "diff") this.section = this.side;
        cx.notify();
      },
      "b": () => this.setScope({ kind: "branch" }, cx),
      "u": () => this.setScope({ kind: "uncommitted" }, cx),
      "c": () => this.comment(cx),
      "C": () => this.startFile(this.open, cx),
      "x": () => { const c = this.commentAtCursor(); if (c) this.deleteComment(c.id, cx); },
      "U": () => { if (this.undo) { this.comments.push(this.undo); this.undo = null; this.saveComments(); this.placeComments(); cx.notify(); } },
      "a": () => this.ask(cx),
      "e": () => this.expand(cx),
      "E": () => this.expand(cx, true),
      "s": () => this.send(cx),
      "t": () => this.nextTarget(cx),
      "p": () => this.toggleView(cx),
      "r": () => { this.refresh(cx, true); if (this.view === "github") { this.gh = "ready"; this.loadThreads(cx); } },
      // Closing this pane from inside its own key handler does nothing, so close on the next tick.
      "q": () => cx.timer.after(0, () => this.closePane()),
      "?": () => { this.showHelp = !this.showHelp; cx.notify(); },
      ...gh,
    };
    // While the keys popup is open, only Esc and ? reach the pane.
    if (this.showHelp && k !== "escape" && ch !== "?") { cx.stop_propagation(); return; }
    const named = ["tab", "shift-tab", "enter", "shift-enter", "down", "up", "left", "right", "escape"];
    const fn = act[k.startsWith("ctrl-") || named.includes(k) ? k : ch];
    if (fn) { cx.stop_propagation(); fn(); }
  }

  // ---- drawing -----------------------------------------------------------------------------------

  // Characters per line of a comment card's text, from the pane's width.
  cardWidth() { return Math.max(240, Math.min(760, this.mainWidth() - 70)); }
  commentHeight(c, outdated = false) {
    const lines = Math.min(12, R.wrappedLines(c.text, (this.cardWidth() - 20) / 6.6));
    return 42 + lines * 16 + (outdated ? 16 : 0);
  }

  // Diff rows with each comment under its last line, whole-file and outdated ones on top,
  // and (in the branch view) GitHub threads under the lines they're on.
  displayRows() {
    const label = this.label(), out = [];
    const mine = this.comments.filter((c) => c.path === this.open && c.label === label);
    for (const c of mine) if (c.kind === "file") out.push({ comment: c });
    for (const c of mine) if (c.kind === "range" && this.place.outdated.has(c.id)) out.push({ comment: c, outdated: true });
    const after = new Map();
    this.covered = new Set();
    for (const c of mine) {
      const p = this.place.at.get(c.id);
      if (!p) continue;
      after.set(p.to, [...(after.get(p.to) ?? []), c]);
      for (let i = p.from; i <= p.to; i++) this.covered.add(i);
    }
    const threads = new Map();
    if (this.scope.kind === "branch") for (const t of this.threads) {
      if (t.path !== this.open || t.isOutdated || !t.line || (t.isResolved && !this.showResolved)) continue;
      const key = `${t.side}:${t.line}`;
      threads.set(key, [...(threads.get(key) ?? []), t]);
    }
    this.rows.forEach((row, ri) => {
      out.push({ row, ri });
      for (const c of after.get(ri) ?? []) out.push({ comment: c });
      const a = R.anchorOf(row);
      // A context line is on both sides; GitHub puts a thread on a removed line on the left.
      const keys = a ? (row.kind === " " ? [`new:${row.next}`] : [`${a.side}:${a.line}`]) : [];
      for (const k of keys) for (const t of threads.get(k) ?? []) out.push({ thread: t, ri });
    });
    return out;
  }

  itemSize(item) {
    if (item.comment) return this.commentHeight(item.comment, item.outdated);
    if (item.thread) return THREAD;
    if (item.row?.kind === "more") return MORE;
    return ROW;
  }

  // The cursor of the active section: a bar on the row's left edge.
  marker(on, t, color) { return div().w(3).h_full().flex_none().when(on, (e) => e.bg(color ?? t.accent)); }

  tokenColor(kind, t) {
    return { keyword: t.ansi5, string: t.ansi2, number: t.ansi3, comment: t.dim, type: t.ansi6, call: t.ansi4 }[kind] ?? t.foreground;
  }

  iconButton(id, icon, label, t, onClick, { active = false, title } = {}) {
    return h_flex().id(id).h(22).px(7).gap(5).flex_none().items_center().rounded(5).cursor_pointer().text_size(11)
      .text_color(active ? t.accent : t.muted).when(active, (e) => e.bg(tint(t.accent, "1f")))
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .when(Boolean(title), (e) => e.tooltip(title))
      .on_click(onClick)
      .child(svg(ICON(icon)).size(12).flex_none())
      .when(Boolean(label), (e) => e.child(label));
  }

  commentCard(item, t, index) {
    const c = item.comment, at = index === this.cursor && this.focusedHere && this.section === "diff";
    const editing = this.editing?.id === c.id, stale = item.outdated;
    const tone = stale ? t.blocked : t.accent;
    const caption = c.kind === "file" ? "Whole file" : stale ? `Outdated · ${R.linesLabel(c)} changed since` : `Comment · ${R.linesLabel(c)}`;
    const h = this.commentHeight(c, stale);
    return h_flex().id(`c-${c.id}`).w_full().h(h).flex_none().items_start().cursor_pointer().py(3)
      .child(this.marker(at, t))
      .child(div().w(stale || c.kind === "file" ? 10 : 76).flex_none())
      .child(v_flex().w(this.cardWidth()).h(h - 6).flex_none().px(10).py(6).gap(2).rounded(7).overflow_hidden().font_family(UI_FONT())
        .bg(t.surface).border_1().border_color(editing ? tone : tone + (at ? "aa" : "55"))
        .hover((s) => s.border_color(tone))
        .child(h_flex().h(14).gap(6).items_center().text_size(10.5).text_color(editing ? tone : t.dim)
          .child(svg(ICON("comment")).size(11).text_color(tone))
          .child(div().child(editing ? `${caption} · editing below` : caption))
          .when(stale, (e) => e.child(div().text_color(t.dim).child("· sent with the code you saw"))))
        .child(div().w_full().text_size(12).line_height("16px").text_color(t.foreground).whitespace_normal().child(c.text))
        .when(stale && c.lines?.length, (e) => e.child(div().text_size(10.5).text_color(t.dim).truncate()
          .font_family(CODE_FONT()).child(`was: ${c.lines.map((l) => l.text.trim()).join(" ⏎ ")}`))));
  }

  threadRow(item, t, index) {
    const th = item.thread, at = index === this.cursor && this.focusedHere && this.section === "diff";
    const first = th.comments[0], more = th.comments.length - 1;
    return h_flex().id(`th-${th.id}`).w_full().h(THREAD).flex_none().gap(8).items_center().cursor_pointer()
      .bg(tint(t.ansi4, "14")).hover((s) => s.bg(tint(t.ansi4, "26")))
      .child(this.marker(at, t))
      .child(div().w(76).flex_none())
      .child(svg(ICON("github")).size(12).flex_none().text_color(t.ansi4))
      .child(div().flex_none().text_size(11).font_medium().child(first?.author ?? ""))
      .child(div().max_w(this.cardWidth() - 160).truncate().text_size(11).text_color(t.muted).child((first?.body ?? "").split("\n")[0]))
      .when(more > 0, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).child(`+${more} ${more === 1 ? "reply" : "replies"}`)))
      .when(th.isResolved, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).child("resolved")))
      .when(this.isNew(th), (e) => e.child(div().flex_none().px(5).rounded(4).bg(t.accent).text_color(t.accent_foreground).text_size(9.5).child("new")));
  }

  diffRow(item, t, index) {
    if (item.comment) return this.commentCard(item, t, index);
    if (item.thread) return this.threadRow(item, t, index);
    const atCursor = index === this.cursor && this.focusedHere && this.section === "diff";
    const { row, ri } = item;
    if (row.kind === "more") {
      const label = row.at === "top" ? "Show lines above" : row.at === "bottom" ? "Show lines below" : "Show hidden lines";
      return h_flex().id(`m-${ri}`).w_full().h(MORE).flex_none().gap(8).items_center().cursor_pointer().bg(tint(t.raised, "88")).text_color(t.dim).text_size(10.5)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .child(this.marker(atCursor, t)).child(div().w(76).flex_none().text_right().child("⋯"))
        .child(svg(ICON("expand")).size(11)).child(`${label} (${STEP} more · e, or E for the whole file)`);
    }
    if (row.kind === "@") return h_flex().id(`h-${ri}`).w_full().h(ROW).flex_none().gap(9).items_center().bg(t.raised).text_color(t.dim).cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .child(this.marker(atCursor, t)).child(div().flex_1().min_w(0).truncate().child(row.text));
    if (!R.isCode(row)) return h_flex().id(`n-${ri}`).w_full().h(ROW).flex_none().items_center().px(14).text_color(t.dim).child(row.text);
    const sel = this.selection(), picked = sel && ri >= sel[0] && ri <= sel[1];
    const visual = this.vrow != null && picked;
    const covered = this.covered?.has(ri);
    const sign = row.kind === "+" ? t.ansi2 : row.kind === "-" ? t.ansi1 : t.dim;
    return h_flex().id(`r-${ri}`).w_full().h(ROW).flex_none().gap(8).cursor_pointer()
      .when(row.kind === "+", (e) => e.bg(tint(t.ansi2, "18"))).when(row.kind === "-", (e) => e.bg(tint(t.ansi1, "18")))
      .when(Boolean(picked), (e) => e.bg(t.accent + (visual ? "40" : "33")))
      .when(atCursor && !picked, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .child(this.marker(atCursor || picked || covered, t, atCursor ? t.accent : picked ? t.accent : tint(t.accent, "66")))
      .child(div().w(32).flex_none().text_right().text_color(picked ? t.foreground : t.dim).child(row.old == null ? "" : String(row.old)))
      .child(div().w(36).flex_none().text_right().text_color(picked ? t.foreground : t.dim).child(row.next == null ? "" : String(row.next)))
      .child(div().w(10).flex_none().text_color(sign).child(row.kind.trim()))
      .child(row.tokens
        ? h_flex().flex_1().min_w(0).overflow_hidden().children(row.tokens.map((tok) => div().flex_none().text_color(this.tokenColor(tok.kind, t)).child(tok.text)))
        : div().flex_1().min_w(0).truncate().child(row.text || " "));
  }

  // ---- regions -----------------------------------------------------------------------------------

  // The side column takes about a third of the pane until its splitter is dragged; the main panel the rest.
  leftWidth() {
    const auto = Math.max(240, Math.min(440, this.width * 0.32));
    return Math.round(Math.max(180, Math.min(this.width - 320, this.layout.left ?? auto)));
  }
  mainWidth() { return Math.max(300, this.width - this.leftWidth() - 14); }

  // A lazygit box: a border (accent while focused) with "[n] Title" set into its top edge. The edge is
  // drawn in pieces around the title, so nothing has to paint over it (the background can be see-through).
  panel(name, key, title, t, body, { grow = true, right = null } = {}) {
    const on = this.section === name, c = on ? t.accent : tint(t.dim, "99");
    const edge = () => div().flex_1().min_w(4).h(8).border_t(1).border_color(c);
    return v_flex().id(`panel-${name}`).min_h(0)
      .when(grow, (e) => e.flex_1().flex_grow(this.layout.weights[name] ?? 1)).when(!grow, (e) => e.flex_none())
      .on_size_change((size) => { this.heights[name] = size?.height ?? 0; })
      .on_mouse_down("left", (_e, cx) => { if (!this.typing && this.section !== name) this.focusPanel(name, cx); })
      .child(h_flex().h(14).flex_none().items_end()
        .child(div().w(8).h(8).flex_none().border_t(1).border_l(1).rounded_tl(5).border_color(c))
        .child(h_flex().h(14).flex_none().px(4).gap(5).items_center().text_size(11.5)
          .when(Boolean(key), (e) => e.child(div().text_color(on ? t.accent : t.dim).child(`[${key}]`)))
          .child(div().max_w(this.width * 0.4).truncate().font_medium().text_color(on ? t.accent : t.muted).child(title)))
        .child(edge())
        .when(Boolean(right), (e) => e.child(div().h(14).flex_shrink(1).min_w(0).max_w(320).px(4).text_size(11).text_color(t.dim).truncate().child(right)))
        .child(div().w(8).h(8).flex_none().border_t(1).border_r(1).rounded_tr(5).border_color(c)))
      .child(v_flex().flex_1().min_h(0).pt(2).pb(2).px(2).border_l(1).border_r(1).border_b(1).rounded_b(5).border_color(c).overflow_hidden().child(body));
  }

  // A splitter: drag it to resize. "col" sits between the side column and the main panel; "row" between two side panels.
  splitter(kind, t, a = null, b = null) {
    const id = kind === "col" ? "split-col" : `split-${a}-${b}`, active = this.drag?.id === id;
    return div().id(id).flex_none().when(kind === "col", (e) => e.w(6).h_full().cursor_col_resize()).when(kind === "row", (e) => e.h(5).w_full().cursor_row_resize())
      .child(div().when(kind === "col", (e) => e.w(2).h_full().mx(2)).when(kind === "row", (e) => e.h(2).w_full().my(1.5)).rounded(1)
        .when(active, (e) => e.bg(t.accent)))
      .hover((s) => s.bg(tint(t.accent, "33")))
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        const at = e?.position ?? { x: 0, y: 0 };
        if (kind === "col") this.drag = { id, kind, x: at.x, from: this.leftWidth() };
        else {
          // Shares become pixel heights while dragging, so the two panels trade exactly what the pointer moved.
          for (const [n, h] of Object.entries(this.heights)) if (n !== "scope" && h > 0) this.layout.weights[n] = h;
          this.drag = { id, kind, y: at.y, a, b, ha: this.heights[a] ?? 100, hb: this.heights[b] ?? 100 };
        }
        cx.notify();
      });
  }

  dragTo(e, cx) {
    const d = this.drag, at = e?.position;
    if (!d || !at) return;
    if (d.kind === "col") { this.layout.left = Math.round(d.from + at.x - d.x); this.layout.left = this.leftWidth(); }
    else {
      const total = d.ha + d.hb, ha = Math.max(60, Math.min(total - 60, d.ha + at.y - d.y));
      this.layout.weights[d.a] = ha; this.layout.weights[d.b] = total - ha;
    }
    cx.notify();
  }

  endDrag(cx) {
    if (!this.drag) return;
    this.drag = null; this.saveLayout(); cx.notify();
  }

  // The row look shared by the side panels: the picked row is `selected` in the focused panel, `raised` otherwise.
  listRow(id, picked, on, t) {
    return h_flex().id(id).h(LIST_ROW).flex_none().pr(8).gap(8).items_center().rounded(3).cursor_pointer()
      .when(picked, (e) => e.bg(on ? t.selected : t.raised)).hover((s) => s.bg(t.hover))
      .child(this.marker(picked && on, t));
  }

  note(text, t, color = t.dim) { return div().px(8).py(4).text_size(11.5).text_color(color).whitespace_normal().child(text); }

  scopePanel(t) {
    const on = this.section === "scope" && this.focusedHere;
    const names = { branch: `Branch vs ${this.base ?? "base"}`, last: "Last commit", uncommitted: "Uncommitted" };
    const keys = { branch: "b", last: "", uncommitted: "u" };
    const body = v_flex().px(2)
      .child(h_flex().h(LIST_ROW).px(8).gap(6).items_center().text_color(t.muted).text_size(11.5)
        .child(svg(ICON("git-branch")).size(12).flex_none())
        .child(div().min_w(0).truncate().child(this.branch ? `${this.root?.split("/").pop()} · ${this.branch} → ${this.base ?? "?"}` : this.loading ? "Loading…" : "")))
      .children(this.scopeItems().map((s) => {
        const picked = s.kind === this.scope.kind;
        const text = s.kind === "commits" ? (s.shas.length === 1 ? "1 commit" : `${s.shas.length} commits`) : names[s.kind];
        return this.listRow(`scope-${s.kind}`, picked, on, t)
          .on_click((_e, cx) => { this.section = "scope"; if (!picked) this.setScope(s.kind === "commits" ? s : { kind: s.kind }, cx); cx.notify(); })
          .child(div().flex_1().min_w(0).truncate().child(text))
          .when(s.kind === "last" && Boolean(this.last), (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).font_family(CODE_FONT()).child(this.last.short)))
          .when(s.kind === "commits", (e) => e.child(div().id("scope-commits-x").flex_none().px(4).rounded(3).text_color(t.dim).hover((x) => x.text_color(t.foreground))
            .tooltip("Back to the branch").on_click((_e, cx) => this.setScope({ kind: "branch" }, cx)).child("×")))
          .when(Boolean(keys[s.kind]), (e) => e.child(div().flex_none().text_size(10).text_color(t.dim).child(keys[s.kind])));
      }));
    return this.panel("scope", "1", "Scope", t, body, { grow: false });
  }

  filesPanel(t) {
    const label = this.label(), on = this.section === "files" && this.focusedHere;
    const perFile = new Map();
    for (const c of this.comments) if (c.label === label) perFile.set(c.path, (perFile.get(c.path) ?? 0) + 1);
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const body = v_flex().flex_1().min_h(0)
      .when(this.files.length > 0, (e) => e.child(div().flex_1().min_h(0).relative()
        .child(v_virtual_list("br-files", this.files.length, LIST_ROW, (i) => this.files[i].path, (range) => this.files.slice(range.start, range.end).map((f) => {
          const n = perFile.get(f.path) ?? 0;
          const [dir, name] = split(f.path);
          return this.listRow(`file-${f.path}`, this.open === f.path, on, t)
            .child(div().w(12).flex_none().text_size(10.5).font_semibold().text_color(t[STATUS[f.status]] ?? t.dim).child(f.status))
            .child(h_flex().flex_1().min_w(0).overflow_hidden()
              .child(div().flex_shrink(1).min_w(0).truncate().text_color(t.dim).child(dir))
              .child(div().flex_none().child(name)))
            .when(n > 0, (e) => e.child(h_flex().flex_none().h(16).px(5).gap(3).items_center().rounded(4).bg(tint(t.accent, "33")).text_color(t.accent).text_size(10)
              .child(svg(ICON("comment")).size(10)).child(String(n))))
            .when(f.binary, (e) => e.child(div().text_size(10.5).text_color(t.dim).child("binary")))
            .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
            .when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
        })).track_scroll(this.fileScroll).on_item_click((path, cx) => { this.section = "files"; this.side = "files"; this.pickFile(path, cx); cx.notify(); }).size_full())
        .child(Scrollbar.vertical("br-files").viewport_from_layout().absolute().inset_0())))
      .when(this.untrackedCut > 0, (e) => e.child(div().flex_none().px(8).py(2).text_size(10.5).text_color(t.dim).child(`${this.untrackedCut} more untracked files not listed`)))
      .when(!this.files.length, (e) => e.child(this.note(this.loading ? "Loading files…" : "No changes in this scope. [ and ] change it.", t)));
    const right = this.files.length ? `${this.files.length} · +${add} −${del}` : null;
    return this.panel("files", "2", "Files", t, body, { right });
  }

  commitsPanel(t) {
    const shas = this.scope.kind === "commits" ? this.scope.shas : [];
    const on = this.section === "commits" && this.focusedHere;
    const body = v_flex().flex_1().min_h(0)
      .when(this.commits.length > 0, (e) => e.child(div().flex_1().min_h(0).relative()
        .child(v_virtual_list("br-commits", this.commits.length, LIST_ROW, (i) => this.commits[i].sha, (range) => this.commits.slice(range.start, range.end).map((c, j) => {
          const i = range.start + j;
          const picking = this.visual != null && i >= Math.min(this.visual, this.commitCursor) && i <= Math.max(this.visual, this.commitCursor);
          return this.listRow(`commit-${c.sha}`, i === this.commitCursor && on, on, t)
            .when(shas.includes(c.sha) && !(i === this.commitCursor && on), (e) => e.bg(tint(t.accent, "26")))
            .when(picking, (e) => e.bg(tint(t.accent, "33")))
            .child(div().w(56).flex_none().text_color(shas.includes(c.sha) ? t.accent : t.ansi3).font_family(CODE_FONT()).text_size(11).child(c.short))
            .child(div().flex_1().min_w(0).truncate().child(c.subject))
            .child(div().flex_none().text_size(10.5).text_color(t.dim).child(c.when));
        })).track_scroll(this.commitScroll).on_item_click((sha, cx) => {
          this.section = "commits"; this.side = "commits"; this.commitCursor = Math.max(0, this.commits.findIndex((c) => c.sha === sha));
          this.clickCommit(sha, { modifiers: { shift: this.shiftDown } }, cx);
        }).size_full())
        .child(Scrollbar.vertical("br-commits").viewport_from_layout().absolute().inset_0())))
      .when(!this.commits.length, (e) => e.child(this.note(this.loading && !this.root ? "Loading commits…" : `No commits on ${this.branch ?? "this branch"} since it left ${this.base ?? "its base"}`, t)));
    return this.panel("commits", "3", "Commits", t, body, { right: this.commits.length ? String(this.commits.length) : null });
  }

  githubPanel(t) {
    const list = this.shownThreads(), on = this.section === "github" && this.focusedHere;
    const open = this.threads.filter((x) => !x.isResolved).length, fresh = this.threads.filter((x) => !x.isResolved && this.isNew(x)).length;
    let body;
    if (this.gh === "error") body = this.note(this.ghError ?? "Couldn't read GitHub", t, t.blocked);
    else if (this.gh === "none") body = this.note(`No pull request for ${this.branch}. Open one, then press r.`, t);
    else if (!this.pr || (this.gh === "loading" && !this.threads.length)) body = this.note("Reading review threads…", t);
    else if (!list.length) body = this.note(this.threads.length ? "Every thread is resolved. H shows them." : "No review threads on this pull request yet.", t);
    else body = div().flex_1().min_h(0).relative()
      .child(v_virtual_list("br-gh", list.length, GH_ROW, (i) => list[i].id, (range) => list.slice(range.start, range.end).map((x, j) => {
        const i = range.start + j, first = x.comments[0];
        return h_flex().id(`gh-${x.id}`).h(GH_ROW).flex_none().pr(8).gap(8).items_center().rounded(3).cursor_pointer()
          .when(i === this.ghCursor, (e) => e.bg(on ? t.selected : t.raised)).hover((s) => s.bg(t.hover))
          .child(this.marker(i === this.ghCursor && on, t))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(h_flex().gap(6).items_center().text_size(11.5)
              .child(div().min_w(0).truncate().text_color(t.accent).child(`${x.path}${x.line ? `:${x.line}` : ""}`))
              .when(x.isOutdated, (e) => e.child(div().flex_none().text_size(10).text_color(t.blocked).child("outdated")))
              .when(x.isResolved, (e) => e.child(div().flex_none().text_size(10).text_color(t.dim).child("resolved")))
              .when(this.queued(x), (e) => e.child(div().flex_none().text_size(10).text_color(t.ansi2).child("in review")))
              .when(this.isNew(x), (e) => e.child(div().flex_none().px(4).rounded(3).bg(t.accent).text_color(t.accent_foreground).text_size(9.5).child("new"))))
            .child(h_flex().gap(6).text_size(11)
              .child(div().flex_none().font_medium().child(first?.author ?? ""))
              .child(div().min_w(0).truncate().text_color(t.muted).child((first?.body ?? "").replace(/\s+/g, " ")))))
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`${x.comments.length} · ${ago(x.comments[x.comments.length - 1]?.at)}`));
      })).track_scroll(this.ghScroll).on_item_click((id, cx) => {
        const i = list.findIndex((x) => x.id === id);
        this.ghCursor = i; this.section = "github"; this.side = "github"; this.markSeen(list[i]); cx.notify();
      }).size_full())
      .child(Scrollbar.vertical("br-gh").viewport_from_layout().absolute().inset_0());
    const title = this.pr ? `GitHub #${this.pr.number}` : "GitHub";
    const right = [open && `${open} open`, fresh && `${fresh} new`].filter(Boolean).join(" · ") || null;
    return this.panel("github", "4", title, t, body, { right });
  }

  // The main panel: the picked file's diff, or the picked GitHub thread.
  mainPanel(t, rows) {
    if (this.view === "github") {
      const th = this.shownThreads()[this.ghCursor];
      const resolved = this.threads.filter((x) => x.isResolved).length;
      const right = this.pr ? `${this.threads.length - resolved} open${resolved ? ` · ${resolved} resolved${this.showResolved ? " (shown)" : ""}` : ""}` : null;
      const body = th ? this.threadDetail(th, t) : this.note(this.pr ? "Pick a thread in the GitHub panel." : "", t);
      return this.panel("diff", "0", this.pr ? `#${this.pr.number} ${this.pr.title}` : "GitHub", t, body, { right });
    }
    const f = this.file(), n = f ? this.contextFor(f.path) : CONTEXT;
    const right = f ? [f.untracked && "new, untracked", n >= FULL ? "whole file" : n > CONTEXT && `context ${n}`, this.label()].filter(Boolean).join(" · ") : null;
    const body = v_flex().flex_1().min_h(0).child(this.diff(t, rows)).child(this.composer(t));
    return this.panel("diff", "0", f ? f.path : "Diff", t, body, { right });
  }

  diff(t, rows) {
    return div().id("br-diff-wrap").flex_1().min_h(0).relative().font_family(CODE_FONT()).text_size(11)
      .child(div().id("br-diff-x").size_full().overflow_x_scrollbar()
        .child(div().w_full().min_w(this.diffWidth ?? 300).h_full().child(v_virtual_list("br-diff", rows.length, rows.map((r) => this.itemSize(r)), (i) => String(i),
          (range) => rows.slice(range.start, range.end).map((item, i) => this.diffRow(item, t, range.start + i)))
          .track_scroll(this.scroll).on_item_click((key, cx) => this.clickRow(key, cx))
          .on_item_secondary_click((key, _e, cx) => this.secondaryRow(key, cx)).size_full())))
      .child(Scrollbar.vertical("br-diff").viewport_from_layout().absolute().inset_0())
      .when(!rows.length && Boolean(this.open), (e) => e.child(div().absolute().inset_0().flex().items_center().justify_center().text_color(t.dim).text_size(12).child("Loading diff…")))
      .when(!this.open && !this.loading, (e) => e.child(div().absolute().inset_0().flex().items_center().justify_center().text_color(t.dim).text_size(12)
        .child(this.root ? "Nothing to review here. [ and ] change the scope." : "")));
  }

  // The comment box, at the foot of the main panel while composing.
  composer(t) {
    const ed = this.editing;
    if (!ed) return div();
    const c = ed.kind === "file" ? { kind: "file" } : ed.a != null && !ed.lost
      ? R.rangeComment(this.rows, ed.a, ed.b, { path: ed.path, label: ed.label, text: "" }) : null;
    const where = ed.kind === "file" ? "whole file" : c ? R.linesLabel(c) : ed.outdated ? "outdated lines" : "lines";
    return v_flex().flex_none().px(10).pt(8).pb(6).gap(6).border_t(1).border_color(t.border).bg(t.surface)
      .child(h_flex().gap(6).items_center().text_size(11)
        .child(svg(ICON("comment")).size(12).text_color(t.accent))
        .child(div().font_medium().child(ed.id ? "Edit comment" : "New comment"))
        .child(div().min_w(0).truncate().text_color(t.muted).child(`${split(ed.path)[1]} · ${where}`))
        .when(Boolean(ed.lost), (e) => e.child(div().text_color(t.blocked).child("· those lines changed: click a line to pick again"))))
      .child(div().id("br-comment").on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(this.input).w_full().px(10).py(7).rounded(6).border_1().border_color(this.typing === "comment" ? t.accent : t.input).bg(t.background).text_size(12.5)))
      .child(h_flex().gap(6).items_center()
        .child(h_flex().id("br-save").h(24).px(12).items_center().rounded(5).cursor_pointer().bg(t.solid).text_color(t.solid_foreground).text_size(12).font_medium()
          .hover((s) => s.opacity(0.88)).on_click((_e, cx) => this.saveComment(cx)).child(ed.id ? "Save" : "Add comment"))
        .child(h_flex().id("br-cancel").h(24).px(10).items_center().rounded(5).cursor_pointer().text_size(12).text_color(t.muted)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.cancelComment(cx)).child("Cancel"))
        .child(div().flex_1())
        .when(Boolean(ed.id), (e) => e.child(h_flex().id("br-delete").h(24).px(10).items_center().rounded(5).cursor_pointer().text_size(12).text_color(t.ansi1)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.deleteComment(ed.id, cx)).child("Delete"))));
  }

  // The hints for what the keyboard does right now, as lazygit's options bar shows them.
  hints() {
    if (this.typing === "comment") return [["enter", "save"], ["shift-enter", "new line"], ["esc", "cancel"]];
    if (this.typing === "reply") return [["cmd-enter", "post to GitHub"], ["esc", "cancel"]];
    if (this.vrow != null) return [["j k", "stretch"], ["c", "comment"], ["a", "ask"], ["esc", "cancel"]];
    if (this.visual != null) return [["j k", "stretch"], ["enter", "show those commits"], ["esc", "cancel"]];
    const own = PANEL_KEYS[this.onThreads() ? "github" : this.section] ?? [];
    return [...own.slice(0, 5), ["s", "send"], ["?", "keys"]];
  }

  bottomBar(t) {
    const list = this.agentsList(), a = list[0], n = this.comments.length, label = this.label();
    const elsewhere = this.comments.filter((c) => c.kind !== "github" && c.label !== label).length;
    const queued = this.comments.filter((c) => c.kind === "github").length;
    const can = Boolean(n && !this.preparing);
    const extra = [elsewhere && `${elsewhere} from other views`, queued && `${queued} GitHub`].filter(Boolean).join(" · ");
    return h_flex().flex_none().h(30).px(10).gap(10).items_center().text_size(11)
      .child(h_flex().flex_1().min_w(0).gap(12).overflow_hidden()
        .children(this.hints().map(([k, d]) => h_flex().flex_none().gap(4).child(div().text_color(t.accent).child(k)).child(div().text_color(t.dim).child(d)))))
      .when(Boolean(extra), (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).child(extra)))
      .child(a
        ? h_flex().id("br-target").h(22).px(8).gap(6).flex_none().max_w(260).items_center().rounded(4).bg(t.raised).cursor_pointer().hover((s) => s.bg(t.hover))
          .tooltip(list.length > 1 ? "Next agent (t) · the send dialog lists every agent" : "The send dialog lists every agent")
          .on_click((_e, cx) => this.nextTarget(cx))
          .child(div().size(7).flex_none().rounded(4).bg(t[a.status] ?? t.unknown))
          .child(div().flex_none().font_medium().child(a.program?.name ?? a.app ?? a.address))
          .child(div().min_w(0).truncate().text_color(t.dim).child(`${a.space_name} / ${a.tab_name} · ${a.status}`))
        : div().flex_none().text_color(t.dim).child("No agent running"))
      .child(h_flex().id("br-send").h(22).px(10).gap(6).flex_none().items_center().rounded(4).font_medium()
        .bg(can ? t.solid : t.raised).text_color(can ? t.solid_foreground : t.dim)
        .when(can, (e) => e.cursor_pointer().hover((s) => s.opacity(0.88)))
        .tooltip("Review what's sent, then send (s)")
        .on_click((_e, cx) => this.send(cx))
        .child(svg(ICON("send")).size(11))
        .child(this.preparing ? "Checking…" : n ? `Send review · ${n}` : "Send review"));
  }

  // ?: the focused panel's keys and the global ones, in a box over the pane.
  helpPopup(t) {
    const name = this.onThreads() ? "github" : this.section;
    const title = name === "diff" ? "Main panel" : PANELS.find(([p]) => p === name)?.[2] ?? "Keys";
    const group = (heading, keys) => v_flex().flex_1().min_w(0).gap(4)
      .child(div().text_size(10.5).font_semibold().text_color(t.dim).child(heading.toUpperCase()))
      .children(keys.map(([k, d]) => h_flex().gap(10).items_center()
        .child(div().w(96).flex_none().text_color(t.accent).font_family(CODE_FONT()).text_size(11).child(k))
        .child(div().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(d))));
    return div().id("br-help").absolute().inset_0().flex().items_center().justify_center().bg(tint(t.background, "aa"))
      .on_mouse_down("left", (_e, cx) => { this.showHelp = false; cx.stop_propagation(); cx.notify(); })
      .child(v_flex().w(Math.min(640, this.width - 40)).p(14).gap(12).rounded(6).bg(t.surface).border_1().border_color(t.accent)
        .child(h_flex().items_center().child(div().font_semibold().text_size(12.5).child(`Keys · ${title}`)).child(div().flex_1()).child(div().text_size(10.5).text_color(t.dim).child("esc or ? closes")))
        .child(h_flex().gap(24).items_start().child(group(title, PANEL_KEYS[name] ?? [])).child(group("Everywhere", GLOBAL_KEYS))));
  }

  threadDetail(th, t) {
    const queued = this.queued(th), replying = this.replying?.id === th.id;
    const action = (id, icon, label, onClick, active, title) => this.iconButton(id, icon, label, t, onClick, { active, title });
    return v_flex().id(`ghd-${th.id}`).flex_1().min_h(0)
      .child(h_flex().flex_none().px(8).pb(6).gap(4).items_center().border_b(1).border_color(t.border)
        .child(div().min_w(0).truncate().text_color(t.accent).text_size(11.5).child(`${th.path}${th.line ? `:${th.line}` : ""}`))
        .child(div().flex_1())
        .child(action("gh-fix", "send", "Fix", (_e, cx) => this.fixThread(th, cx), false, "Send this thread to the agent (f)"))
        .child(action("gh-queue", queued ? "check" : "comment", queued ? "In review" : "Add to review", (_e, cx) => this.toggleQueued(th, cx), queued, "Send it with your review comments (i)"))
        .child(action("gh-reply", "comment", "Reply", (_e, cx) => this.startReply(th, cx), replying, "Reply on GitHub (R)"))
        .child(action("gh-show", "chevron-right", "Show in diff", (_e, cx) => this.jumpToThread(th, cx), false, "Enter"))
        .when(Boolean(th.url), (e) => e.child(action("gh-browser", "github", "Open", () => exec("open", [th.url]), false, "o"))))
      .child(v_flex().id("gh-comments").flex_1().min_h(0).overflow_y_scrollbar().px(14).py(10).gap(12)
        .children(th.comments.map((m, i) => v_flex().gap(4)
          .child(h_flex().gap(6).items_center().text_size(11.5)
            .child(div().font_semibold().child(m.author))
            .child(div().text_color(t.dim).text_size(10.5).child(ago(m.at))))
          .child(TextView.markdown(`gh-${th.id}-${i}`, m.body).selectable(true).text_size(12).text_color(t.foreground)))))
      .when(replying, (e) => e.child(v_flex().flex_none().px(10).pt(8).pb(8).gap(6).border_t(1).border_color(t.border).bg(t.surface)
        .child(h_flex().gap(6).items_center().text_size(11)
          .child(svg(ICON("github")).size(12)).child(div().font_medium().child("Reply on GitHub"))
          .child(div().text_color(t.dim).child("· posts publicly as your gh account")))
        .child(div().id("gh-reply-box").on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Textarea.new(this.replyInput).w_full().px(10).py(7).rounded(6).border_1().border_color(this.typing === "reply" ? t.accent : t.input).bg(t.background).text_size(12.5)))
        .when(Boolean(this.replyError), (e) => e.child(div().text_size(11.5).text_color(t.ansi1).whitespace_normal().child(this.replyError)))
        .child(h_flex().gap(6).items_center()
          .child(h_flex().id("gh-post").h(24).px(12).items_center().rounded(5).text_size(12).font_medium()
            .bg(this.posting ? t.raised : t.solid).text_color(this.posting ? t.dim : t.solid_foreground)
            .when(!this.posting, (e) => e.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => this.postReply(cx)))
            .child(this.posting ? "Posting…" : "Post to GitHub"))
          .child(h_flex().id("gh-cancel").h(24).px(10).items_center().rounded(5).cursor_pointer().text_size(12).text_color(t.muted)
            .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.cancelReply(cx)).child("Cancel")))));
  }

  render(cx) {
    if (this.dialog) return this.dialog.render(cx);
    this.checkSent();
    const t = theme();
    this.focusedHere = !this.typing;
    const rows = (this.display = this.displayRows());
    if (this.cursor >= rows.length) this.cursor = Math.max(0, rows.length - 1);

    return v_flex().id("branch-review").relative().size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12).track_focus(this.handle)
      .on_size_change((size, cx) => { if (Math.abs((size?.width ?? 0) - this.width) > 4) { this.width = size.width; cx.notify(); } })
      .on_key_down((e, cx) => this.onKey(e, cx))
      // List rows report clicks without modifiers, so shift is read from the press.
      .on_mouse_down("left", (e) => { this.shiftDown = Boolean(e?.modifiers?.shift); if (!this.typing) this.handle.focus(); })
      // A splitter drag follows the pointer anywhere over the pane and ends on release or on leaving it.
      .on_mouse_move((e, cx) => this.dragTo(e, cx))
      .on_mouse_up("left", (_e, cx) => this.endDrag(cx))
      .on_hover((hovered, cx) => { if (!hovered) this.endDrag(cx); })
      .when(Boolean(this.error), (e) => e.child(h_flex().flex_none().px(12).py(5).gap(8).items_center().bg(tint(t.ansi1, "18")).border_b(1).border_color(t.border)
        .child(div().flex_1().text_size(11.5).text_color(t.ansi1).whitespace_normal().child(this.error))
        .child(this.iconButton("err-x", "x", null, t, (_e, cx) => { this.error = null; cx.notify(); }))))
      .child(h_flex().flex_1().min_h(0).px(4).pt(2).items_stretch()
        .child(v_flex().w(this.leftWidth()).flex_none().min_h(0)
          .child(this.scopePanel(t))
          .child(div().h(3).flex_none())
          .child(this.filesPanel(t))
          .child(this.splitter("row", t, "files", "commits"))
          .child(this.commitsPanel(t))
          .when(this.hasGithub(), (e) => e.child(this.splitter("row", t, "commits", "github")).child(this.githubPanel(t))))
        .child(this.splitter("col", t))
        .child(v_flex().flex_1().min_w(0).min_h(0).child(this.mainPanel(t, rows))))
      .child(this.bottomBar(t))
      .when(Boolean(this.showHelp), (e) => e.child(this.helpPopup(t)));
  }
}
