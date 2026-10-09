import { useEffect, useRef } from "react";

// Home screen backdrop: the artwork (src/assets/app_bg.jpg) brought to life. A canvas laid over it, mapped
// to the image's own pixels (same "cover" fit), draws only light: commits climb a fan strand from the bottom,
// flash the focus where the fan starts, then spread out across the mesh node to node. Mesh nodes twinkle,
// dust rises, and the whole layer drifts and follows the pointer a little (parallax).
// Reduced motion: the still artwork only.

const IW = 1354, IH = 768; // artwork size
const F = { x: 684, y: 602 }; // the focus, where the fan hangs from
// Mesh nodes, found as bright peaks in the artwork.
const NODES = [
  [28, 460], [38, 508], [46, 394], [82, 369], [102, 416], [104, 585], [147, 529], [173, 393], [191, 464], [238, 435],
  [244, 470], [249, 531], [295, 426], [314, 481], [342, 392], [347, 533], [395, 491], [418, 496], [445, 409], [482, 453],
  [491, 385], [513, 364], [546, 422], [561, 507], [658, 500], [779, 403], [777, 473], [872, 486],
].map(([x, y]) => ({ x, y }));
const PULSES = 9;
const DUST = 36;
const SPEED = 150; // artwork px per second
const SHIFT = 14; // max parallax, px

type Pt = { x: number; y: number };
type Route = { pts: Pt[]; len: number[]; at: number }; // polyline, cumulative lengths, index where it passes F
type Pulse = { r: Route; d: number; v: number; wait: number; hit: boolean };

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const quad = (a: Pt, c: Pt, b: Pt, n: number) =>
  Array.from({ length: n }, (_, i) => {
    const t = (i + 1) / n, u = 1 - t;
    return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
  });

// Each node's 3 nearest, the same lines the artwork draws.
const NEAR = NODES.map((a, i) =>
  NODES.map((b, j) => [j, dist(a, b)] as const).filter(([j]) => j !== i).sort((p, q) => p[1] - q[1]).slice(0, 3).map(([j]) => j));

/** Up a fan strand into the focus, a curve out of it, then a random walk that always moves away from it.
 * Built focus-ward (a walk toward the focus is easier to steer), then reversed. */
function route(): Route {
  let i = Math.floor(Math.random() * 12); // start on the left of the mesh
  const pts: Pt[] = [NODES[i]];
  for (;;) {
    const n = NODES[i];
    if (dist(n, F) < 200 || (n.y > 480 && Math.random() < 0.3)) break; // close enough, or a long feeder from low on the mesh
    const next = NEAR[i].filter((j) => dist(NODES[j], F) < dist(n, F));
    if (!next.length) break;
    i = next[Math.floor(Math.random() * next.length)];
    pts.push(NODES[i]);
  }
  const s = pts[pts.length - 1];
  pts.push(...quad(s, { x: F.x + (s.x - F.x) * 0.1, y: s.y + (F.y - s.y) * 0.5 }, F, 24)); // arrives steeply from above
  const end = { x: 500 + Math.random() * 380, y: IH + 20 };
  pts.push(...quad(F, { x: F.x + (end.x - F.x) * 0.08, y: 690 }, end, 24)); // fan: tight neck, then flaring
  pts.reverse();
  const at = 24; // the fan's 24 points come first now, then F
  const len = [0];
  for (let k = 1; k < pts.length; k++) len.push(len[k - 1] + dist(pts[k - 1], pts[k]));
  return { pts, len, at };
}

/** Point at distance d along a route. */
function along(r: Route, d: number): Pt {
  let k = 1;
  while (k < r.len.length - 1 && r.len[k] < d) k++;
  const a = r.pts[k - 1], b = r.pts[k], t = Math.min(1, Math.max(0, (d - r.len[k - 1]) / (r.len[k] - r.len[k - 1] || 1)));
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

const spawn = (wait: number): Pulse => ({ r: route(), d: 0, v: SPEED * (0.8 + Math.random() * 0.4), wait, hit: false });

export function Backdrop() {
  const art = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current!, layer = art.current!;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)");
    const phase = NODES.map(() => [Math.random() * 7, 0.3 + Math.random() * 0.5]);
    const dust = Array.from({ length: DUST }, () => ({ x: Math.random() * IW, y: Math.random() * IH, r: 0.5 + Math.random() * 1.2, v: 4 + Math.random() * 10, ph: Math.random() * 7 }));
    const pulses = Array.from({ length: PULSES }, (_, i) => spawn(i * 0.9));
    const rings: number[] = []; // flash start times at the focus
    const ptr = { x: 0, y: 0 }, cam = { x: 0, y: 0 };
    let w = 0, h = 0, s = 1, ox = 0, oy = 0, raf = 0, last = 0, time = 0;

    // Same fit as `background-size: cover; background-position: center`.
    function setup() {
      w = cv.clientWidth; h = cv.clientHeight;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      s = Math.max(w / IW, h / IH); ox = (w - IW * s) / 2; oy = (h - IH * s) / 2;
    }
    const X = (x: number) => ox + x * s, Y = (y: number) => oy + y * s;
    function glow(x: number, y: number, r: number, a: number) {
      const g = ctx!.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgb(255 255 255 / ${a})`); g.addColorStop(0.35, `rgb(200 215 255 / ${a * 0.35})`); g.addColorStop(1, "rgb(200 215 255 / 0)");
      ctx!.fillStyle = g;
      ctx!.fillRect(x - r, y - r, r * 2, r * 2);
    }

    function draw() {
      ctx!.clearRect(0, 0, w, h);
      ctx!.globalCompositeOperation = "lighter";

      for (const d of dust) {
        ctx!.fillStyle = `rgb(220 230 255 / ${0.12 + 0.12 * Math.sin(time * 0.8 + d.ph)})`;
        ctx!.beginPath(); ctx!.arc(X(d.x + Math.sin(time * 0.3 + d.ph) * 8), Y(d.y), d.r * s, 0, Math.PI * 2); ctx!.fill();
      }
      // Twinkle: mostly faint, now and then one node flares.
      NODES.forEach((n, i) => {
        const [ph, f] = phase[i];
        glow(X(n.x), Y(n.y), 14 * s, 0.06 + 0.4 * Math.max(0, Math.sin(time * f + ph)) ** 6);
      });
      // Focus: breathing, plus a ring for each commit that arrives.
      glow(X(F.x), Y(F.y), 34 * s, 0.22 + 0.08 * Math.sin(time * 1.6));
      for (let i = rings.length - 1; i >= 0; i--) {
        const k = (time - rings[i]) / 1.3;
        if (k >= 1) { rings.splice(i, 1); continue; }
        const e = 1 - (1 - k) ** 3;
        glow(X(F.x), Y(F.y), (18 + 30 * e) * s, 0.35 * (1 - k));
        ctx!.strokeStyle = `rgb(220 230 255 / ${0.45 * (1 - k)})`;
        ctx!.lineWidth = 1;
        ctx!.beginPath(); ctx!.arc(X(F.x), Y(F.y), (4 + 40 * e) * s, 0, Math.PI * 2); ctx!.stroke();
      }
      // Commits: a bright head with a fading tail.
      for (const p of pulses) {
        if (p.wait > 0) continue;
        const total = p.r.len[p.r.len.length - 1];
        const fade = Math.min(1, p.d / 160, (total - p.d) / 40); // in from the fan's bottom, out at the last node
        for (let k = 7; k >= 0; k--) {
          const q = along(p.r, p.d - k * 7);
          const a = fade * (1 - k / 8) ** 2;
          if (k === 0) glow(X(q.x), Y(q.y), 12 * s, 0.6 * fade);
          ctx!.fillStyle = `rgb(235 240 255 / ${a})`;
          ctx!.beginPath(); ctx!.arc(X(q.x), Y(q.y), (1.6 - k * 0.12) * s, 0, Math.PI * 2); ctx!.fill();
        }
      }
      ctx!.globalCompositeOperation = "source-over";
    }

    function tick(dt: number) {
      for (const d of dust) { d.y -= d.v * dt; if (d.y < -5) { d.y = IH + 5; d.x = Math.random() * IW; } }
      pulses.forEach((p, i) => {
        if (p.wait > 0) { p.wait -= dt; return; }
        const before = p.d < p.r.len[p.r.at];
        p.d += p.v * dt * (p.d < p.r.len[p.r.at] ? 1.6 : 1); // quick up the fan, slower across the mesh
        if (before && p.d >= p.r.len[p.r.at]) rings.push(time);
        if (p.d - 56 > p.r.len[p.r.len.length - 1]) pulses[i] = spawn(Math.random() * 2);
      });
      // Camera: a slow idle drift plus the pointer, eased.
      const tx = ptr.x * SHIFT + Math.sin(time * 0.11) * 4, ty = ptr.y * SHIFT + Math.cos(time * 0.09) * 3;
      cam.x += (tx - cam.x) * Math.min(1, dt * 2.5); cam.y += (ty - cam.y) * Math.min(1, dt * 2.5);
      layer.style.translate = `${cam.x.toFixed(2)}px ${cam.y.toFixed(2)}px`;
    }

    function frame(t: number) {
      const dt = Math.min(t - last, 50) / 1000;
      last = t;
      time += dt;
      tick(dt);
      draw();
      raf = requestAnimationFrame(frame);
    }
    // Animates only while visible and focused, never under reduced motion.
    function sync() {
      cancelAnimationFrame(raf);
      raf = 0;
      if (still.matches) { ctx!.clearRect(0, 0, w, h); layer.style.translate = ""; return; }
      if (document.hidden || !document.hasFocus()) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
    const resize = () => { setup(); if (!raf && !still.matches) draw(); };
    const move = (e: PointerEvent) => { ptr.x = -(e.clientX / innerWidth - 0.5) * 2; ptr.y = -(e.clientY / innerHeight - 0.5) * 2; };
    setup();
    sync();
    addEventListener("resize", resize);
    addEventListener("pointermove", move);
    addEventListener("focus", sync);
    addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
    still.addEventListener("change", sync);
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener("resize", resize);
      removeEventListener("pointermove", move);
      removeEventListener("focus", sync);
      removeEventListener("blur", sync);
      document.removeEventListener("visibilitychange", sync);
      still.removeEventListener("change", sync);
    };
  }, []);

  return (
    <div className="home-bg" aria-hidden="true">
      <div className="home-art" ref={art}><canvas ref={ref} /></div>
    </div>
  );
}
