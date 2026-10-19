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
