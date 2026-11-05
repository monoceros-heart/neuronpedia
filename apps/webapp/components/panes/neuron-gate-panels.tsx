'use client';

import { GatePoint, gatePoints, quadrantOf, quadrantShares, silu } from '@/lib/utils/neuron-dashboard-panels';
import { NeuronDashboard } from '@/lib/utils/neuron-dashboards';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Raw SwiGLU neuron panels drawn from the dashboard file's record: the gate curve and the g/u product
// plane with every example placed by its g and u at the peak token, the share of scanned tokens in each
// sign quadrant, and the closed-gate echo examples. Ported from fork PR #1's gate-value pane, which read
// g and u from database rows; here they come from the record, so any set with dashboard files gets them.

type Point = GatePoint;
type Hit = { x: number; y: number; i: number };
type Tip = { chart: 'curve' | 'plane'; x: number; y: number; w: number; point?: Point; text?: string } | null;

const POS = [16, 185, 129]; // emerald-500, the positive pole's colour in the activation lists
const NEG = [244, 63, 94]; // rose-500
const MID = [241, 245, 249]; // slate-100
const INK = '#1e293b';
const MUTED = '#64748b';
const RULE = '#e2e8f0';
const SILU_MIN_G = -1.2785;
const TIP_WIDTH = 320;

const rgb = (c: number[]) => `rgb(${c.join(',')})`;
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const fmt = (x: number, d = 2) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(d);
const fmtA = (a: number) => fmt(a, Math.abs(a) >= 10 ? 1 : 3);

function niceTicks(lo: number, hi: number, n = 5) {
  const span = hi - lo;
  const mag = 10 ** Math.floor(Math.log10(span / n));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => span / s <= n) || mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.abs(v) < 1e-9 ? 0 : v);
  return out;
}

function tickLabel(v: number) {
  const s = Math.abs(v) >= 10 || Number.isInteger(v) ? Math.abs(v).toFixed(0) : Math.abs(v).toFixed(1);
  return (v < 0 ? '−' : '') + s;
}

function setup(cv: HTMLCanvasElement) {
  const r = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, p: Point, big: boolean) {
  const echo = p.kind === 'echo_top' || p.kind === 'echo_bottom';
  ctx.lineWidth = 2;
  // Echoes (closed-gate examples) are hollow, so they read apart from the open-gate peaks.
  ctx.fillStyle = echo ? '#fff' : rgb(p.a >= 0 ? POS : NEG);
  ctx.strokeStyle = echo ? rgb(p.a >= 0 ? POS : NEG) : '#fff';
  ctx.beginPath();
  ctx.arc(x, y, big ? 7 : 4.2, 0, 7);
  ctx.fill();
  ctx.stroke();
  if (big) {
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 10.5, 0, 7);
    ctx.stroke();
  }
}

// Smallest |a| first and the highlighted point last, so the strongest examples stay on top.
function drawOrder(points: Point[], hl: number) {
  const idx = points.map((_, i) => i).sort((i, j) => Math.abs(points[i].a) - Math.abs(points[j].a));
  return hl >= 0 ? idx.filter((i) => i !== hl).concat([hl]) : idx;
}

function drawCurve(cv: HTMLCanvasElement, points: Point[], hl: number) {
  const { ctx, w, h } = setup(cv);
  const gs = points.map((p) => p.g);
  const gLo = Math.min(-4, Math.min(...gs) - 0.5);
  const gHi = Math.max(4, Math.max(...gs) + 0.5);
  const yLo = -0.6;
  const yHi = Math.max(1.5, silu(gHi) * 1.04);
  const m = { l: 44, r: 12, t: 14, b: 58 };
  const pw = w - m.l - m.r;
  const ph = h - m.t - m.b;
  const X = (g: number) => m.l + ((g - gLo) / (gHi - gLo)) * pw;
  const Y = (y: number) => m.t + (1 - (y - yLo) / (yHi - yLo)) * ph;
  ctx.clearRect(0, 0, w, h);
  ctx.font = '11px ui-monospace, monospace';
  ctx.fillStyle = rgb(MID);
  ctx.fillRect(m.l, m.t, X(0) - m.l, ph);
  ctx.fillStyle = MUTED;
  ctx.textAlign = 'left';
  ctx.fillText('gate closed', m.l + 6, m.t + 14);
  ctx.textAlign = 'right';
  ctx.fillText('gate open', m.l + pw - 4, m.t + 14);
  const xt = niceTicks(gLo, gHi, 7);
  const yt = niceTicks(yLo, yHi, 5);
  ctx.strokeStyle = RULE;
  ctx.lineWidth = 1;
  xt.forEach((v) => line(ctx, X(v), m.t, X(v), m.t + ph));
  yt.forEach((v) => line(ctx, m.l, Y(v), m.l + pw, Y(v)));
  ctx.strokeStyle = MUTED;
  line(ctx, m.l, Y(0), m.l + pw, Y(0));
  line(ctx, X(0), m.t, X(0), m.t + ph);
  ctx.fillStyle = MUTED;
  ctx.textAlign = 'center';
  xt.forEach((v) => ctx.fillText(tickLabel(v), X(v), m.t + ph + 14));
  ctx.textAlign = 'right';
  yt.forEach((v) => ctx.fillText(tickLabel(v), m.l - 6, Y(v) + 4));
  ctx.textAlign = 'center';
  ctx.fillText('gate g', m.l + pw / 2, h - 4);
  ctx.save();
  ctx.translate(12, m.t + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('silu(g)', 0, 0);
  ctx.restore();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i <= 400; i += 1) {
    const g = gLo + (i / 400) * (gHi - gLo);
    if (i) ctx.lineTo(X(g), Y(silu(g)));
    else ctx.moveTo(X(g), Y(silu(g)));
  }
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(X(SILU_MIN_G), Y(silu(SILU_MIN_G)), 3.5, 0, 7);
  ctx.fill();
  if (Y(silu(SILU_MIN_G)) - Y(0) > 12) {
    ctx.textAlign = 'center';
    ctx.fillText('−0.278 at g = −1.28', X(SILU_MIN_G), Y(silu(SILU_MIN_G)) + 18);
  }
  // Each example's g as a tick on a strip under the axis: positive a above the strip line, negative below.
  const sy = m.t + ph + 30;
  ctx.strokeStyle = RULE;
  ctx.lineWidth = 1;
  line(ctx, m.l, sy, m.l + pw, sy);
  const hits: Hit[] = [];
  drawOrder(points, hl).forEach((i) => {
    const p = points[i];
    const x = X(p.g);
    ctx.strokeStyle = rgb(p.a >= 0 ? POS : NEG);
    ctx.lineWidth = i === hl ? 3 : 1.5;
    line(ctx, x, sy, x, p.a >= 0 ? sy - 8 : sy + 8);
    dot(ctx, x, Y(silu(p.g)), p, i === hl);
    hits.push({ x, y: Y(silu(p.g)), i });
  });
  const readout = (x: number) => {
    const g = gLo + ((x - m.l) / pw) * (gHi - gLo);
    return g < gLo || g > gHi ? undefined : `g ${fmt(g)} → silu(g) ${fmt(silu(g), 3)}`;
  };
  return { hits, readout };
}

function drawPlane(cv: HTMLCanvasElement, points: Point[], hl: number) {
  const { ctx, w, h } = setup(cv);
  const gs = points.map((p) => p.g);
  const us = points.map((p) => p.u);
  const g0 = Math.min(...gs, -0.5);
  const g1 = Math.max(...gs, 0.5);
  const gp = (g1 - g0) * 0.06;
  const um = Math.max(...us.map(Math.abs), 0.5) * 1.08;
  const R = { g0: g0 - gp, g1: g1 + gp, u0: -um, u1: um };
  const m = { l: 44, r: 12, t: 12, b: 36 };
  const pw = w - m.l - m.r;
  const ph = h - m.t - m.b;
  const X = (g: number) => m.l + ((g - R.g0) / (R.g1 - R.g0)) * pw;
  const Y = (u: number) => m.t + (1 - (u - R.u0) / (R.u1 - R.u0)) * ph;
  const amax = Math.max(1e-6, ...points.map((p) => Math.abs(p.a)));
  ctx.clearRect(0, 0, w, h);
  const cols = 120;
  const rows = 90;
  for (let i = 0; i < cols; i += 1) {
    for (let j = 0; j < rows; j += 1) {
      const g = R.g0 + ((i + 0.5) / cols) * (R.g1 - R.g0);
      const u = R.u1 - ((j + 0.5) / rows) * (R.u1 - R.u0);
      const a = silu(g) * u;
      const t = Math.min(1, Math.abs(a) / amax);
      ctx.fillStyle = rgb(mix(MID, a >= 0 ? POS : NEG, t ** 0.6 * 0.55));
      ctx.fillRect(m.l + (i / cols) * pw, m.t + (j / rows) * ph, pw / cols + 0.6, ph / rows + 0.6);
    }
  }
  ctx.font = '11px ui-monospace, monospace';
  ctx.fillStyle = MUTED;
  ctx.strokeStyle = MUTED;
  ctx.lineWidth = 1;
  if (R.g0 < 0 && R.g1 > 0) line(ctx, X(0), m.t, X(0), m.t + ph);
  line(ctx, m.l, Y(0), m.l + pw, Y(0));
  ctx.textAlign = 'center';
  niceTicks(R.g0, R.g1, 6).forEach((v) => ctx.fillText(tickLabel(v), X(v), m.t + ph + 14));
  ctx.textAlign = 'right';
  niceTicks(R.u0, R.u1, 6).forEach((v) => ctx.fillText(tickLabel(v), m.l - 6, Y(v) + 4));
  ctx.textAlign = 'center';
  ctx.fillText('gate g', m.l + pw / 2, h - 4);
  ctx.save();
  ctx.translate(12, m.t + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('value u', 0, 0);
  ctx.restore();
  ctx.font = '600 11px ui-monospace, monospace';
  ctx.fillStyle = INK;
  const label = (text: string, x: number, y: number, align: CanvasTextAlign) => {
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
  };
  label('g−u+', m.l + 6, m.t + 14, 'left');
  label('g−u− double negative', m.l + 6, m.t + ph - 6, 'left');
  label('g+u+', m.l + pw - 6, m.t + 14, 'right');
  label('g+u−', m.l + pw - 6, m.t + ph - 6, 'right');
  const hits: Hit[] = [];
  drawOrder(points, hl).forEach((i) => {
    const x = X(points[i].g);
    const y = Y(points[i].u);
    dot(ctx, x, y, points[i], i === hl);
    hits.push({ x, y, i });
  });
  const readout = (x: number, y: number) => {
    if (x < m.l || x > m.l + pw || y < m.t || y > m.t + ph) return undefined;
    const g = R.g0 + ((x - m.l) / pw) * (R.g1 - R.g0);
    const u = R.u1 - ((y - m.t) / ph) * (R.u1 - R.u0);
    return `g ${fmt(g)} · u ${fmt(u)} · a ${fmtA(silu(g) * u)} · ${quadrantOf(g, u)}`;
  };
  return { hits, readout, amax };
}

function nearest(hits: Hit[], px: number, py: number, r = 10) {
  let best: Hit | null = null;
  let bd = r * r;
  hits.forEach((hit) => {
    const d = (hit.x - px) ** 2 + (hit.y - py) ** 2;
    if (d < bd) {
      bd = d;
      best = hit;
    }
  });
  return best as Hit | null;
}

export default function NeuronGatePanels({
  dashboard,
  ids,
}: {
  dashboard: NeuronDashboard;
  ids: { modelId: string; layer: string; index: string };
}) {
  const { record } = dashboard;
  const points = useMemo<Point[]>(() => gatePoints(record, dashboard.vocab, ids), [record, dashboard.vocab, ids]);
  const quadrants = useMemo(() => quadrantShares(record), [record]);
  const echoes = points.filter((p) => p.kind === 'echo_top' || p.kind === 'echo_bottom');
  const curveRef = useRef<HTMLCanvasElement>(null);
  const planeRef = useRef<HTMLCanvasElement>(null);
  const curve = useRef<ReturnType<typeof drawCurve>>(undefined);
  const plane = useRef<ReturnType<typeof drawPlane>>(undefined);
  const [hl, setHl] = useState(-1);
  const [tip, setTip] = useState<Tip>(null);
  const [amax, setAmax] = useState(0);

  const draw = useCallback(() => {
    if (!points.length || !curveRef.current || !planeRef.current) return;
    curve.current = drawCurve(curveRef.current, points, hl);
    plane.current = drawPlane(planeRef.current, points, hl);
    setAmax(plane.current.amax);
  }, [points, hl]);

  useEffect(() => {
    draw();
    if (!curveRef.current) return undefined;
    const observer = new ResizeObserver(() => requestAnimationFrame(draw));
    observer.observe(curveRef.current);
    return () => observer.disconnect();
  }, [draw]);

  if (!points.length) return null;

  const openShare = record.stats.frac_gate_open;

  const handlers = (chart: 'curve' | 'plane') => {
    const drawn = () => (chart === 'curve' ? curve.current : plane.current);
    const rel = (e: React.PointerEvent<HTMLCanvasElement> | React.MouseEvent<HTMLCanvasElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    return {
      onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => {
        const [x, y] = rel(e);
        const hit = nearest(drawn()?.hits || [], x, y);
        setHl(hit ? hit.i : -1);
        const text = hit ? undefined : drawn()?.readout(x, y);
        const w = e.currentTarget.getBoundingClientRect().width;
        setTip(hit || text ? { chart, x, y, w, point: hit ? points[hit.i] : undefined, text } : null);
      },
      onPointerLeave: () => {
        setHl(-1);
        setTip(null);
      },
      onClick: (e: React.MouseEvent<HTMLCanvasElement>) => {
        const [x, y] = rel(e);
        const hit = nearest(drawn()?.hits || [], x, y);
        const id = hit ? points[hit.i].activationId : null;
        if (id) {
          document.getElementById(`activation-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      },
    };
  };

  const tipBox = (chart: 'curve' | 'plane') =>
    tip?.chart === chart && (
      <div
        className="pointer-events-none absolute z-10 max-w-[320px] rounded border border-slate-200 bg-white px-2 py-1.5 font-mono text-[11px] text-slate-700 shadow"
        // Flip to the left of the pointer when the tooltip would run past the chart's right edge.
        style={
          tip.x + 12 + TIP_WIDTH > tip.w
            ? { right: tip.w - tip.x + 12, top: tip.y + 12 }
            : { left: tip.x + 12, top: tip.y + 12 }
        }
      >
        {tip.point ? (
          <>
            <div className="whitespace-pre-wrap break-words">
              {tip.point.before.length > 80 ? `…${tip.point.before.slice(-80)}` : tip.point.before}
              <span className="font-bold underline">{tip.point.token}</span>
            </div>
            <div className="mt-1">
              <span className={tip.point.a >= 0 ? 'text-emerald-600' : 'text-rose-600'}>a {fmtA(tip.point.a)}</span> · g{' '}
              {fmt(tip.point.g)} · u {fmt(tip.point.u)} · {quadrantOf(tip.point.g, tip.point.u)}
            </div>
          </>
        ) : (
          tip.text
        )}
      </div>
    );

  return (
    <div className="border-b px-2.5 pb-3 pt-2 sm:px-4">
      <div className="mb-1 font-mono text-[10px] font-bold uppercase text-slate-600">Gate and value</div>
      <div className="mb-2 text-[11px] leading-snug text-slate-500">
        Every example below, placed by its gate g and value u at the peak token (a = silu(g)·u). Hollow points are
        echoes, the strongest examples with the gate closed. Hover a point for its context; click a filled one to jump
        to it.
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <figure className="m-0">
          <div className="relative aspect-[4/3] w-full">
            <canvas
              ref={curveRef}
              className="absolute inset-0 h-full w-full cursor-crosshair"
              aria-label="silu(g) with this neuron's examples"
              {...handlers('curve')}
            />
            {tipBox('curve')}
          </div>
          <figcaption className="mt-1 text-[11px] leading-snug text-slate-500">
            <b className="text-slate-700">The gate curve.</b> silu(g) = g·σ(g). Right of zero the gate is open and
            passes u on, scaled by about g. Left of zero it is closed but leaks with the sign flipped, never below
            −0.278. Ticks under the axis mark each example&apos;s g.
            {` The gate is open on ${(openShare * 100).toFixed(2)}% of all scanned tokens.`}
          </figcaption>
        </figure>
        <figure className="m-0">
          <div className="relative aspect-[4/3] w-full">
            <canvas
              ref={planeRef}
              className="absolute inset-0 h-full w-full cursor-crosshair"
              aria-label="The g, u plane coloured by activation"
              {...handlers('plane')}
            />
            {tipBox('plane')}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 font-mono text-[10px] text-slate-500">
            <span>a</span>
            <span>{fmt(-amax, amax >= 10 ? 0 : 2)}</span>
            <span
              className="inline-block h-2 w-24 rounded"
              style={{ background: `linear-gradient(90deg, ${rgb(NEG)}, ${rgb(MID)}, ${rgb(POS)})` }}
            />
            <span>{fmt(amax, amax >= 10 ? 0 : 2)}</span>
          </div>
          <figcaption className="mt-1 text-[11px] leading-snug text-slate-500">
            <b className="text-slate-700">The product plane.</b> Gate g across, value u up, background coloured by a.
            Large activations live right of g = 0. The left half is the leak band, signs flipped, so the bottom left
            (g&lt;0, u&lt;0) is the double negative, a small positive.
          </figcaption>
        </figure>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <div className="mb-1 font-mono text-[10px] font-bold uppercase text-slate-600">Sign quadrants</div>
          <table className="w-full font-mono text-[11px] text-slate-600">
            <tbody>
              {quadrants.map((q) => (
                <tr key={q.quadrant} className="border-b border-slate-100">
                  <td className="py-0.5 pr-2 font-bold text-slate-700">{q.quadrant}</td>
                  <td className="py-0.5 pr-2 text-right">{(q.share * 100).toFixed(2)}%</td>
                  <td className="py-0.5 font-sans text-slate-500">{q.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-1 text-[11px] leading-snug text-slate-500">
            Share of all {record.stats.n_hist_tokens.toLocaleString()} scanned tokens with a nonzero activation.
          </div>
        </div>
        <div>
          <div className="mb-1 font-mono text-[10px] font-bold uppercase text-slate-600">Echoes</div>
          <div className="mb-1 text-[11px] leading-snug text-slate-500">
            {`${(record.stats.echo_abs_share * 100).toFixed(1)}% of this neuron's total |a| comes from tokens where the gate is closed.`}{' '}
            The strongest of them:
          </div>
          {echoes.length === 0 ? (
            <div className="text-[11px] text-slate-400">None in this file.</div>
          ) : (
            <ul className="space-y-1 font-mono text-[11px] text-slate-700">
              {echoes.map((p, i) => (
                <li key={i} className="break-words">
                  <span className="text-slate-400">{p.before.length > 60 ? `…${p.before.slice(-60)}` : p.before}</span>
                  <span className="font-bold underline">{p.token}</span>{' '}
                  <span className={p.a >= 0 ? 'text-emerald-600' : 'text-rose-600'}>a {fmtA(p.a)}</span> · g {fmt(p.g)}{' '}
                  · u {fmt(p.u)} · {quadrantOf(p.g, p.u)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
