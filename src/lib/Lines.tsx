import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

/** Up to this many rows, every row renders, so find-in-page and copying a long selection still work. */
const ALL = 1500;
/** Rows rendered above and below the viewport. */
const OVER = 60;

type Props = {
  n: number;
  /** Row `i`, with its key. */
  row: (i: number) => ReactNode;
  /** True for hunk headers (row 0 always is one when given). They stick to the top while their lines scroll by. */
  hunk?: (i: number) => boolean;
  /** Longest row text in characters (see `widest`), plus any gutter wider than a diff's: keeps the horizontal scroll width steady. */
  width: number;
  /** Row to scroll to the top when it changes. */
  at?: number;
  className?: string;
  label: string;
};

/** Longest line in characters, a tab counted as 4 (the diff's tab-size). */
export function widest(lines: string[]) {
  let w = 0;
  for (const l of lines) w = Math.max(w, l.length + 3 * (l.split("\t").length - 1));
  return w;
}

/** The diff/blame `<pre>`. Past `ALL` rows only the rows near the viewport render, between two spacers.
 *  Row heights are measured once from the first rows: one for lines, one for hunk headers, plus `--hunk-gap`
 *  above every header but the first. */
export function Lines({ n, row, hunk, width, at, className, label }: Props) {
  const pre = useRef<HTMLPreElement>(null);
  const [view, setView] = useState({ top: 0, height: 0 });
  const [size, setSize] = useState<{ line: number; head: number; gap: number } | null>(null);
  const big = n > ALL;

  // ponytail: measured once per mount; a WebView zoom while a big diff is open misplaces rows until the next file. Re-measure on zoom if that shows up.
  useLayoutEffect(() => {
    const el = pre.current;
    if (!big || size || !el) return;
    const [a, b] = [el.children[0], el.children[1]].map((c) => c.getBoundingClientRect());
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    setSize({ line: hunk ? b.height : a.height, head: b.top - a.top, gap: parseFloat(getComputedStyle(el).getPropertyValue("--hunk-gap")) * rem || 0 });
  }, [big, size, hunk]);

  useLayoutEffect(() => {
    const el = pre.current;
    if (!big || !el) return;
    const ro = new ResizeObserver(() => setView({ top: el.scrollTop, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [big]);

  // Top of each row; tops[n] is the total height.
  let tops: Float64Array | null = null;
  if (big && size) {
    tops = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) tops[i + 1] = tops[i] + (hunk?.(i) ? size.head + (i ? size.gap : 0) : size.line);
  }

  useLayoutEffect(() => {
    const el = pre.current;
    if (at === undefined || !el) return;
    if (tops) el.scrollTop = tops[at];
    else if (el.children[at]) el.scrollTop += el.children[at].getBoundingClientRect().top - el.getBoundingClientRect().top;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, !!tops]);

  let first = 0, last = n;
  if (big) last = Math.min(n, 2 * OVER); // until measured: enough rows to measure
  if (tops) {
    let lo = 0, hi = n; // first row whose bottom is below the viewport top
    while (lo < hi) { const m = (lo + hi) >> 1; if (tops[m + 1] <= view.top) lo = m + 1; else hi = m; }
    first = Math.max(0, lo - OVER);
    last = lo;
    while (last < n && tops[last] < view.top + view.height) last++;
    last = Math.min(n, last + OVER);
  }
  // The header of the hunk the first rendered row is in, when that header is above the window: it goes first so it
  // still sticks (and as the first child it has no gap above it).
  let h = -1;
  if (hunk && first > 0) for (h = first; h > 0 && !hunk(h); h--);
  const out: ReactNode[] = [];
  if (h >= 0 && h < first) out.push(row(h));
  const pad = tops ? tops[first] - (h >= 0 && h < first ? size!.head : 0) : 0;
  if (pad > 0) out.push(<div key="pad" aria-hidden="true" style={{ height: pad }} />);
  for (let i = first; i < last; i++) out.push(row(i));
  if (big) out.push(<div key="end" aria-hidden="true" style={{ height: tops ? tops[n] - tops[last] : 0, width: `calc(${width + 10}ch + 1.7rem)`, minWidth: 0 }} />);

  return (
    <pre ref={pre} className={big ? `rows ${className ?? ""}` : className} aria-label={label} onScroll={big ? (e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight }) : undefined}>
      {out}
    </pre>
  );
}
