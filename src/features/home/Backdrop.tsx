import { useEffect, useRef } from "react";

// Home screen backdrop. On a radial ground (CSS: .home::before):
// - canvas: a drifting node network on the left, a fan of lines that converge on one glowing
//   point below the hero (commits flowing into a merge, with light pulses travelling up them),
//   and a large hatched branch mark in a ring at the top right;
// - DOM: translucent "file" cards and blurred cubes floating on CSS animations.
// Layout is seeded, so it stays the same across resizes and theme flips.

/** Small seeded PRNG (mulberry32): same layout every time. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Node = { x: number; y: number; r: number; glow: boolean; ph: number; f: number };
type Strand = { x: number; y: number; cx: number; cy: number }; // end point + control, focus at the other end
type Pulse = { s: number; t: number; v: number };

const NODES = 46;
const STRANDS = 72;
const PULSES = 10;
const DRIFT = 5; // px

function scene(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const rand = rng(7);
  const css = getComputedStyle(document.documentElement);
  const ink = document.documentElement.dataset.theme === "dark" ? "255 255 255" : "40 40 60";
  const hex = css.getPropertyValue("--accent").trim().match(/^#(..)(..)(..)$/)?.slice(1) ?? ["5e", "5c", "e6"];
  const accent = (a: number) => `rgb(${hex.map((v) => parseInt(v, 16)).join(" ")} / ${a})`;
  const c = (a: number) => `rgb(${ink} / ${a})`;
  const F = { x: w * 0.5, y: h * 0.785 }; // the focus point

  // Network: nodes in a band across the left, each joined to its 3 nearest.
  const nodes: Node[] = Array.from({ length: NODES }, () => ({
    x: w * (-0.04 + rand() * 0.64),
    y: h * (0.4 + rand() * 0.42 + Math.max(0, rand() - 0.6) * 0.1),
    r: 1.4 + rand() * 2.4,
    glow: rand() < 0.25,
    ph: rand() * Math.PI * 2,
    f: 0.15 + rand() * 0.25,
  }));
  const links: [number, number][] = [];
  nodes.forEach((a, i) => {
    nodes
      .map((b, j) => [j, (a.x - b.x) ** 2 + (a.y - b.y) ** 2] as const)
      .filter(([j]) => j !== i)
      .sort((p, q) => p[1] - q[1])
      .slice(0, 3)
      .forEach(([j]) => { if (i < j || !links.some(([p, q]) => p === j && q === i)) links.push([i, j]); });
  });
  // The network's rightmost nodes also feed the focus.
  const feeders = nodes.map((_, i) => i).sort((p, q) => nodes[q].x - nodes[p].x).slice(0, 7);

  // Fan: strands from the focus down past the bottom edge, tight at the top, spread below.
  const strands: Strand[] = Array.from({ length: STRANDS }, (_, i) => {
    const u = i / (STRANDS - 1);
    const x = w * (0.18 + u * 0.66) + (rand() - 0.5) * 20;
    return { x, y: h + 10, cx: F.x + (x - F.x) * 0.15, cy: F.y + h * (0.1 + rand() * 0.08) };
  });
  const pulses: Pulse[] = Array.from({ length: PULSES }, () => ({ s: Math.floor(rand() * STRANDS), t: rand(), v: 0.08 + rand() * 0.1 }));

  // Hatch fill for the branch mark: thin diagonal lines.
  const tile = document.createElement("canvas");
  tile.width = tile.height = 6;
  const tc = tile.getContext("2d")!;
  tc.strokeStyle = c(0.5);
  tc.lineWidth = 1;
  tc.beginPath(); tc.moveTo(0, 6); tc.lineTo(6, 0); tc.stroke();
  const hatch = ctx.createPattern(tile, "repeat")!;
  const R = Math.min(w * 0.16, h * 0.25);
  const M = { x: w * 0.9, y: h * 0.2 };

  const at = (n: Node, t: number) => ({ x: n.x + Math.sin(t * n.f + n.ph) * DRIFT, y: n.y + Math.cos(t * n.f * 1.3 + n.ph) * DRIFT });
  const on = (s: Strand, t: number) => {
    const u = 1 - t; // t: 0 at the bottom, 1 at the focus
    return { x: u * u * s.x + 2 * u * t * s.cx + t * t * F.x, y: u * u * s.y + 2 * u * t * s.cy + t * t * F.y };
  };

  function draw(t: number) {
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = "round";

    // Branch mark: a hatched ring with two branch tips joining one stem.
    ctx.save();
    ctx.translate(M.x, M.y);
    ctx.strokeStyle = hatch;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = R * 0.14;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
    const k = R * 0.32;
    ctx.lineWidth = R * 0.09;
    ctx.beginPath();
    ctx.arc(-k, -k * 0.9, k * 0.38, 0, Math.PI * 2);
    ctx.moveTo(k + k * 0.38, -k * 0.9);
    ctx.arc(k, -k * 0.9, k * 0.38, 0, Math.PI * 2);
    ctx.moveTo(-k, -k * 0.52); ctx.lineTo(-k, k * 1.6);
    ctx.moveTo(k, -k * 0.52); ctx.bezierCurveTo(k, k * 0.5, -k, k * 0.2, -k, k * 1.1);
    ctx.stroke();
    ctx.restore();

    // Network links and the feeders into the focus.
    const P = nodes.map((n) => at(n, t));
    ctx.lineWidth = 1;
    ctx.strokeStyle = c(0.18);
    ctx.beginPath();
    for (const [a, b] of links) { ctx.moveTo(P[a].x, P[a].y); ctx.lineTo(P[b].x, P[b].y); }
    for (const i of feeders) {
      ctx.moveTo(P[i].x, P[i].y);
      ctx.quadraticCurveTo((P[i].x + F.x) / 2, F.y - h * 0.02, F.x, F.y);
    }
    ctx.stroke();

    // Fan strands: faint each, bright where they bundle at the focus.
    ctx.strokeStyle = c(0.09);
    ctx.beginPath();
    for (const s of strands) { ctx.moveTo(s.x, s.y); ctx.quadraticCurveTo(s.cx, s.cy, F.x, F.y); }
    ctx.stroke();

    // Nodes, some with a halo.
    for (let i = 0; i < nodes.length; i++) {
      const { x, y } = P[i], n = nodes[i];
      if (n.glow) {
        const g = ctx.createRadialGradient(x, y, 0, x, y, n.r * 5);
        g.addColorStop(0, c(0.35)); g.addColorStop(1, c(0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, n.r * 5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = c(n.glow ? 0.85 : 0.5);
      ctx.beginPath(); ctx.arc(x, y, n.r, 0, Math.PI * 2); ctx.fill();
    }

    // Pulses climbing the strands, and the focus glow they feed.
    ctx.fillStyle = c(0.9);
    for (const p of pulses) {
      const q = on(strands[p.s], p.t);
      ctx.globalAlpha = Math.sin(p.t * Math.PI);
      ctx.beginPath(); ctx.arc(q.x, q.y, 1.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    const g = ctx.createRadialGradient(F.x, F.y, 0, F.x, F.y, 90);
    g.addColorStop(0, accent(0.45)); g.addColorStop(1, accent(0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(F.x, F.y, 90, 0, Math.PI * 2); ctx.fill();
    const core = ctx.createRadialGradient(F.x, F.y, 0, F.x, F.y, 24);
    core.addColorStop(0, c(0.7)); core.addColorStop(1, c(0));
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(F.x, F.y, 24, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = c(0.95);
    ctx.beginPath(); ctx.arc(F.x, F.y, 2.5, 0, Math.PI * 2); ctx.fill();
  }

  function tick(dt: number) {
    for (const p of pulses) {
      p.t += p.v * dt;
      if (p.t >= 1) { p.t = 0; p.s = Math.floor(Math.random() * STRANDS); }
    }
  }

  return { draw, tick };
}

// Floating DOM pieces, in % of the window: [left, top, size or kind, float delay].
const CARDS: [number, number, "stack" | "single", number][] = [
  [28.5, 24, "stack", 0], [46, 52, "stack", 1.4], [58, 21, "single", 2.6],
];
const CUBES: [number, number, number, number][] = [ // left, top, px, blur px
  [60.5, 14.5, 18, 1], [37.5, 30, 12, 0], [40, 37, 13, 0.5], [13.5, 37.5, 20, 2], [20.5, 38, 14, 1.5],
  [52, 34.5, 14, 0.5], [45.5, 44.5, 12, 0], [52.5, 44.5, 12, 0.5], [23, 84, 26, 2.5], [8, 62, 16, 3], [70, 70, 22, 4],
];

export function Backdrop() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)");
    let s: ReturnType<typeof scene>, raf = 0, last = 0, time = 0;

    function setup() {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      cv.width = Math.round(innerWidth * dpr); cv.height = Math.round(innerHeight * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      s = scene(ctx!, innerWidth, innerHeight);
      s.draw(time);
    }
    function frame(t: number) {
      const dt = Math.min(t - last, 50) / 1000;
      last = t;
      time += dt;
      s.tick(dt);
      s.draw(time);
      raf = requestAnimationFrame(frame);
    }
    // Animates only while the window is visible and focused, and never under reduced motion.
    function sync() {
      cancelAnimationFrame(raf);
      raf = 0;
      if (still.matches || document.hidden || !document.hasFocus()) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
    const resize = () => { setup(); sync(); };
    const themed = new MutationObserver(resize); // ink color follows the theme
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    setup();
    sync();
    addEventListener("resize", resize);
    addEventListener("focus", sync);
    addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
    still.addEventListener("change", sync);
    return () => {
      cancelAnimationFrame(raf);
      themed.disconnect();
      removeEventListener("resize", resize);
      removeEventListener("focus", sync);
      removeEventListener("blur", sync);
      document.removeEventListener("visibilitychange", sync);
      still.removeEventListener("change", sync);
    };
  }, []);

  const card = <span className="bg-card"><i /><i /><i /><i /><i /></span>;
  return (
    <div className="home-bg" aria-hidden="true">
      <canvas ref={ref} />
      {CARDS.map(([l, t, kind, d]) => (
        <span key={`${l}${t}`} className={`bg-float ${kind}`} style={{ left: `${l}%`, top: `${t}%`, animationDelay: `-${d}s` }}>
          {kind === "stack" && card}
          {card}
        </span>
      ))}
      {CUBES.map(([l, t, px, blur], i) => (
        <span key={i} className="bg-cube" style={{ left: `${l}%`, top: `${t}%`, width: px, height: px, filter: blur ? `blur(${blur}px)` : undefined, animationDelay: `-${i * 0.7}s` }} />
      ))}
    </div>
  );
}
