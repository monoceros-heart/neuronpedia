// Data for the raw-neuron panels drawn from a dashboard file's record: the gate curve, the g/u plane, the
// four sign quadrants and the closed-gate "echo" examples. A SwiGLU neuron's activation is a = silu(g) * u,
// where g is the gate pre-activation and u the value (up projection) at that token.

import { NeuronDashboardExample, NeuronDashboardRecord } from '@/lib/utils/neuron-dashboards';

export type GateQuadrant = 'g+u+' | 'g+u−' | 'g−u+' | 'g−u−';

export type GatePointKind = 'top' | 'bottom' | 'band' | 'echo_top' | 'echo_bottom';

export type GatePoint = {
  // The activation row this example is shown as, so a click can scroll to it. Echoes have no row.
  activationId: string | null;
  kind: GatePointKind;
  g: number;
  u: number;
  a: number;
  before: string;
  token: string;
};

export type QuadrantShare = { quadrant: GateQuadrant; tokens: number; share: number; meaning: string };

export function silu(g: number) {
  return g / (1 + Math.exp(-g));
}

// A gate of exactly 0 counts as closed, matching gate_closed in the dashboard file.
export function quadrantOf(g: number, u: number): GateQuadrant {
  if (g > 0) return u >= 0 ? 'g+u+' : 'g+u−';
  return u >= 0 ? 'g−u+' : 'g−u−';
}

const QUADRANT_MEANING: Record<GateQuadrant, string> = {
  'g+u+': 'gate open, value positive: the large positive activations',
  'g+u−': 'gate open, value negative: the large negative activations',
  'g−u+': 'gate closed, value positive: a small negative leak',
  'g−u−': 'gate closed, value negative: the double negative, a small positive leak',
};

// The scanned tokens in each quadrant, from the record's histogram. With the gate open, a has u's sign;
// with it closed, silu(g) is negative so a has the opposite sign. Tokens with a = 0 exactly are not in it.
export function quadrantShares(record: NeuronDashboardRecord): QuadrantShare[] {
  const sum = (counts: number[]) => counts.reduce((s, c) => s + c, 0);
  const tokens: Record<GateQuadrant, number> = {
    'g+u+': sum(record.hist.open_pos),
    'g+u−': sum(record.hist.open_neg),
    'g−u+': sum(record.hist.closed_neg),
    'g−u−': sum(record.hist.closed_pos),
  };
  const total = Object.values(tokens).reduce((s, c) => s + c, 0);
  return (Object.keys(tokens) as GateQuadrant[]).map((quadrant) => ({
    quadrant,
    tokens: tokens[quadrant],
    share: total > 0 ? tokens[quadrant] / total : 0,
    meaning: QUADRANT_MEANING[quadrant],
  }));
}

function toPoint(
  example: NeuronDashboardExample,
  vocab: string[],
  kind: GatePointKind,
  activationId: string | null,
): GatePoint {
  const peak = example.pos - example.start;
  const decode = (t: number) => vocab[t] ?? `<${t}>`;
  return {
    activationId,
    kind,
    g: example.gate,
    u: example.up,
    a: example.act,
    before: example.tokens
      .slice(Math.max(0, peak - 24), peak)
      .map(decode)
      .join(''),
    token: decode(example.tokens[peak]),
  };
}

// Every example in the record as a point, with the same activation ids recordToNeuronDashboard gives them.
export function gatePoints(
  record: NeuronDashboardRecord,
  vocab: string[],
  ids: { modelId: string; layer: string; index: string },
): GatePoint[] {
  const prefix = `${ids.modelId}-${ids.layer}-${ids.index}`;
  return [
    ...record.top.map((e, i) => toPoint(e, vocab, 'top', `${prefix}-top-${i}`)),
    ...record.bands.flatMap((band, b) =>
      band.examples.map((e, i) => toPoint(e, vocab, 'band', `${prefix}-band${b}-${i}`)),
    ),
    ...record.bottom.map((e, i) => toPoint(e, vocab, 'bottom', `${prefix}-bottom-${i}`)),
    ...record.echo_top.map((e) => toPoint(e, vocab, 'echo_top', null)),
    ...record.echo_bottom.map((e) => toPoint(e, vocab, 'echo_bottom', null)),
  ];
}
