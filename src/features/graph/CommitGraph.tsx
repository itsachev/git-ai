import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { commitDetails, graphRows, merge, rebaseOnto, resetTo } from "../../lib/ipc";
import { openNewBranch } from "../refs/NewBranch";
import type { GraphRow } from "../../bindings/GraphRow";
import type { GraphOpts } from "../../bindings/GraphOpts";
import { errorText, useRun } from "../status/Changes";
import { RefMenu, refsQuery, showMenu, useRefActions, type Action } from "../refs/Sidebar";
import { choose } from "../../lib/modal";
import type { ResetMode } from "../../bindings/ResetMode";

/** Reset choices: [label, hint, tone, mode]. */
const RESETS: [string, string, "accent" | "warn" | "danger", ResetMode][] = [
  ["Soft", "Only the branch moves. The changes of the dropped commits stay staged, ready to commit again.", "accent", "Soft"],
  ["Mixed", "The branch and staging move. Those changes stay as unstaged edits.", "accent", "Mixed"],
  ["Keep", "Files follow the branch; your uncommitted edits stay. Nothing happens if an edit would be overwritten.", "warn", "Keep"],
  ["Hard", "Files match the commit exactly. Uncommitted edits to tracked files are lost (backed up for Undo); untracked files stay.", "danger", "Hard"],
];

const ROW = 24; // px, fixed so row i sits at i * ROW
const PAGE = 500;
const LANE = 14;
const MAX_LANES = 16; // wider graphs are clipped
// Mid-tone lanes that hold contrast on both the light and the dark panel.
// macOS system colors: blue, green, orange, purple, pink, teal, brown, grey.
const COLORS = ["#0a84ff", "#30b14f", "#ff9500", "#af52de", "#ff2d55", "#30b0c7", "#a2845e", "#8e8e93"];
const color = (lane: number) => COLORS[lane % COLORS.length];
const x = (lane: number) => LANE / 2 + 3 + lane * LANE;
const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export type Picked = { i: number; oid: string };
type Props = { path: string; opts: GraphOpts; sel: Picked | null; onSelect: (p: Picked) => void };

const OPTS_KEY = "graph-opts";
/** Last-used history options, kept in localStorage (a per-window convenience). */
export function savedOpts(): GraphOpts {
  const def = { all: true, remotes: true, by_date: true };
  try { return { ...def, ...JSON.parse(localStorage.getItem(OPTS_KEY) ?? "{}") }; } catch { return def; }
}

/** Branches / remotes / sort toggles above the commit table. */
export function GraphOptions({ opts, onChange }: { opts: GraphOpts; onChange: (o: GraphOpts) => void }) {
  const set = (o: Partial<GraphOpts>) => {
    const next = { ...opts, ...o };
    try { localStorage.setItem(OPTS_KEY, JSON.stringify(next)); } catch { /* storage blocked */ }
    onChange(next);
  };
  // Segmented pickers: one pressed button per group.
  const seg = (label: string, items: [string, boolean, Partial<GraphOpts>][]) => (
    <div className="seg" role="group" aria-label={label}>
      {items.map(([text, on, o]) => (
        <button key={text} type="button" aria-pressed={on} onClick={() => set(o)}>{text}</button>
      ))}
    </div>
  );
  return (
    <div className="graph-opts">
      {seg("Branches", [["All branches", opts.all, { all: true }], ["Current", !opts.all, { all: false }]])}
      {seg("Remote branches", [["Remotes", opts.remotes, { remotes: !opts.remotes }]])}
      {seg("Sort", [["By date", opts.by_date, { by_date: true }], ["Ancestor order", !opts.by_date, { by_date: false }]])}
    </div>
  );
}

/** Virtualized commit table: only the visible rows are in the DOM, their graph on one canvas. */
export function CommitGraph({ path, opts, sel, onSelect }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState({ top: 0, height: 0 });
  const refsData = useQuery(refsQuery(path)).data;
  const branch = refsData?.head;
  const refActions = useRefActions(path);
  const run = useRun();
  const qc = useQueryClient();
  const menuPop = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<Action[]>([]);

  /** Reset the current branch to commit `r` (row menu and its ref labels' menus). */
  function resetAction(r: GraphRow): Action {
    const at = r.oid.slice(0, 7);
    const target = branch ?? "HEAD";
    return [`Reset ${target} to here…`, async () => {
      const i = await choose(`Reset ${target} to ${at}`, r.head
        ? `${target} already points at “${r.summary}”, so only your uncommitted changes are affected. What should happen to them?`
        : `Moves ${target} to “${r.summary}”. Commits after it leave ${target}; Undo history (sidebar) can bring them back. What happens to the files?`,
        RESETS.map(([label, hint, tone]) => ({ label, hint, tone })), "branch");
      if (i >= 0) run(() => resetTo(path, r.oid, RESETS[i][3]), `Reset ${target} to ${at} (${RESETS[i][3].toLowerCase()})`);
    }];
  }

  /** Right-click on a commit row: picks it and opens its actions (its label's, local branch first, plus reset). */
  async function rowMenu(e: React.MouseEvent<HTMLDivElement>, i: number, r: GraphRow) {
    e.preventDefault();
    onSelect({ i, oid: r.oid });
    const ref = r.refs.find((n) => refsData?.local.some((b) => b.name === n)) ?? r.refs[0];
    const at = r.oid.slice(0, 7);
    // Same query as the details pane, so it's usually cached already.
    const inHead = !ref && branch && !r.head && (await qc.fetchQuery({ queryKey: ["commit", path, r.oid], queryFn: () => commitDetails(path, r.oid) }).catch(() => null))?.in_head;
    const done = inHead ? `${branch} already has ${at}` : undefined;
    // Unlabeled commit: the same actions, by commit id.
    const own: Action[] = [["New branch from here", () => openNewBranch(r.oid)], ...(branch && !r.head ? [
      [`Merge ${at} into ${branch}`, () => run(() => merge(path, r.oid, false), `Merged ${at} into ${branch}`), done],
      [`Rebase ${branch} onto ${at}`, () => run(() => rebaseOnto(path, r.oid), `Rebased ${branch} onto ${at}`), done],
    ] as Action[] : [])];
    flushSync(() => setMenu([...(ref ? refActions(ref) : own), resetAction(r)]));
    showMenu(menuPop.current, e);
  }

  useLayoutEffect(() => {
    const el = scroller.current!;
    const ro = new ResizeObserver(() => setView({ top: el.scrollTop, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const first = Math.floor(view.top / ROW);
  const want = Math.ceil(view.height / ROW);
  // Page 0 always loads: it carries the total even when scrolled far down.
  const pageIds = [...new Set([0, Math.floor(first / PAGE), Math.floor((first + want) / PAGE)])];
  const pages = useQueries({
    queries: pageIds.map((p) => ({ queryKey: ["graph", path, opts, p], queryFn: () => graphRows(path, opts, p * PAGE, PAGE) })),
  });
  const byId = new Map(pageIds.map((p, k) => [p, pages[k].data]));
  const head = pages[0].data;
  const total = head?.total ?? 0;
  const last = Math.min(total - 1, first + want);
  const rowAt = (i: number): GraphRow | undefined => byId.get(Math.floor(i / PAGE))?.rows[i % PAGE];
  const gw = x(Math.min(head?.lanes ?? 1, MAX_LANES)) + LANE / 2;

  // Select the newest commit once the graph loads.
  const top = rowAt(0);
  useEffect(() => {
    if (!sel && top) onSelect({ i: 0, oid: top.oid });
  }, [sel, top, onSelect]);

  const visible: [number, GraphRow][] = [];
  for (let i = first; i <= last; i++) {
    const r = rowAt(i);
    if (r) visible.push([i, r]);
  }

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const h = (last - first + 1) * ROW;
    c.width = gw * dpr;
    c.height = Math.max(h, 0) * dpr;
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2;
    // Edges of row last + 1 still reach up into the last visible row.
    for (let i = first; i <= last + 1; i++) {
      const r = rowAt(i);
      if (!r) continue;
      const y = (i - first) * ROW + ROW / 2;
      for (const [a, b] of r.edges) {
        ctx.strokeStyle = color(Math.max(a, b));
        ctx.beginPath();
        ctx.moveTo(x(a), y - ROW);
        if (a === b) ctx.lineTo(x(b), y);
        else ctx.bezierCurveTo(x(a), y - ROW / 2, x(b), y - ROW / 2, x(b), y);
        ctx.stroke();
      }
    }
    const bg = getComputedStyle(c).getPropertyValue("--panel");
    for (const [i, r] of visible) {
      const y = (i - first) * ROW + ROW / 2;
      ctx.beginPath();
      ctx.arc(x(r.col), y, r.head ? 5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = r.head ? bg : color(r.col);
      ctx.strokeStyle = color(r.col);
      ctx.fill();
      ctx.stroke();
    }
  });

  function move(d: number) {
    if (!sel) return;
    const i = Math.max(0, Math.min(total - 1, sel.i + d));
    const r = rowAt(i);
    if (!r) return;
    onSelect({ i, oid: r.oid });
    const el = scroller.current!;
    if (i * ROW < el.scrollTop) el.scrollTop = i * ROW;
    else if ((i + 1) * ROW > el.scrollTop + el.clientHeight) el.scrollTop = (i + 1) * ROW - el.clientHeight;
  }

  const cols = { gridTemplateColumns: `${gw}px var(--graph-cols)` };
  const err = pages.find((p) => p.error)?.error;
  return (
    <section className="graph">
      <div className="graph-head" style={cols}>
        <span>{gw >= 56 ? "Graph" : ""}</span><span>Description</span><span className="c-date">Date</span><span className="c-author">Author</span><span className="c-oid">Commit</span>
      </div>
      {err ? <p className="error" role="alert">{errorText(err)}</p> : null}
      {head && !total && <p className="muted">No commits yet.</p>}
      <div
        className="graph-body" ref={scroller} tabIndex={0} role="listbox" aria-label="Commits"
        aria-activedescendant={sel ? `c-${sel.oid}` : undefined}
        onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
        onKeyDown={(e) => {
          const d = { ArrowDown: 1, ArrowUp: -1, PageDown: want, PageUp: -want }[e.key];
          if (d) { e.preventDefault(); move(d); }
        }}
      >
        <div style={{ height: total * ROW, position: "relative" }}>
          <canvas ref={canvas} style={{ position: "absolute", top: first * ROW, left: 0, width: gw, height: (last - first + 1) * ROW, zIndex: 1, pointerEvents: "none" }} />
          {visible.map(([i, r]) => (
            <div key={i} id={`c-${r.oid}`} role="option" aria-selected={sel?.oid === r.oid}
              className={`grow${sel?.oid === r.oid ? " sel" : ""}${r.head ? " head" : ""}`}
              style={{ ...cols, top: i * ROW, height: ROW }} onClick={() => onSelect({ i, oid: r.oid })} onContextMenu={(e) => rowMenu(e, i, r)}>
              <span />
              <span className="desc">
                {r.refs.map((n) => <RefChip key={n} name={n} path={path} extra={[resetAction(r)]} />)}
                <span className="sum">{r.summary}</span>
              </span>
              <span className="c-date">{dateFmt.format(r.time * 1000)}</span>
              <span className="c-author"><Avatar name={r.author} /><span>{r.author}</span></span>
              <span className="c-oid">{r.oid.slice(0, 7)}</span>
            </div>
          ))}
        </div>
      </div>
      <RefMenu pop={menuPop} label="Commit actions" actions={menu} />
    </section>
  );
}

/** Branch/tag label on a commit; right-click for the same actions as the sidebar. */
function RefChip({ name, path, extra }: { name: string; path: string; extra: Action[] }) {
  const pop = useRef<HTMLDivElement>(null);
  const actions = [...useRefActions(path)(name), ...extra];
  return (
    <>
      <span className="ref" title={`${name} (right-click for actions)`} onContextMenu={(e) => { e.stopPropagation(); showMenu(pop.current, e); }}>{name}</span>
      {actions.length > 0 && <RefMenu pop={pop} label={name} actions={actions} />}
    </>
  );
}

/** Initials on a hue picked from the name, so one author keeps one color everywhere. */
export function Avatar({ name }: { name: string }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return <span className="avatar" style={{ "--h": h } as React.CSSProperties} aria-hidden="true">{initials}</span>;
}
