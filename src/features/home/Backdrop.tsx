import { useEffect, useRef, type CSSProperties } from "react";

// Home screen backdrop. On a radial ground (CSS: .home::before):
// - canvas, drawn in depth toward one vanishing point (the focus): a drifting node mesh across the
//   left whose curves all gather into the focus, a fan of lines hanging from it (the tree), pulses
//   that ride in along the curves and down the fan,
//   a large engraved branch mark in a ring at the top right, and dust drifting at two depths;
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

// Point of view: the mesh lies on a plane that recedes toward the focus, its vanishing point.
// k is nearness (1 at the viewer, falling with depth); size, brightness and line weight scale
// with it. Depth of field: b is how far a node sits off the focal plane, which softens it.
type Node = { x: number; y: number; k: number; b: number; r: number; glow: boolean; ph: number; f: number };
type Strand = { x: number; y: number; cx: number; cy: number }; // end point + control, focus at the other end
type Feeder = { node: number } | { x: number; y: number }; // a mesh node, or an anchor off the left edge
type Pulse = { f: number; s: number; t: number; v: number }; // rides feeder f into the focus, then strand s down
type Dust = { x: number; y: number; r: number; a: number; ph: number; f: number };

const DEPTHS = [1.6, 2, 2.5, 3.1, 3.9, 5]; // mesh rows, by distance from the viewer
const SPOKES = 9; // nodes per row, fanned around the focus
const FOCAL = 0.55; // nearness that is in sharp focus
const STRANDS = 120;
const ANCHORS = 4;
const PULSES = 12;
const DUST = 30;
const DRIFT = 5; // px

/** Point on a cubic Bézier. */
function cubic(a: number, b: number, c: number, d: number, t: number) {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}

function scene(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const rand = rng(7);
  const ink = document.documentElement.dataset.theme === "dark" ? "255 255 255" : "40 40 60";
  const c = (a: number) => `rgb(${ink} / ${a})`;
  const F = { x: w * 0.5, y: h * 0.78 }; // the focus point

  // Network: rows at increasing depth, each projected toward the focus (distance / z), the plane
  // seen at a slant (y squashed). Spokes span from above-right of the focus round to the left edge.
  // Rows get tighter and nearer the focus as they recede. Each node joins its 3 nearest on screen.
  const nodes: Node[] = DEPTHS.flatMap((z0) => Array.from({ length: SPOKES }, (_, j) => {
    const a = ((95 + (j + 0.15 + rand() * 0.7) * (100 / SPOKES)) * Math.PI) / 180;
    const z = z0 * (0.9 + rand() * 0.2), d = (w * 1.05) / z;
    const x = F.x + Math.cos(a) * d, y = F.y - Math.sin(a) * d * 0.4;
    const k = Math.min(1, 1.6 / z), b = Math.min(1, Math.max(0, Math.abs(k - FOCAL) - 0.12) / 0.3);
    return { x, y, k, b, r: (0.8 + rand() * 0.4) * (0.7 + 2.6 * k), glow: rand() < 0.6, ph: rand() * Math.PI * 2, f: 0.15 + rand() * 0.25 };
  })).filter((n) => n.x > -w * 0.06 && n.x < w * 0.58 && n.y > h * 0.36 && Math.hypot(n.x - F.x, n.y - F.y) > w * 0.08);
  const links: [number, number][] = [];
  nodes.forEach((a, i) => {
    nodes
      .map((b, j) => [j, (a.x - b.x) ** 2 + (a.y - b.y) ** 2] as const)
      .filter(([j]) => j !== i)
      .sort((p, q) => p[1] - q[1])
      .slice(0, 3)
      .forEach(([j]) => { if (i < j || !links.some(([p, q]) => p === j && q === i)) links.push([i, j]); });
  });
  // Feeders: long curves that gather everything into the focus. Anchors sweep in from off the left
  // edge; the mesh nodes nearest the focus drop straight in.
  const dist = (n: Node) => Math.hypot(n.x - F.x, n.y - F.y);
  const feeders: Feeder[] = [
    ...Array.from({ length: ANCHORS }, (_, i) => ({ x: -w * 0.02, y: h * (0.56 + (i / (ANCHORS - 1)) * 0.16 + (rand() - 0.5) * 0.03) })),
    ...nodes.map((_, i) => i).sort((p, q) => dist(nodes[p]) - dist(nodes[q])).slice(0, 7).map((node) => ({ node })),
  ];

  // Fan, the tree: strands hang from the focus, a tight neck that flares and fades toward the bottom.
  const strands: Strand[] = Array.from({ length: STRANDS }, (_, i) => {
    const u = (i / (STRANDS - 1)) * 2 - 1;
    const x = F.x + u * w * (u < 0 ? 0.25 : 0.2) + (rand() - 0.5) * 10;
    return { x, y: h + 10, cx: F.x + (x - F.x) * 0.06, cy: F.y + (h - F.y) * (0.5 + rand() * 0.1) };
  });
  const pulses: Pulse[] = Array.from({ length: PULSES }, () => ({
    f: Math.floor(rand() * feeders.length), s: Math.floor(rand() * STRANDS), t: rand() * 2, v: 0.12 + rand() * 0.1,
  }));
  // Dust at two depths: fine far specks, and a few big out-of-focus discs (bokeh) near the viewer.
  const dust: Dust[] = Array.from({ length: DUST }, () => {
    const near = rand() < 0.2;
    return {
      x: w * (0.02 + rand() * 0.76), y: h * (0.06 + rand() * 0.88), r: near ? 6 + rand() * 12 : 0.4 + rand() * 0.9,
      a: near ? 0.025 + rand() * 0.035 : 0.15 + rand() * 0.35, ph: rand() * 7, f: near ? 0.03 + rand() * 0.04 : 0.05 + rand() * 0.1,
    };
  });

  // Branch mark, static, so it's drawn once offscreen: a ring of fine concentric grooves around
  // two branch tips joining one stem, each stroke an outlined tube with diagonal hatching inside.
  const R = Math.min(w * 0.16, h * 0.25);
  const M = { x: w * 0.9, y: h * 0.2 };
  const dpr = ctx.getTransform().a;
  const mark = document.createElement("canvas");
  mark.width = mark.height = Math.ceil(R * 2.3 * dpr);
  const mc = mark.getContext("2d")!;
  mc.scale(dpr, dpr);
  mc.translate(R * 1.15, R * 1.15);
  const ringW = R * 0.16;
  mc.strokeStyle = c(0.4);
  mc.lineWidth = 1;
  for (let i = 0; i <= 8; i++) { mc.beginPath(); mc.arc(0, 0, R - ringW / 2 + (ringW * i) / 8, 0, Math.PI * 2); mc.stroke(); }
  const k = R * 0.32, tube = R * 0.1;
  const branch = new Path2D();
  branch.arc(-k, -k * 0.9, k * 0.38, 0, Math.PI * 2);
  branch.moveTo(k + k * 0.38, -k * 0.9);
  branch.arc(k, -k * 0.9, k * 0.38, 0, Math.PI * 2);
  branch.moveTo(-k, -k * 0.52); branch.lineTo(-k, k * 1.6);
  branch.moveTo(k, -k * 0.52); branch.bezierCurveTo(k, k * 0.5, -k, k * 0.2, -k, k * 1.1);
  const tile = document.createElement("canvas");
  tile.width = tile.height = 5;
  const tc = tile.getContext("2d")!;
  tc.strokeStyle = c(0.35);
  tc.beginPath(); tc.moveTo(0, 5); tc.lineTo(5, 0); tc.stroke();
  mc.lineCap = "round";
  mc.lineWidth = tube; mc.strokeStyle = c(0.45); mc.stroke(branch);
  mc.globalCompositeOperation = "destination-out"; // hollow the tube, leaving its two edges
  mc.lineWidth = tube - 2.4; mc.strokeStyle = "#000"; mc.stroke(branch);
  mc.globalCompositeOperation = "source-over";
  mc.strokeStyle = mc.createPattern(tile, "repeat")!; mc.stroke(branch);
  // Fade out toward the bottom left, so the ring dissolves before it reaches the recent list.
  const fade = mc.createLinearGradient(R * 0.2, -R * 0.2, -R * 0.55, R * 1.05);
  fade.addColorStop(0, "#000"); fade.addColorStop(0.45, "rgb(0 0 0 / 0.8)"); fade.addColorStop(1, "rgb(0 0 0 / 0)");
  mc.globalCompositeOperation = "destination-in";
  mc.fillStyle = fade;
  mc.fillRect(-R * 1.15, -R * 1.15, R * 2.3, R * 2.3);


  const at = (n: Node, t: number) => ({ x: n.x + Math.sin(t * n.f + n.ph) * DRIFT, y: n.y + Math.cos(t * n.f * 1.3 + n.ph) * DRIFT });
  // Feeder curve from its start S into F, arriving steeply from above.
  const feed = (S: { x: number; y: number }) => [S, { x: S.x + (F.x - S.x) * 0.55, y: S.y + (F.y - S.y) * 0.15 }, { x: F.x + (S.x - F.x) * 0.05, y: F.y - h * 0.1 }, F];
  const on = (s: Strand, t: number) => {
    const u = 1 - t; // t: 0 at the bottom, 1 at the focus
    return { x: u * u * s.x + 2 * u * t * s.cx + t * t * F.x, y: u * u * s.y + 2 * u * t * s.cy + t * t * F.y };
  };

  function draw(t: number) {
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = "round";

    ctx.globalAlpha = 0.5;
    ctx.drawImage(mark, M.x - R * 1.15, M.y - R * 1.15, R * 2.3, R * 2.3);
    ctx.globalAlpha = 1;

    // Dust, drifting slowly.
    for (const d of dust) {
      const x = d.x + Math.sin(t * d.f + d.ph) * 12, y = d.y + Math.cos(t * d.f * 0.8 + d.ph) * 8;
      if (d.r > 1.5) {
        const g = ctx.createRadialGradient(x, y, 0, x, y, d.r);
        g.addColorStop(0, c(d.a)); g.addColorStop(1, c(0));
        ctx.fillStyle = g;
      } else ctx.fillStyle = c(d.a);
      ctx.beginPath(); ctx.arc(x, y, d.r, 0, Math.PI * 2); ctx.fill();
    }

    // Mesh links: nearer ones heavier and brighter; off the focal plane, a wide faint pass softens them.
    const P = nodes.map((n) => at(n, t));
    for (const [a, b] of links) {
      const k = (nodes[a].k + nodes[b].k) / 2, bl = (nodes[a].b + nodes[b].b) / 2, al = (0.1 + 0.24 * k) * (1 - 0.45 * bl);
      ctx.beginPath(); ctx.moveTo(P[a].x, P[a].y); ctx.lineTo(P[b].x, P[b].y);
      if (bl > 0.3) { ctx.lineWidth = 2 + 4 * bl; ctx.strokeStyle = c(al * 0.22); ctx.stroke(); }
      ctx.lineWidth = 0.6 + 0.9 * k * (1 - 0.5 * bl);
      ctx.strokeStyle = c(al);
      ctx.stroke();
    }

    // Feeders, brightening as they converge.
    const starts = feeders.map((f) => ("node" in f ? P[f.node] : f));
    ctx.lineWidth = 1;
    for (const S of starts) {
      const [, b, d] = feed(S);
      const g = ctx.createLinearGradient(S.x, S.y, F.x, F.y);
      g.addColorStop(0, c(0.08)); g.addColorStop(1, c(0.4));
      ctx.strokeStyle = g;
      ctx.beginPath(); ctx.moveTo(S.x, S.y); ctx.bezierCurveTo(b.x, b.y, d.x, d.y, F.x, F.y); ctx.stroke();
    }

    // Fan strands: each faint, together a bright neck under the focus, fading out downward.
    const fade = ctx.createLinearGradient(0, F.y, 0, h);
    fade.addColorStop(0, c(0.3)); fade.addColorStop(0.5, c(0.09)); fade.addColorStop(1, c(0.01));
    ctx.strokeStyle = fade;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (const s of strands) { ctx.moveTo(s.x, s.y); ctx.quadraticCurveTo(s.cx, s.cy, F.x, F.y); }
    ctx.stroke();

    // Nodes: in focus, a sharp dot with a tight halo on some; off the focal plane, a soft disc.
    for (let i = 0; i < nodes.length; i++) {
      const { x, y } = P[i], n = nodes[i];
      if (n.b > 0.25) {
        const rr = n.r * (2 + 4 * n.b), a = (0.4 + 0.4 * n.k) * (1 - 0.4 * n.b);
        const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
        g.addColorStop(0, c(a)); g.addColorStop(0.5, c(a * 0.6)); g.addColorStop(1, c(0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.fill();
        continue;
      }
      if (n.glow) {
        const g = ctx.createRadialGradient(x, y, 0, x, y, n.r * 4);
        g.addColorStop(0, c(0.2 + 0.15 * n.k)); g.addColorStop(1, c(0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, n.r * 4, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = c(0.7 + 0.3 * n.k);
      ctx.beginPath(); ctx.arc(x, y, n.r, 0, Math.PI * 2); ctx.fill();
    }

    // Pulses: along a feeder into the focus (t 0..1), then down a strand (t 1..2).
    ctx.fillStyle = c(0.9);
    for (const p of pulses) {
      let q;
      if (p.t < 1) {
        const [a, b, d, e] = feed(starts[p.f]);
        q = { x: cubic(a.x, b.x, d.x, e.x, p.t), y: cubic(a.y, b.y, d.y, e.y, p.t) };
      } else q = on(strands[p.s], 2 - p.t);
      ctx.globalAlpha = Math.sin((p.t / 2) * Math.PI) * 0.8;
      ctx.beginPath(); ctx.arc(q.x, q.y, 1.3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Focus: a small bright node with a tight glow.
    const core = ctx.createRadialGradient(F.x, F.y, 0, F.x, F.y, 16);
    core.addColorStop(0, c(0.55)); core.addColorStop(1, c(0));
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(F.x, F.y, 16, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = c(0.95);
    ctx.beginPath(); ctx.arc(F.x, F.y, 3, 0, Math.PI * 2); ctx.fill();
  }

  function tick(dt: number) {
    for (const p of pulses) {
      p.t += p.v * dt;
      if (p.t >= 2) { p.t = 0; p.f = Math.floor(Math.random() * feeders.length); p.s = Math.floor(Math.random() * STRANDS); }
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
    // Animates only while shown (dark theme hides it for the image), visible, focused, and never under reduced motion.
    function sync() {
      cancelAnimationFrame(raf);
      raf = 0;
      if (still.matches || document.hidden || !document.hasFocus() || !cv.offsetParent) return;
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
        <span key={`${l}${t}`} className={`bg-float ${kind}`} style={{ left: `${l}%`, top: `${t}%`, animationDelay: `-${d}s`, "--ry": `${l < 50 ? 12 : -12}deg` } as CSSProperties}>
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
