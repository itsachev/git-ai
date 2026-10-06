import { useLayoutEffect, useRef } from "react";

/**
 * Drag handle between two panes of a grid. Sets `--<name>` (px) on the parent from the size of the
 * pane before it; the parent's grid template uses that variable. Kept per name in localStorage.
 * Arrow keys nudge, double-click resets to the CSS default.
 */
export function Splitter({ name, axis, label }: { name: string; axis: "x" | "y"; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ from: number; size: number } | null>(null);
  const key = `split:${name}`;
  const prop = `--${name}`;

  useLayoutEffect(() => {
    let v: string | null = null;
    try { v = localStorage.getItem(key); } catch { /* storage blocked */ }
    if (v) ref.current!.parentElement!.style.setProperty(prop, `${v}px`);
  }, [key, prop]);

  const set = (px: number | null) => {
    const parent = ref.current!.parentElement!;
    if (px === null) {
      parent.style.removeProperty(prop);
      try { localStorage.removeItem(key); } catch { /* storage blocked */ }
      return;
    }
    // Leave the other pane at least 160 px.
    const total = axis === "x" ? parent.clientWidth : parent.clientHeight;
    const v = Math.round(Math.max(120, Math.min(px, total - 160)));
    parent.style.setProperty(prop, `${v}px`);
    try { localStorage.setItem(key, String(v)); } catch { /* storage blocked */ }
  };
  const size = () => {
    const r = ref.current!.previousElementSibling!.getBoundingClientRect();
    return axis === "x" ? r.width : r.height;
  };
  const pos = (e: React.PointerEvent) => (axis === "x" ? e.clientX : e.clientY);

  return (
    <div ref={ref} className={`split split-${axis}`} role="separator" tabIndex={0} aria-label={label}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { from: pos(e), size: size() }; }}
      onPointerMove={(e) => { if (drag.current) set(drag.current.size + pos(e) - drag.current.from); }}
      onPointerUp={() => { drag.current = null; }}
      onDoubleClick={() => set(null)}
      onKeyDown={(e) => {
        const step = { ArrowLeft: -16, ArrowUp: -16, ArrowRight: 16, ArrowDown: 16 }[e.key];
        if (step) { e.preventDefault(); set(size() + step); }
      }} />
  );
}
