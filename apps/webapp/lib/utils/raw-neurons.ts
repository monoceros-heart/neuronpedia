// Raw MLP neurons are bipolar: unlike an SAE latent, a SwiGLU neuron has a meaningful negative side.
// Corpus examples for each pole are stored as activation rows tagged with these data sources, and
// any neuron with `bottom` rows is shown with both poles side by side.
export const TOP_ACTIVATION_DATA_SOURCE = 'top';
export const BOTTOM_ACTIVATION_DATA_SOURCE = 'bottom';

// A text someone wrote to drive a neuron, shared with their guess at what it means. Stored as an
// activation row created by that user, so the corpus lists (which only show public creators) never
// mix it in with dataset examples.
export const TRIGGER_DATA_SOURCE = 'trigger';
export const TRIGGER_EXPLANATION_TYPE = 'citizen-trigger';

// A response counts as strong at 30% of the neuron's strongest corpus example, the threshold the
// "explanations that can lose" test uses (Cammarata, "Neural Networks Are Already Clean", 2026).
export const STRONG_SHARE = 0.3;

export const TRIGGER_MAX_TEXT_LENGTH = 2000;
export const TRIGGER_MAX_MEANING_LENGTH = 200;

export function hasBottomPole(activations: { dataSource?: string | null }[] | null | undefined | void) {
  return !!activations?.some((act) => act.dataSource === BOTTOM_ACTIVATION_DATA_SOURCE);
}

// The share of the corpus extreme on the same side: peak / corpus max, or trough / corpus min.
export function poleShare(value: number, corpusExtreme: number | null | undefined) {
  if (!corpusExtreme || Math.sign(value) !== Math.sign(corpusExtreme)) {
    return 0;
  }
  return value / corpusExtreme;
}

// A SwiGLU neuron's activation is a = silu(g) * u, from its gate g and value (up) u. The exporter
// stores each corpus example's g and u at the peak token, plus the neuron's gate/up sign counts over
// the whole scan, as JSON under this key of the activation row's `logitContributions`: the token
// tooltip only reads that column's `pos` and `neg` keys, so it ignores this one.
export const GATE_VALUE_KEY = 'rawNeuron';

// Gate/up sign quadrants in the order the scan counts them.
export const QUADRANTS = ['g−u−', 'g−u+', 'g+u−', 'g+u+'] as const;

// The gate curve the charts draw. Rows carry the name of their model's curve as `act`; ones written
// before it existed are Qwen3's. A row naming any other curve (GeGLU's gelu_tanh, gpt-oss's clamped
// silu) is skipped rather than drawn on the wrong curve.
export const GATE_ACT = 'silu';

export type GateValue = { g: number; u: number; act?: string; quadCounts?: number[] };

export function parseGateValue(logitContributions: string | null | undefined): GateValue | null {
  if (!logitContributions) return null;
  try {
    const value = JSON.parse(logitContributions)?.[GATE_VALUE_KEY];
    if (!value || !Number.isFinite(value.g) || !Number.isFinite(value.u)) return null;
    return (value.act ?? GATE_ACT) === GATE_ACT ? value : null;
  } catch {
    return null;
  }
}

export function silu(g: number) {
  return g / (1 + Math.exp(-g));
}

export function quadrantOf(g: number, u: number) {
  return QUADRANTS[(g > 0 ? 2 : 0) + (u > 0 ? 1 : 0)];
}
