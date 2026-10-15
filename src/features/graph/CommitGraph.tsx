import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { commitDetails, graphRows, graphSearch, merge, rebaseOnto, resetTo } from "../../lib/ipc";
import { openNewBranch } from "../refs/NewBranch";
import type { GraphRow } from "../../bindings/GraphRow";
import type { GraphPage } from "../../bindings/GraphPage";
import type { GraphOpts } from "../../bindings/GraphOpts";
import type { SearchIn } from "../../bindings/SearchIn";
import { errorText, useRun } from "../status/Changes";
import { RefMenu, confirmMerge, confirmRebase, refsQuery, showMenu, useRefActions, type Action } from "../refs/Sidebar";
import { choose, confirm } from "../../lib/modal";
import type { ResetMode } from "../../bindings/ResetMode";
import { Icon } from "../../lib/icons";

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
// Spruce first (the accent), then ochre, slate blue, brick, olive, plum, rose, stone.
const COLORS = ["#14a094", "#d08a1e", "#5b7bd5", "#d0503c", "#74a02e", "#a35fb5", "#d0607e", "#958c80"];
const color = (lane: number) => COLORS[lane % COLORS.length];
const x = (lane: number) => LANE / 2 + 3 + lane * LANE;
const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export type Picked = { i: number; oid: string };
/** `onCompare`: Ctrl+click (Cmd+click) on a row other than the picked one. */
type Props = { path: string; opts: GraphOpts; sel: Picked | null; onSelect: (p: Picked) => void; onCompare?: (p: Picked) => void; hits?: Set<string> };

const OPTS_KEY = "graph-opts";
/** Last-used history options, kept in localStorage (a per-window convenience). */
export function savedOpts(): GraphOpts {
  const def = { all: true, own: false, remotes: true, by_date: true };
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
  const seg = (label: string, items: [string, boolean, Partial<GraphOpts>, string?][]) => (
    <div className="seg" role="group" aria-label={label}>
      {items.map(([text, on, o, title]) => (
        <button key={text} type="button" aria-pressed={on} title={title} onClick={() => set(o)}>{text}</button>
      ))}
    </div>
  );
  return (
    <div className="graph-opts">
      {seg("Branches", [
        ["All branches", opts.all, { all: true }],
        ["Current", !opts.all && !opts.own, { all: false, own: false }, "Everything the current branch contains, including the history it started from"],
        ["Own commits", !opts.all && opts.own, { all: false, own: true }, "Only the commits on the current branch that main/master doesn't have yet"],
      ])}
      {seg("Remote branches", [["Remotes", opts.remotes, { remotes: !opts.remotes }]])}
      {seg("Sort", [["By date", opts.by_date, { by_date: true }], ["Ancestor order", !opts.by_date, { by_date: false }]])}
    </div>
  );
}

/** What the search box looks at: [field, menu label, placeholder]. */
const FIELDS: [SearchIn, string, string][] = [
  ["All", "All", "Message, author or id"],
  ["Message", "Message", "Words in the message"],
  ["Author", "Author", "Name or email"],
  ["Id", "Commit id", "Start of the id"],
  ["File", "File or folder", "Part of a path, e.g. App.tsx"],
];

/** Search box for the commit table: a field picker (message, author, id, file or folder) plus the text.
 *  Enter / Shift+Enter step through the matches. */
export function CommitSearch({ path, opts, sel, onSelect, onHits }: {
  path: string; opts: GraphOpts; sel: Picked | null; onSelect: (p: Picked) => void; onHits: (h: Set<string>) => void;
}) {
  const [q, setQ] = useState("");
  const [field, setField] = useState<SearchIn>("All");
  const [term, setTerm] = useState("");
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const { data, isFetching, error } = useQuery({
    queryKey: ["graph-search", path, opts, field, term], queryFn: () => graphSearch(path, opts, field, term), enabled: !!term,
  });
  const hits = term ? data ?? [] : [];
  // Highlight every result; jump to the first only for a new search, not a refetch after a repo change.
  const jumped = useRef("");
  useEffect(() => {
    onHits(new Set(hits.map((h) => h[1])));
    if (!term) jumped.current = "";
    const key = `${JSON.stringify(opts)}|${field}|${term}`;
    if (!data || jumped.current === key) return;
    jumped.current = key;
    if (hits.length) onSelect({ i: hits[0][0], oid: hits[0][1] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, term, field]);
  const at = hits.findIndex((h) => h[1] === sel?.oid);
  function step(d: 1 | -1) {
    if (!hits.length) return;
    const from = sel?.i ?? -1;
    const h = d > 0 ? hits.find((h) => h[0] > from) ?? hits[0] : [...hits].reverse().find((h) => h[0] < from) ?? hits[hits.length - 1];
    onSelect({ i: h[0], oid: h[1] });
  }
  const status = !term ? "" : error ? errorText(error) : isFetching && !data ? "Searching…"
    : !hits.length ? "No matches" : at >= 0 ? `${at + 1} of ${hits.length}` : `${hits.length} match${hits.length === 1 ? "" : "es"}`;
  return (
    <div className="commit-search" role="search">
      <label className="search-in" title="What to search">
        <select aria-label="Search in" value={field} onChange={(e) => { setField(e.target.value as SearchIn); document.getElementById("commit-search")?.focus(); }}>
          {FIELDS.map(([f, label]) => <option key={f} value={f}>{label}</option>)}
        </select>
        <Icon name="chevron" />
      </label>
      <label className="search">
        <Icon name="search" />
        <input id="commit-search" type="search" placeholder={FIELDS.find((f) => f[0] === field)![2]} aria-label="Search commits"
          title="Enter: next match, Shift+Enter: previous" spellCheck={false} autoComplete="off"
          value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
            else if (e.key === "Escape" && q) { e.preventDefault(); setQ(""); }
          }} />
      </label>
      {term && <>
        <span className="muted count" aria-live="polite">{status}</span>
        <button type="button" className="small ghost step" disabled={!hits.length} onClick={() => step(-1)} aria-label="Previous match" title={hits.length ? "Previous match (Shift+Enter)" : "No matches"}>▲</button>
        <button type="button" className="small ghost step" disabled={!hits.length} onClick={() => step(1)} aria-label="Next match" title={hits.length ? "Next match (Enter)" : "No matches"}>▼</button>
      </>}
    </div>
  );
}

/** Virtualized commit table: only the visible rows are in the DOM, their graph on one canvas. */
export function CommitGraph({ path, opts, sel, onSelect, onCompare, hits }: Props) {
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
  const [tip, setTip] = useState<{ i: number; col: number; names: string[] } | null>(null);

  /** Reset the current branch to commit `r` (row menu and its ref labels' menus). */
  function resetAction(r: GraphRow): Action {
    const at = r.oid.slice(0, 7);
    const target = branch ?? "HEAD";
    return [`Reset ${target} to here…`, async () => {
      const i = await choose(`Reset ${target} to ${at}`, r.head
        ? `${target} already points at “${r.summary}”, so only your uncommitted changes are affected. What should happen to them?`
        : `Moves ${target} to “${r.summary}”. Commits after it leave ${target}; Undo history (sidebar) can bring them back. What happens to the files?`,
        RESETS.map(([label, hint, tone]) => ({ label, hint, tone })), "branch");
      if (i < 0) return;
      const [label, hint, tone, mode] = RESETS[i];
      if (await confirm(`${label} reset ${target} to ${at}?`, `${hint} Undo history (sidebar) can reverse it.`, `${label} reset`, tone === "danger" ? "danger" : "warn"))
        run(() => resetTo(path, r.oid, mode), `Reset ${target} to ${at} (${mode.toLowerCase()})`);
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
      [`Merge ${at} into ${branch}`, async () => (await confirmMerge(at, branch)) && run(() => merge(path, r.oid, false), `Merged ${at} into ${branch}`), done],
      [`Rebase ${branch} onto ${at}`, async () => (await confirmRebase(branch, at)) && run(() => rebaseOnto(path, r.oid), `Rebased ${branch} onto ${at}`), done],
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
  }

  // Keep the picked row in view (keys, search jumps).
  const selI = sel?.i;
  useEffect(() => {
    const el = scroller.current;
    if (!el || selI === undefined) return;
    if (selI * ROW < el.scrollTop) el.scrollTop = selI * ROW;
    else if ((selI + 1) * ROW > el.scrollTop + el.clientHeight) el.scrollTop = (selI + 1) * ROW - el.clientHeight;
  }, [selI]);

  /** Branches a dot sits on: every branch label on the line up from it to a tip; local branches first. */
  function branchesOf(i: number, c: number): string[] {
    const tags = new Set(refsData?.tags.map((t) => t.name));
    const local = new Set(refsData?.local.map((b) => b.name));
    const out: string[] = [];
    // Scrolled-away pages are still in the query cache.
    const cached = (k: number) => rowAt(k) ?? qc.getQueryData<GraphPage>(["graph", path, opts, Math.floor(k / PAGE)])?.rows[k % PAGE];
    // Follows the straight line, else the curve in (a merged-in lane leads to its merge commit). Stops at a tip or an unloaded page.
    for (let k = i; ; k--) {
      const row = cached(k);
      if (!row) break;
      if (row.col === c) out.push(...row.refs.filter((n) => !tags.has(n)));
      const up = row.edges.find(([a, b]) => a === c && b === c) ?? row.edges.find(([, b]) => b === c);
      if (!up) break;
      c = up[0];
    }
    return out.sort((a, b) => +local.has(b) - +local.has(a));
  }

  /** Hovering a dot shows its branch; only re-renders when the hovered dot changes. The row starts where the canvas does. */
  function hoverDot(e: React.MouseEvent<HTMLDivElement>, i: number, r: GraphRow) {
    const near = Math.abs(e.clientX - e.currentTarget.getBoundingClientRect().left - x(r.col)) <= 7 && r.col < MAX_LANES;
    if (!near) { if (tip) setTip(null); return; }
    if (tip?.i === i) return;
    const names = branchesOf(i, r.col);
    setTip(names.length ? { i, col: r.col, names } : null);
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
              className={`grow${sel?.oid === r.oid ? " sel" : ""}${r.head ? " head" : ""}${hits?.has(r.oid) ? " hit" : ""}`}
              style={{ ...cols, top: i * ROW, height: ROW }} onClick={(e) => ((e.ctrlKey || e.metaKey) && onCompare && sel && sel.oid !== r.oid ? onCompare : onSelect)({ i, oid: r.oid })} onContextMenu={(e) => rowMenu(e, i, r)}
              onMouseMove={(e) => hoverDot(e, i, r)} onMouseLeave={() => tip && setTip(null)}>
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
          {tip && tip.i >= first && tip.i <= last && (
            <div className="dot-tip" role="tooltip" style={{ top: tip.i * ROW + ROW / 2, left: x(tip.col) + 10, borderColor: color(tip.col) }}>
              {tip.names.join(", ")}
            </div>
          )}
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
