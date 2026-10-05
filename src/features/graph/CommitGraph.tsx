import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { graphRows } from "../../lib/ipc";
import type { GraphRow } from "../../bindings/GraphRow";
import { errorText } from "../status/Changes";

const ROW = 24; // px, fixed so row i sits at i * ROW
const PAGE = 500;
const LANE = 14;
const MAX_LANES = 16; // wider graphs are clipped
const COLORS = ["#2563eb", "#16a34a", "#db2777", "#ca8a04", "#7c3aed", "#0891b2", "#ea580c", "#64748b"];
const color = (lane: number) => COLORS[lane % COLORS.length];
const x = (lane: number) => LANE / 2 + 3 + lane * LANE;
const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export type Picked = { i: number; oid: string };
type Props = { path: string; sel: Picked | null; onSelect: (p: Picked) => void };

/** Virtualized commit table: only the visible rows are in the DOM, their graph on one canvas. */
export function CommitGraph({ path, sel, onSelect }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState({ top: 0, height: 0 });

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
    queries: pageIds.map((p) => ({ queryKey: ["graph", path, p], queryFn: () => graphRows(path, p * PAGE, PAGE) })),
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
    const bg = getComputedStyle(c).getPropertyValue("--surface");
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
        <span>Graph</span><span>Description</span><span className="c-date">Date</span><span className="c-author">Author</span><span className="c-oid">Commit</span>
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
              style={{ ...cols, top: i * ROW, height: ROW }} onClick={() => onSelect({ i, oid: r.oid })}>
              <span />
              <span className="desc">
                {r.refs.map((n) => <span key={n} className="ref">{n}</span>)}
                <span className="sum">{r.summary}</span>
              </span>
              <span className="c-date">{dateFmt.format(r.time * 1000)}</span>
              <span className="c-author">{r.author}</span>
              <span className="c-oid">{r.oid.slice(0, 7)}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
