import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { aiCommitMessage, aiResolveConflict, abortOp, applyLines, commit, discard, editors, fetchAll, fileDiff, headMessage, ignore, openFile, opLog, push, repoStatus, resolve, stage, stashSave, unstage, workFile, writeResolved } from "../../lib/ipc";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Side } from "../../bindings/Side";
import type { FileChange } from "../../bindings/FileChange";
import type { AppError } from "../../bindings/AppError";
import type { LineOp } from "../../bindings/LineOp";
import type { OpEntry } from "../../bindings/OpEntry";
import { Icon, type IconName } from "../../lib/icons";
import { FileIcon } from "../../lib/fileIcon";
import { Splitter } from "../../lib/splitter";
import { DiffLine, useLang } from "../../lib/highlight";
import { Lines, widest } from "../../lib/Lines";
import { ModalHead, choose, confirm } from "../../lib/modal";
import { aiKeyQuery, openSettings } from "../settings/Settings";
import { lfsPatternFor, openLfs } from "../lfs/Lfs";
import { RefMenu, menuKeys, showMenu } from "../refs/Sidebar";
import { openFileHistory } from "../graph/FileHistory";
import { openStashSave } from "../refs/Stash";

export const statusQuery = (path: string) => ({ queryKey: ["status", path], queryFn: () => repoStatus(path) });
export const opLogQuery = (path: string) => ({ queryKey: ["oplog", path], queryFn: () => opLog(path) });

type Selection = { file: string; staged: boolean };
/** `done`: the success notice, or a function called after success (undefined = no notice).
 *  `doing`: shown in the notice while the op runs ("Pushing main…"). */
export type Run = (op: () => Promise<unknown>, done?: string | (() => string | undefined), doing?: string) => Promise<boolean>;

export const errorText = (e: unknown) => (e as AppError).message ?? String(e);
// A staged rename also needs its old path to be unstaged.
export const pathsOf = (files: FileChange[]) => files.flatMap((f) => (f.orig_path ? [f.path, f.orig_path] : [f.path]));
const confirmDiscard = (what: string) =>
  confirm("Discard changes", `Discard changes to ${what}? A backup is kept, use Undo history to restore it.`, "Discard", "danger");

/** `run(op)` runs a git op, refreshes right away (the watcher would too, 300 ms later).
 * A failure shows in `OpErrorDialog` until OK. */
let opGen = 0;
let opError: { title: string; text: string; warn?: boolean; code?: string; retry?: (extra?: string) => void } | null = null;
const opSubs = new Set<() => void>();
const subscribeOps = (f: () => void) => { opSubs.add(f); return () => { opSubs.delete(f); }; };

// `run(op, done, doing)`: `doing` shows in `Notice` while the op runs, then `done` ("Pushed main") for a few seconds.
// `pending`: when the op started. `waited`: this success follows a pending notice.
let notice: { text: string; gen: number; pending?: number; waited?: boolean } | null = null;

/** True while an op started with a `doing` label runs (Commit, Fetch, Pull, Push): the repo window locks. */
export const useOpBusy = () => useSyncExternalStore(subscribeOps, () => !!notice?.pending);

export function useRun() {
  const qc = useQueryClient();
  async function run(op: () => Promise<unknown>, done?: string | (() => string | undefined), doing?: string) {
    const mine = ++opGen;
    notice = doing ? { text: doing, gen: mine, pending: Date.now() } : null;
    opSubs.forEach((f) => f());
    try {
      await op();
      const text = typeof done === "function" ? done() : done;
      if (mine === opGen) {
        notice = text ? { text, gen: mine, waited: !!doing } : null;
        opSubs.forEach((f) => f());
      }
      return true;
    } catch (e) {
      if (mine === opGen) notice = null;
      // "conflicts" = the op paused halfway (still in progress), not a failure.
      const code = (e as AppError).code;
      opError = code === "conflicts"
        ? { title: "Paused: resolve the conflicts", text: errorText(e), warn: true }
        : { title: code === "clash" ? "Nothing was switched" : (e as { title?: string }).title ?? "Something went wrong", text: errorText(e), code,
            // `extra` is appended to the success notice ("… Your changes are in the stash.").
            retry: (extra?: string) => { run(op, extra ? () => `${(typeof done === "function" ? done() : done) ?? "Done"}. ${extra}` : done, doing); } };
      opSubs.forEach((f) => f());
      return false;
    } finally {
      qc.invalidateQueries();
    }
  }
  return run;
}

/** One-click fixes the error dialog offers, by error code: [button label, action]. */
const FIXES: Record<string, (path: string, run: Run, retry: (extra?: string) => void) => [string, () => void][]> = {
  dirty: (p, run, retry) => [["Stash changes and retry", async () => {
    if (await run(() => stashSave(p, "Stashed by git-ai to retry"))) retry("Your changes are in the stash: apply it to get them back");
  }]],
  network: (_p, _run, retry) => [["Try again", () => retry()]],
  stale_remote: (p, run) => [["Fetch now", () => run(() => fetchAll(p), "Fetched. Check the graph, then push again")]],
  no_upstream: (p, run) => [["Push this branch", () => run(() => push(p), "Pushed")]],
  lfs_missing: () => [["Get Git LFS", () => openUrl("https://git-lfs.com")]],
  git_missing: () => [["Get Git", () => openUrl("https://git-scm.com/downloads")]],
};

/** Modal for the last failed op, with a fix button when one is known; OK (or Esc) dismisses it. */
export function OpErrorDialog({ path }: { path: string }) {
  const err = useSyncExternalStore(subscribeOps, () => opError);
  const run = useRun();
  const dialog = useRef<HTMLDialogElement>(null);
  // Keep the last text through the close transition so the dialog doesn't empty while fading.
  const last = useRef(err);
  if (err) last.current = err;
  useEffect(() => {
    if (err) dialog.current?.showModal();
    else dialog.current?.close();
  }, [err]);
  const close = () => { opError = null; opSubs.forEach((f) => f()); };
  const e = last.current;
  const fixes = (e?.code && e.retry && FIXES[e.code]?.(path, run, e.retry)) || [];
  return (
    <dialog ref={dialog} className={`modal alert tone-${last.current?.warn ? "warn" : "danger"}`} role="alertdialog" aria-labelledby="op-error-title" aria-describedby="op-error-text"
      onCancel={(e) => { e.preventDefault(); close(); }}>
      <form method="dialog" onSubmit={(e) => { e.preventDefault(); close(); }}>
        <ModalHead id="op-error-title" icon="warn" tone={last.current?.warn ? "warn" : "danger"} title={last.current?.title} />
        <p id="op-error-text" className="modal-text">{last.current?.text}</p>
        <div className="dialog-actions">
          {fixes.map(([label, fix]) => <button key={label} type="button" className="primary" onClick={() => { close(); fix(); }}>{label}</button>)}
          <button className={fixes.length ? undefined : "primary"} autoFocus>{fixes.length ? "Close" : "OK"}</button>
        </div>
      </form>
    </dialog>
  );
}

/** The running op ("Pushing main…", with elapsed seconds), then its short success line, which fades out after 4 s.
 *  A running op shows only after 250 ms, so quick ones (stage, commit) don't flash it. */
export function Notice() {
  // The snapshot must be `notice` itself: a success changes it but not `opGen`.
  const shown = useSyncExternalStore(subscribeOps, () => notice);
  const [now, setNow] = useState(Date.now);
  // Ticks while an op runs: reveals it at 250 ms, then counts seconds.
  useEffect(() => {
    if (!shown?.pending) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [shown]);
  const cur = shown && (!shown.pending || now - shown.pending >= 250) ? shown : null;
  const ref = useRef<HTMLParagraphElement>(null);
  const visible = !!cur;
  useEffect(() => {
    if (!visible) return;
    // A popover shown after an open <dialog> stacks above it (and its backdrop blur) in the top layer.
    const p = ref.current;
    p?.hidePopover();
    p?.showPopover();
    return () => p?.hidePopover();
  }, [visible, cur?.gen]);
  useEffect(() => {
    if (!cur || cur.pending) return;
    // Clears the shared notice, not local state: Notice remounts on a repo switch and would show it again.
    const t = setTimeout(() => {
      if (notice?.gen !== cur.gen) return;
      notice = null;
      opSubs.forEach((f) => f());
    }, 4000);
    return () => clearTimeout(t);
  }, [cur]);
  const secs = cur?.pending ? Math.floor((now - cur.pending) / 1000) : 0;
  return (
    <p ref={ref} popover="manual" className="notice" role="status">
      {cur && (cur.pending
        ? <span key={cur.gen} className="toast tone-accent pending">
            <span className="modal-badge tone-accent"><span className="ring" aria-hidden="true" /></span>
            {cur.text}{secs >= 2 && <span className="elapsed" aria-hidden="true">{secs}s</span>}
          </span>
        : <span key={`${cur.gen}-done`} className={`toast tone-ok${cur.waited ? " settled" : ""}`}>
            <span className="modal-badge tone-ok"><Icon name="check" /></span>{cur.text}
          </span>)}
    </p>
  );
}

export function Changes({ path, push }: { path: string; push: () => Promise<unknown> }) {
  const { data, error } = useQuery(statusQuery(path));
  const [sel, setSel] = useState<Selection | null>(null);
  const run = useRun();
  // Files that were in conflict during the current merge/rebase, so a resolved one keeps its view.
  const hadConflict = useRef(new Set<string>());

  async function discardFiles(files: FileChange[]) {
    if (await confirmDiscard(files.length === 1 ? files[0].path : `${files.length} files`)) run(() => discard(path, pathsOf(files)));
  }

  if (error) return <p className="error" role="alert">{errorText(error)}</p>;
  if (!data) return null;
  const empty = !data.staged.length && !data.unstaged.length && !data.conflicted.length;
  if (!data.operation) hadConflict.current.clear();
  for (const f of data.conflicted) hadConflict.current.add(f.path);
  // Follow the file when it moves to the other list (staged, unstaged, resolved); drop it once it's gone.
  const inList = (file: string, staged: boolean) => (staged ? data.staged : [...data.unstaged, ...data.conflicted]).some((f) => f.path === file);
  const cur = sel && (inList(sel.file, sel.staged) ? sel : inList(sel.file, !sel.staged) ? { file: sel.file, staged: !sel.staged } : null);
  const conflicted = !!cur && !cur.staged && data.conflicted.some((f) => f.path === cur.file);
  const resolved = !!cur && cur.staged && hadConflict.current.has(cur.file);

  const list = { sel: cur, onSelect: setSel };
  async function ignoreFile(file: string) {
    const pats = ignorePatterns(file);
    const i = await choose("Ignore", `Git stops listing matching untracked files. The pattern goes into .gitignore, which you commit like any file.`,
      pats.map(([pattern, hint]) => ({ label: pattern, hint })), "changes");
    if (i >= 0) run(() => ignore(path, pats[i][0]), `Added ${pats[i][0]} to .gitignore`);
  }
  return (
    <div className="changes">
      <div className="side">
        {data.operation && (
          <div className="banner" role="status">
            <Icon name="warn" />
            <span>
              <strong>{cap(data.operation)} in progress</strong>{data.step && <>, {data.step}</>}.{" "}
              {data.conflicted.length
                ? `Resolve ${data.conflicted.length === 1 ? "the conflict" : `${data.conflicted.length} conflicts`}, then ${finishLabel(data.operation)}.`
                : `${finishLabel(data.operation)[0].toUpperCase() + finishLabel(data.operation).slice(1)} below.`}
            </span>
            <button className="small" onClick={async () => {
              if (await confirm(`Abort the ${data.operation}?`, "Changed files are backed up first (Undo history).", "Abort"))
                run(() => abortOp(path));
            }}>Abort</button>
          </div>
        )}
        <div className="lists">
        {empty ? (
          <p className="empty"><Icon name="check" />No changes</p>
        ) : (
          <>
            <FileList {...list} title="Conflicts" files={data.conflicted} staged={false}
              action="Mark resolved" onAction={(fs) => run(() => stage(path, pathsOf(fs)))} />
            <FileList {...list} title="Staged" files={data.staged} staged
              action="Unstage" onAction={(fs) => run(() => unstage(path, pathsOf(fs)))} />
            <FileList {...list} title="Changes" files={data.unstaged} staged={false}
              action="Stage" onAction={(fs) => run(() => stage(path, pathsOf(fs)))} onDiscard={discardFiles} onIgnore={ignoreFile} />
          </>
        )}
        </div>
        <CommitBox path={path} branch={data.branch} staged={data.staged.length} finishing={data.operation} conflicts={data.conflicted.length} run={run} push={push}
          onCommit={(msg, amend) => {
            // Committing during a merge/rebase may finish it; say so once nothing is left in progress.
            const op = amend ? null : data.operation;
            let finished = false;
            let note: string | null = null;
            const subject = msg.split("\n")[0].trim();
            return run(async () => {
              note = await commit(path, msg, amend);
              finished = !!op && !(await repoStatus(path)).operation;
            }, () => [note ?? (amend ? "Amended the last commit" : subject ? `Committed “${subject.length > 48 ? subject.slice(0, 47) + "…" : subject}”` : "Committed"),
              finished && `${cap(op!)} finished`].filter(Boolean).join(". "),
            amend ? "Amending…" : op ? `Finishing the ${op}…` : "Committing…");
          }} />
      </div>
      <Splitter name="side-w" axis="x" label="Resize file list" />
      {conflicted || resolved ? <Conflict key={cur.file} path={path} file={cur.file} op={data.operation} resolved={resolved} run={run} />
        : empty && !data.operation ? <Clean branch={data.branch} />
        : <Diff path={path} sel={cur} kind={cur?.file && (cur.staged ? data.staged : data.unstaged).find((f) => f.path === cur.file)?.kind} run={run} />}
    </div>
  );
}

/** `finishing`: the merge/rebase/... in progress; committing finishes (or continues) it, an empty message uses git's.
 *  `conflicts`: unresolved files, which block that. */
type CommitProps = { path: string; branch: string | null; staged: number; finishing: string | null; conflicts: number; run: Run; push: () => Promise<unknown>; onCommit: (msg: string, amend: boolean) => Promise<boolean> };
const PUSH_KEY = "push-after-commit";

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
/** What the Commit button does while `op` is in progress. */
const finishLabel = (op: string) => op === "rebase" ? "continue the rebase" : `finish the ${op}`;

function CommitBox({ path, branch, staged, finishing, conflicts, run, push, onCommit }: CommitProps) {
  const canCommit = staged > 0;
  const [msg, setMsg] = useState("");
  const [amend, setAmend] = useState(false);
  // Kept in localStorage like the Pull mode.
  const [pushAfter, setPushAfter] = useState(() => { try { return localStorage.getItem(PUSH_KEY) === "1"; } catch { return false; } });
  const togglePush = (on: boolean) => {
    setPushAfter(on);
    try { localStorage.setItem(PUSH_KEY, on ? "1" : ""); } catch { /* storage blocked */ }
  };
  // Mid-merge/rebase or detached, there's no branch tip to push yet.
  const pushOff = !branch ? "Check out a branch to push it" : finishing ? `Finish the ${finishing} first` : "";
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const hasKey = useQuery(aiKeyQuery).data;
  // Generates from the staged diff only, so not for amend (the message would miss HEAD's changes) or merges.
  async function generate() {
    if (!hasKey) return openSettings();
    setWriting(true);
    await run(async () => {
      try {
        setMsg(await aiCommitMessage(path));
      } catch (e) {
        if ((e as AppError).code === "ai_key") openSettings();
        throw e;
      }
    });
    setWriting(false);
  }
  const head = useQuery({ queryKey: ["head", path], queryFn: () => headMessage(path) }).data;
  // Amend may just reword, so it doesn't need staged changes.
  // A merge commit may have nothing staged (all conflicts resolved to "ours").
  // Amending with the same message and nothing staged would change nothing.
  const why = amend ? (!msg.trim() ? "Write a commit message" : msg === head && !canCommit ? "Change the message or stage files to amend" : "")
    : finishing ? (conflicts ? "Resolve the conflicts first" : "")
    : !canCommit ? "Stage files to commit" : !msg.trim() ? "Write a commit message" : "";
  const ok = !why && !busy;
  const subject = msg.split("\n")[0].trim().length;
  function toggleAmend(on: boolean) {
    setAmend(on);
    if (on && !msg.trim() && head) setMsg(head);
    if (!on && msg === head) setMsg("");
  }
  async function submit() {
    if (!ok) return;
    setBusy(true);
    const done = await onCommit(msg, amend);
    if (done) {
      setMsg("");
      setAmend(false);
    }
    setBusy(false);
    if (done && pushAfter && !pushOff) await push();
  }
  return (
    <form className="commit" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div className="commit-head">
        <label htmlFor="commit-msg">{amend ? "Amend" : "Commit"} to <span className="branch-tag mono"><Icon name="branch" />{branch ?? "detached HEAD"}</span></label>
        {/* Git convention: a subject line of 72 characters at most. */}
        {subject > 0 && <span className={`subject-len${subject > 72 ? " over" : ""}`} title="Subject line length (72 max by convention)">{subject}/72</span>}
      </div>
      {/* One field: the message on top, its tools docked inside the same frame. */}
      <div className="composer">
        <textarea
          id="commit-msg"
          aria-label="Commit message"
          placeholder={finishing ? "Leave empty to use git's message" : "Describe what changed and why"}
          value={msg}
          rows={3}
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(); }}
        />
        <div className="composer-bar">
          {/* Nothing staged: the backend describes all changes instead. */}
          <button type="button" className="small ghost ai-gen" disabled={amend || !!finishing || writing} aria-busy={writing} onClick={generate}
            title={amend ? "Not available while amending: the last commit's message is kept" : finishing ? `Not available while finishing the ${finishing}`
              : hasKey ? `Write a message from the ${canCommit ? "staged" : "changed"} files (sent to your AI provider)` : "Set up AI in Settings first"}>
            <Icon name="sparkle" />{writing ? "Writing…" : "Generate"}
          </button>
          <span className="opts">
            <label className="opt" title={!head ? "No commits to amend yet" : finishing ? `Finish the ${finishing} first` : "Fold the staged changes into the last commit"}>
              <input type="checkbox" checked={amend} disabled={!head || !!finishing} onChange={(e) => toggleAmend(e.target.checked)} />
              <Icon name="undo" />Amend
            </label>
            <label className="opt" title={pushOff || "Push this branch once the commit succeeds"}>
              <input type="checkbox" checked={pushAfter && !pushOff} disabled={!!pushOff} onChange={(e) => togglePush(e.target.checked)} />
              <Icon name="push" />Push
            </label>
          </span>
        </div>
      </div>
      <button className="primary commit-go" disabled={!ok} title={why || "Ctrl+Enter in the message box"}>
        <span>{busy ? (amend ? "Amending…" : "Committing…") : amend ? "Amend" : finishing ? (finishing === "rebase" ? "Continue rebase" : `Finish ${finishing}`)
          : staged ? `Commit ${staged} file${staged === 1 ? "" : "s"}` : "Commit"}{!busy && pushAfter && !pushOff && " & push"}</span>
        <kbd aria-hidden="true">{navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl"} ↵</kbd>
      </button>
      {/* The git the button runs. Not shown while finishing a merge/rebase, where the command varies. */}
      {!finishing && (
        <p className="git-hint">{amend ? "git commit --amend" : `git commit -m "${msg.split("\n")[0].trim() || "…"}"`}{pushAfter && !pushOff && " && git push"}</p>
      )}
    </form>
  );
}

type ListProps = {
  title: string;
  files: FileChange[];
  staged: boolean;
  action: string;
  onAction: (files: FileChange[]) => void;
  onDiscard?: (files: FileChange[]) => void;
  /** Untracked files get an Ignore button. */
  onIgnore?: (file: string) => void;
  sel: Selection | null;
  onSelect: (s: Selection) => void;
};

function FileList({ title, files, staged, action, onAction, onDiscard, onIgnore, sel, onSelect }: ListProps) {
  // Multi-selection: Ctrl/Shift+click, Ctrl+A, or drag over rows. Only shown while the diff's file is in this list.
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const anchor = useRef(0);
  const drag = useRef<number | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [ctx, setCtx] = useState<FileChange | null>(null);
  if (!files.length) return null;
  const active = sel?.staged === staged && files.some((f) => f.path === sel.file);
  const isMarked = (f: FileChange) => active && (marked.has(f.path) || f.path === sel?.file);
  const picked = files.filter(isMarked);
  // The context menu acts on the selection when its row is part of it.
  const ctxFiles = ctx && picked.length > 1 && picked.includes(ctx) ? picked : ctx ? [ctx] : [];
  const range = (a: number, b: number) => new Set(files.slice(Math.min(a, b), Math.max(a, b) + 1).map((f) => f.path));
  function click(e: React.MouseEvent, i: number) {
    const p = files[i].path;
    const base = new Set(picked.map((f) => f.path));
    if (e.shiftKey) setMarked(range(anchor.current, i));
    else if (e.ctrlKey || e.metaKey) {
      base.has(p) && base.size > 1 ? base.delete(p) : base.add(p);
      setMarked(base);
      anchor.current = i;
      // Unpicking the diff's file moves the diff to another picked one.
      if (!base.has(p)) return onSelect({ file: [...base][0], staged });
    } else { setMarked(new Set([p])); anchor.current = i; }
    onSelect({ file: p, staged });
  }
  return (
    <section>
      <div className="list-head">
        <h2>{title} <span className="count">{files.length}</span></h2>
        {onDiscard && <button className="small ghost" onClick={() => onDiscard(files)}>Discard all</button>}
        <button className="small ghost" onClick={() => onAction(files)} title={action === "Stage" ? "Stage all (Ctrl+Shift+S)" : undefined}>{action} all</button>
      </div>
      <ul className="files" aria-multiselectable
        onKeyDown={(e) => {
          if (e.key.toLowerCase() !== "a" || !(e.ctrlKey || e.metaKey) || (e.target as HTMLElement).closest("input, textarea")) return;
          e.preventDefault();
          setMarked(new Set(files.map((f) => f.path)));
          if (!active) onSelect({ file: files[0].path, staged });
        }}>
        {files.map((f, i) => {
          const selected = isMarked(f);
          // Row buttons act on the whole selection when their row is part of it.
          const targets = selected && picked.length > 1 ? picked : [f];
          return (
            <li key={f.path} className={selected ? "sel" : undefined}
              onContextMenu={(e) => { setCtx(f); showMenu(menu.current, e); }}
              onMouseEnter={(e) => {
                if (drag.current === null || !(e.buttons & 1)) return void (drag.current = null);
                setMarked(range(drag.current, i));
              }}>
              <button className="row" aria-pressed={selected} onClick={(e) => click(e, i)}
                onMouseDown={(e) => { if (e.button === 0 && !e.shiftKey && !e.ctrlKey && !e.metaKey) { drag.current = i; click(e, i); } }}
                title={f.orig_path ? `${f.orig_path} → ${f.path}` : f.path}>
                <FileLabel f={f} />
              </button>
              {onIgnore && f.kind === "?" && f.path !== ".gitignore" && <button className="small ghost" onClick={() => onIgnore(f.path)}>Ignore</button>}
              {onDiscard && <button className="small ghost" onClick={() => onDiscard(targets)}>Discard{targets.length > 1 ? ` ${targets.length}` : ""}</button>}
              <button className="small ghost" onClick={() => onAction(targets)}>{action}{targets.length > 1 ? ` ${targets.length}` : ""}</button>
            </li>
          );
        })}
      </ul>
      <RefMenu pop={menu} label={`Actions for ${ctx?.path ?? "file"}`} actions={ctx ? [
        ["Compare with a branch", () => openFileHistory("HEAD", ctx.path, "compare")],
        ["History and blame", () => openFileHistory("HEAD", ctx.path), ctx.kind === "?" || ctx.kind === "A" ? "New file: no history yet" : undefined],
        [ctxFiles.length > 1 ? `Stash ${ctxFiles.length} files` : "Stash this file", () => openStashSave(pathsOf(ctxFiles))],
      ] : []} />
    </section>
  );
}

/** A conflicted file with its markers, plus whole-file resolutions. Edits in between happen in an editor.
 *  `resolved`: resolved and staged; shows the file as it will be committed. */
function Conflict({ path, file, op, resolved, run }: { path: string; file: string; op: string | null; resolved: boolean; run: Run }) {
  // "Mine" = your work. During a rebase git swaps the sides: its "ours" is the branch rebased so far
  // and its "theirs" is your commit being replayed.
  const rebasing = op === "rebase";
  const mine: Side = rebasing ? "Theirs" : "Ours";
  const theirs: Side = rebasing ? "Ours" : "Theirs";
  const { data, error } = useQuery({ queryKey: ["work", path, file], queryFn: () => workFile(path, file) });
  const eds = useQuery({ queryKey: ["editors"], queryFn: editors, staleTime: Infinity });
  const [editor, setEditor] = useState<string | null>(null);
  const chosen = editor ?? eds.data?.chosen ?? "";
  const menu = useRef<HTMLDivElement>(null);
  // Edited in an editor: once the markers seen here are all gone, mark the file resolved.
  // Never on first sight (a delete/modify conflict has no markers at all).
  const hadMarkers = useRef(false);
  useEffect(() => {
    if (resolved) hadMarkers.current = false;
    if (typeof data !== "string" || resolved) return;
    if (/^(<{7}|>{7})( |\r?$)/m.test(data)) hadMarkers.current = true;
    else if (hadMarkers.current) {
      hadMarkers.current = false;
      run(() => stage(path, [file]), `Resolved ${file}`);
    }
  }, [data, resolved]);
  const open = (n: string) => run(() => openFile(path, file, n || null).then(() => void eds.refetch()));
  // AI proposal: shown for review; nothing is written until Apply.
  const hasKey = useQuery(aiKeyQuery).data;
  const [proposal, setProposal] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  async function askAi() {
    if (!hasKey) return openSettings();
    setAsking(true);
    await run(async () => {
      try {
        setProposal(await aiResolveConflict(path, file));
      } catch (e) {
        if ((e as AppError).code === "ai_key") openSettings();
        throw e;
      }
    });
    setAsking(false);
  }
  if (proposal !== null) return (
    <section className="diff">
      <div className="diff-bar">
        <span className="conflict-file">AI proposal for <strong>{file}</strong></span>
        <span className="conflict-actions">
          <button className="small primary" onClick={async () => { if (await run(() => writeResolved(path, file, proposal), `Resolved ${file}`)) setProposal(null); }}
            title="Write this to the file (backed up first) and mark it resolved">Apply</button>
          <button className="small" onClick={() => setProposal(null)}>Discard</button>
        </span>
      </div>
      <p className="muted legend">Check it before applying: AI can drop or mix up changes. Undo history restores the file with its markers.</p>
      <pre aria-label={`AI proposal for ${file}`}>
        {proposal.replace(/\n$/, "").split("\n").map((l, i) => <div key={i}>{l || " "}</div>)}
      </pre>
    </section>
  );
  let side: "" | "ours" | "base" | "theirs" = "";
  return (
    <section className="diff">
      <div className="diff-bar">
        <span className="conflict-file">{resolved ? "Resolved" : "Conflict in"} <strong>{file}</strong></span>
        <span className="conflict-actions">
          {!resolved && <>
          <button className="small" disabled={asking || typeof data !== "string"} onClick={askAi}
            title={hasKey ? "Propose a merge of both sides (file sent to your AI provider); you review it before it's applied" : "Set up AI in Settings first"}>
            <Icon name="sparkle" />{asking ? "Resolving…" : "Resolve with AI"}</button>
          <button className="small" onClick={() => run(() => resolve(path, [file], mine))}
            title={`Keep ${rebasing ? "your commit's" : "your branch's"} version (backed up first)`}>Keep mine</button>
          <button className="small" onClick={() => run(() => resolve(path, [file], theirs))}
            title={`Keep the ${rebasing ? "branch you're rebasing onto" : "incoming"} version (backed up first)`}>Keep theirs</button>
          <button className="small" onClick={() => run(() => resolve(path, [file], rebasing ? "TheirsThenOurs" : "OursThenTheirs"))}
            title="Keep both sides of every conflict, mine first (backed up first)">Mine, then theirs</button>
          <button className="small" onClick={() => run(() => resolve(path, [file], rebasing ? "OursThenTheirs" : "TheirsThenOurs"))}
            title="Keep both sides of every conflict, theirs first (backed up first)">Theirs, then mine</button>
          </>}
          {/* Split button: the main part opens in the remembered editor, the chevron picks another (and opens in it). */}
          <span className="split-btn">
            <button className="small" title="Open the file to edit the conflict by hand" onClick={() => open(chosen)}>
              <span>{chosen === "Other app…" ? "Open with…" : `Open in ${chosen || "default app"}`}</span>
            </button>
            <button className="small split-menu" aria-label="Choose editor" title="Choose editor" aria-haspopup="menu" onClick={(e) => {
              const el = menu.current!, r = e.currentTarget.getBoundingClientRect();
              el.showPopover();
              el.style.left = `${Math.max(4, Math.min(r.right - el.offsetWidth, innerWidth - el.offsetWidth - 4))}px`;
              el.style.top = `${Math.min(r.bottom + 4, innerHeight - el.offsetHeight - 4)}px`;
              el.querySelector<HTMLElement>("[aria-checked=true]")?.focus();
            }}><Icon name="chevron" /></button>
            <div ref={menu} popover="auto" className="row-menu editor-menu" role="menu" aria-label="Open in" onKeyDown={menuKeys}>
              {["", ...(eds.data?.found ?? [])].map((n) => (
                <button key={n} role="menuitemradio" aria-checked={n === chosen}
                  onClick={() => { menu.current!.hidePopover(); setEditor(n); open(n); }}>
                  <span className="check">{n === chosen && <Icon name="check" />}</span>{n || "Default app"}
                </button>
              ))}
            </div>
          </span>
        </span>
      </div>
      <p className="muted legend">
        {resolved ? <>Staged. This is the file as it will be committed{op ? ` when you ${finishLabel(op)}` : ""}.</> : <>
        {rebasing
          ? <><span className="theirs">Mine</span> = your commit being replayed, <span className="ours">theirs</span> = the branch you're rebasing onto.</>
          : <><span className="ours">Mine</span> = your branch, <span className="theirs">theirs</span> = incoming.</>}{" "}
        Edit the file to combine them; once no markers are left and it is saved, it is marked resolved.
        </>}
      </p>
      {error ? <p className="error" role="alert">{errorText(error)}</p>
        : data === null ? <p className="muted">Binary file or larger than 1 MB, take a side or open it.</p>
        : data !== undefined && (
          <pre aria-label={resolved ? `Resolved ${file}` : `Conflicts in ${file}`}>
            {data.replace(/\r?\n$/, "").split(/\r?\n/).map((l, i) => {
              // Marker lines switch the region; diff3 style adds a "|||||||" base section.
              const marker = /^(<{7}|\|{7}|={7}|>{7})( |$)/.exec(l)?.[1][0];
              if (marker) side = marker === "<" ? "ours" : marker === "|" ? "base" : marker === "=" ? "theirs" : "";
              return <div key={i} className={marker ? "marker" : side}>{l || " "}</div>;
            })}
          </pre>
        )}
    </section>
  );
}

type DiffProps = { path: string; sel: Selection | null; kind?: string; run: Run };

/** Kind badge, file-type icon, folder (dimmed) + file name; the name never truncates first. */
export function FileLabel({ f }: { f: FileChange }) {
  const slash = f.path.lastIndexOf("/");
  return (
    <>
      <span className={`kind ${kindClass(f.kind)}`}>{f.kind}</span>
      <FileIcon file={f.path} />
      <span className="path">
        <strong>{f.path.slice(slash + 1)}</strong>
        {slash > 0 && <small>{f.path.slice(0, slash)}</small>}
      </span>
    </>
  );
}

// How every diff pane shows diffs: side by side (`split`) and/or ignoring whitespace (`ws`, `git diff -w`).
// One choice for all panes, kept across restarts.
type DiffView = { split: boolean; ws: boolean };
const VIEW_KEY = "diff-view";
let diffView: DiffView = { split: false, ws: false };
try { diffView = { ...diffView, ...JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}") }; } catch { /* storage blocked or corrupt */ }
const viewSubs = new Set<() => void>();
export const useDiffView = () => useSyncExternalStore((f) => { viewSubs.add(f); return () => { viewSubs.delete(f); }; }, () => diffView);
function setDiffView(v: Partial<DiffView>) {
  diffView = { ...diffView, ...v };
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(diffView)); } catch { /* storage blocked */ }
  viewSubs.forEach((f) => f());
}

/** Diff pane header: kind, folder/name, +added −removed, then the view toggles. `lines`: the diff from its first "@@". */
export function DiffHead({ file, kind, lines, children }: { file: string; kind?: string; lines?: string[]; children?: React.ReactNode }) {
  const slash = file.lastIndexOf("/");
  const count = (c: string) => lines?.reduce((n, l) => n + +(l[0] === c), 0) ?? 0;
  const { split, ws } = useDiffView();
  const add = count("+"), del = count("-");
  // Change size: five blocks split by added/removed share (exact counts below 5 lines).
  const ga = Math.round((5 * add) / Math.max(add + del, 5)), gd = Math.min(5 - ga, Math.round((5 * del) / Math.max(add + del, 5)));
  return (
    <header className="diff-head">
      {kind && <span className={`kind ${kindClass(kind)}`}>{kind}</span>}
      <span className="diff-file" title={file}>
        {slash > 0 && <small>{file.slice(0, slash + 1)}</small>}<strong>{file.slice(slash + 1)}</strong>
      </span>
      {lines && <span className="stat" aria-label={`${add} lines added, ${del} removed`}><b className="plus">+{add}</b><b className="minus">−{del}</b></span>}
      {lines && <span className="size-bar" aria-hidden="true">{[0, 1, 2, 3, 4].map((i) => <i key={i} className={i < ga ? "a" : i < ga + gd ? "d" : undefined} />)}</span>}
      {children}
      <span className="diff-opts" role="group" aria-label="Diff view">
        <button type="button" className="small ghost" aria-pressed={split} onClick={() => setDiffView({ split: !split })}
          title="Old version on the left, new on the right">Split</button>
        <button type="button" className="small ghost" aria-pressed={ws} onClick={() => setDiffView({ ws: !ws })} aria-label="Ignore whitespace"
          title="Hide changes that only add or remove spaces and tabs (git diff -w)">Ignore<span className="wide"> whitespace</span></button>
      </span>
    </header>
  );
}

/** What a diff with no "@@" left means. */
export const noContentNote = (ws: boolean) => ws
  ? <PaneNote icon="info" title="Only whitespace changes"><p>Or only the mode or name changed. Turn off Ignore whitespace to see them.</p></PaneNote>
  : <PaneNote icon="info" title="No content changes"><p>Only the mode or name changed.</p></PaneNote>;

/** Side-by-side rows of a diff's `lines` (from its first "@@"): [old, new] indices into `lines`, -1 = blank.
 *  A hunk header or context line is [i, i]; a run of − lines pairs up with the + run right after it. */
export function splitRows(lines: string[]) {
  const rows: [number, number][] = [];
  // Collects the run of `c` lines from `i` ("\ No newline" notes inside it are skipped); returns where it ends.
  const run = (i: number, c: string, out: number[]) => {
    for (; i < lines.length && (lines[i][0] === c || lines[i][0] === "\\"); i++) if (lines[i][0] === c) out.push(i);
    return i;
  };
  for (let i = 0; i < lines.length;) {
    if (lines[i][0] === "-" || lines[i][0] === "+") {
      const del: number[] = [], add: number[] = [];
      i = run(run(i, "-", del), "+", add);
      for (let k = 0; k < Math.max(del.length, add.length); k++) rows.push([del[k] ?? -1, add[k] ?? -1]);
    } else {
      if (lines[i][0] !== "\\") rows.push([i, i]);
      i++;
    }
  }
  return rows;
}

/** One side of a split row: diff line `l` with its line number; no `l` = the blank side of an add or delete. */
// ponytail: each side is cut at the pane's middle (no sideways scroll); the full line is in its tooltip. Unified view shows it whole.
export function Half({ l, num, hl, className, ...rest }: { l?: string; num: number | ""; hl: string | null } & React.HTMLAttributes<HTMLSpanElement>) {
  if (l === undefined) return <span className="blank" />;
  const kind = l[0] === "+" ? "add" : l[0] === "-" ? "del" : "";
  return (
    <span className={[kind, className].filter(Boolean).join(" ") || undefined} title={l.length > 60 ? l.slice(1) : undefined} {...rest}>
      <span className="ln" aria-hidden="true"><span>{num}</span></span><DiffLine line={l} lang={hl} />
    </span>
  );
}

/** Centered message filling a pane: icon, title, one line. */
export const PaneNote = ({ icon, title, children }: { icon: IconName; title: string; children?: React.ReactNode }) => (
  <div className="pane-note"><span className="pane-note-icon"><Icon name={icon} /></span><strong>{title}</strong>{children}</div>
);

/** Nothing to commit: takes the whole diff pane. */
function Clean({ branch }: { branch: string | null }) {
  return (
    <section className="diff clean">
      <PaneNote icon="check" title="Working tree clean">
        <p>Everything on <span className="mono">{branch ?? "detached HEAD"}</span> is committed. Edit a file and it shows up here.</p>
      </PaneNote>
    </section>
  );
}

function Diff({ path, sel, kind, run }: DiffProps) {
  const { split, ws } = useDiffView();
  const { data, error } = useQuery({
    queryKey: ["diff", path, sel?.file, sel?.staged, ws],
    queryFn: () => fileDiff(path, sel!.file, sel!.staged, ws),
    enabled: !!sel,
  });
  // Picked +/- lines, as indices into the diff text's lines (what `applyLines` expects).
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const lang = useLang(sel?.file ?? "", data);
  useEffect(() => {
    setPicked(new Set());
    setAnchor(null);
  }, [data, sel?.file, sel?.staged]);

  if (!sel) return <section className="diff"><PaneNote icon="changes" title="No file selected"><p>Pick a file to see its changes.</p></PaneNote></section>;
  const head = <DiffHead file={sel.file} kind={kind} />;
  if (error) return <section className="diff">{head}<p className="pane-note error" role="alert">{errorText(error)}</p></section>;
  if (data === undefined) return <section className="diff">{head}</section>;
  if (data === null) {
    const pattern = lfsPatternFor(sel.file);
    return (
      <section className="diff">
        {head}
        <PaneNote icon="info" title="No inline diff">
          <p>Binary file or larger than 1 MB.</p>
          {pattern && <button className="small" onClick={() => openLfs(pattern)}>Track {pattern} with Git LFS…</button>}
        </PaneNote>
      </section>
    );
  }
  const all = data.replace(/\n$/, "").split("\n");
  // Skip the "diff --git / index / --- / +++" header; hunks start at the first "@@".
  const start = all.findIndex((l) => l.startsWith("@@"));
  if (start < 0) return <section className="diff">{head}{noContentNote(ws)}</section>;

  const file = sel.file;
  const isChange = (i: number) => all[i][0] === "+" || all[i][0] === "-";
  // Ignoring whitespace, the lines shown aren't the ones git would stage: no line or hunk picking then.
  const ops: [LineOp, string][] = ws ? [] : sel.staged ? [["Unstage", "Unstage"]] : [["Stage", "Stage"], ["Discard", "Discard"]];
  async function apply(op: LineOp, lines: number[], what: string) {
    if (op === "Discard" && !(await confirmDiscard(`${what} in ${file}`))) return;
    run(() => applyLines(path, file, op, lines));
  }
  function hunkLines(h: number) {
    const out = [];
    for (let i = h + 1; i < all.length && !all[i].startsWith("@@"); i++) if (isChange(i)) out.push(i);
    return out;
  }
  function toggle(i: number, range: boolean) {
    const next = new Set(picked);
    const on = !picked.has(i);
    const [a, b] = range && anchor !== null ? [Math.min(anchor, i), Math.max(anchor, i)] : [i, i];
    for (let j = a; j <= b; j++) if (isChange(j)) on ? next.add(j) : next.delete(j);
    setPicked(next);
    setAnchor(i);
  }

  const nums = lineNumbers(all, start);
  // Split: [old, new] indices into `all`.
  const rows = split ? splitRows(all.slice(start)).map(([a, b]) => [a < 0 ? a : start + a, b < 0 ? b : start + b]) : null;
  const hunkRow = (i: number) => (
    <div key={i} className="hunk">
      {ops.map(([op, label]) => (
        <button key={op} className="small" data-op={op} onClick={() => apply(op, hunkLines(i), "this hunk")}>{label} hunk</button>
      ))}
      <span>{all[i]}</span>
    </div>
  );
  // A +/- line as a pickable row (unified) or cell (split).
  const pick = (i: number, cls: string) => {
    const on = picked.has(i);
    return {
      role: "checkbox", "aria-checked": on, className: `${cls} pick${on ? " on" : ""}`.trim(),
      onMouseDown: (e: React.MouseEvent) => e.shiftKey && e.preventDefault(), // no text selection on Shift+click
      onClick: (e: React.MouseEvent) => toggle(i, e.shiftKey),
    };
  };
  const half = (i: number, side: 0 | 1) => i < 0 ? <Half num="" hl={lang} />
    : <Half l={all[i]} num={nums[i - start][side]} hl={lang} {...(ops.length && isChange(i) ? pick(i, "") : {})} />;
  return (
    <section className="diff">
      <DiffHead file={file} kind={kind} lines={all.slice(start)}>
        {ws ? (
          <span className="hint">Turn off Ignore whitespace to stage lines</span>
        ) : picked.size ? (
          <span className="picked" role="status">
            <span>{picked.size} line{picked.size > 1 ? "s" : ""}</span>
            {ops.map(([op, label]) => (
              <button key={op} className={`small ${op === "Discard" ? "ghost" : "primary"}`} onClick={() => apply(op, [...picked], "the selected lines")}>{label}</button>
            ))}
            <button className="small ghost" onClick={() => setPicked(new Set())}>Clear</button>
          </span>
        ) : (
          <span className="hint">Click lines to pick them, Shift+click for a range</span>
        )}
      </DiffHead>
      <Lines key={file + split} label={`Diff of ${file}`} n={rows ? rows.length : all.length - start} width={rows ? 0 : widest(all)}
        hunk={(k) => !!all[rows ? rows[k][0] : start + k]?.startsWith("@@")}
        row={(k) => {
          if (rows) {
            const [a, b] = rows[k];
            return all[a]?.startsWith("@@") ? hunkRow(a) : <div key={k} className="split">{half(a, 0)}{half(b, 1)}</div>;
          }
          const i = start + k;
          const l = all[i];
          const [o, n] = nums[k];
          if (l.startsWith("@@")) return hunkRow(i);
          const cls = l[0] === "+" ? "add" : l[0] === "-" ? "del" : "";
          return (
            <div key={i} {...(ops.length && isChange(i) ? pick(i, cls) : { className: cls || undefined })}>
              <Gutter o={o} n={n} /><DiffLine line={l} lang={lang} />
            </div>
          );
        }} />
    </section>
  );
}

/** Old/new line numbers for each diff line from `start` (the first "@@ -a,b +c,d @@"); "" where a side has none. */
export function lineNumbers(lines: string[], start: number) {
  let o = 0, n = 0;
  return lines.slice(start).map((l): [number | "", number | ""] => {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l);
    if (h) { o = +h[1]; n = +h[2]; return ["", ""]; }
    if (l[0] === "+") return ["", n++];
    if (l[0] === "-") return [o++, ""];
    if (l[0] === "\\") return ["", ""]; // "\ No newline at end of file"
    return [o++, n++];
  });
}

export const Gutter = ({ o, n }: { o: number | ""; n: number | "" }) => <span className="ln" aria-hidden="true"><span>{o}</span><span>{n}</span></span>;

export function opLabel(e: OpEntry): string {
  // "undo undo x" re-applies x: odd depth = Undo, even = Redo.
  const depth = e.op.match(/^(undo )*/)![0].length / 5;
  if (depth) return `${depth % 2 ? "Undo" : "Redo"}: ${opLabel({ ...e, op: e.op.slice(depth * 5) })}`;
  const what = e.paths.length === 1 ? e.paths[0] : `${e.paths.length} files`;
  // Older undo entries have no ref_name: the label just drops it.
  const name = e.ref_name?.replace(/^refs\/(heads|tags|remotes)\//, "") ?? "";
  const labels: Record<string, string> = {
    discard: `Discard ${what}`,
    amend: "Amend commit",
    merge: "Merge",
    rebase: "Rebase",
    "cherry-pick": "Cherry-pick",
    revert: "Revert commit",
    reset: "Reset branch (keep)",
    "reset --soft": "Reset branch (soft)",
    "reset --mixed": "Reset branch (mixed)",
    "reset --hard": e.backup ? `Reset branch (hard, backup of ${what})` : "Reset branch (hard)",
    "delete branch": `Delete branch ${name}`,
    "delete tag": `Delete tag ${name}`,
    "drop stash": "Drop stash",
    "force push": `Force push ${name}`,
  };
  if (e.op.startsWith("take ")) return `${e.op[0].toUpperCase()}${e.op.slice(1)} for ${what}`;
  if (e.op.startsWith("abort ")) return `Abort ${e.op.slice(6)} (backup of ${what})`;
  return (labels[e.op] ?? e.op).trimEnd();
}

/** Asks before undoing `e`: it moves branches back, so commits made since can leave the branch. */
export const confirmUndo = (e: OpEntry) =>
  confirm(`${opLabel({ ...e, op: `undo ${e.op}` })}?`, "Branches go back to where they were before it. Undoing again puts them back.", "Undo");

/** Roughly what undoing `e` runs, for the palette's terminal hint. */
export function undoHint(e: OpEntry): string | undefined {
  const short = (oid: string) => oid.slice(0, 7);
  if (e.backup) return `git restore --source ${e.backup} --worktree -- ${e.paths.join(" ")}`;
  const r = e.ref_name ?? "HEAD";
  // Remote branch ops are undone by pushing the old tip back ("refs/remotes/origin/feat" -> origin, feat).
  const remote = r.match(/^refs\/remotes\/([^/]+)\/(.+)$/);
  if (remote && e.head) return `git push ${e.new_head ? `--force-with-lease=${remote[2]}:${short(e.new_head)} ` : ""}${remote[1]} ${short(e.head)}:refs/heads/${remote[2]}`;
  if (!e.head) return e.new_head ? `git update-ref -d ${r}` : undefined;
  return r === "HEAD" ? `git reset --keep ${short(e.head)}` : `git update-ref ${r} ${short(e.head)}`;
}

/** [pattern, hint] choices for ignoring `file`: itself, its extension, its folder. Wildcards in names are escaped; a leading "/" anchors to the repo root. */
export function ignorePatterns(file: string): [string, string][] {
  const esc = (s: string) => s.replace(/[\\*?[]/g, "\\$&").replace(/ $/, "\\ ");
  const name = file.slice(file.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const dir = file.slice(0, file.lastIndexOf("/") + 1);
  return [
    [`/${esc(file)}`, "Just this file."],
    ...(dot > 0 ? [[`*${esc(name.slice(dot))}`, `Every ${name.slice(dot)} file, in any folder.`] as [string, string]] : []),
    ...(dir ? [[`/${esc(dir)}`, `Everything in ${dir}`] as [string, string]] : []),
  ];
}

// Two letters = conflict; "?" = untracked (shown like an add).
export const kindClass = (k: string) => (k.length > 1 ? "k-X" : k === "?" ? "k-A" : `k-${k}`);
