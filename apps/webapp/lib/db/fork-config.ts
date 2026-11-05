/**
 * Explanation and score types, and the models behind them, that this fork adds to Neuronpedia's
 * dataset config. Sync Config on /admin (and every source import) upserts these after the
 * bucket's own config, so labels from our explainer can be imported with
 * `make explanations-import`.
 *
 * Neither type has code in the generate or score routes: they are produced offline, by the
 * neuron-explanations method in monoceros-heart/mechanistic-interpretability, and only imported
 * here. So both types and their model are `featured: false`, which keeps them out of the menus
 * that offer to generate or score on demand.
 */
import { Prisma } from '@prisma/client';

const CREATOR_NAME = 'monoceros-heart';

export const FORK_EXPLAINER_MODEL = 'claude-opus-5-5';

export const forkExplanationModelTypes: Prisma.ExplanationModelTypeCreateInput[] = [
  {
    name: FORK_EXPLAINER_MODEL,
    displayName: FORK_EXPLAINER_MODEL,
    description: 'Claude Opus 5.5',
    featured: false,
    url: 'https://www.anthropic.com/claude',
    creatorName: 'Anthropic',
  },
];

export const forkExplanationScoreModels: Prisma.ExplanationScoreModelCreateInput[] = [
  {
    name: FORK_EXPLAINER_MODEL,
    displayName: FORK_EXPLAINER_MODEL,
    description: 'Claude Opus 5.5',
    featured: false,
    url: 'https://www.anthropic.com/claude',
    creatorName: 'Anthropic',
  },
];

/** Without creatorId, which is the instance's default creator, filled in when they are written. */
export const forkExplanationTypes: Omit<Prisma.ExplanationTypeUncheckedCreateInput, 'creatorId'>[] = [
  {
    name: 'claude-blind',
    displayName: 'claude-blind',
    description:
      "Claude reads one pole's top corpus examples, with each token's activation shown as a level from 0 to 10 " +
      "against the pole's maximum, and writes a short summary. It never sees the neuron's name, its logits or " +
      'any other explanation. Each pole (positive and negative) is explained separately.',
    settings: 'Top examples per pole from a corpus scan, in the dtype of the scan.',
    featured: false,
    creatorName: CREATOR_NAME,
  },
];

export const forkExplanationScoreTypes: Omit<Prisma.ExplanationScoreTypeUncheckedCreateInput, 'creatorId'>[] = [
  {
    name: 'blind-probe-strong',
    displayName: 'blind-probe-strong',
    description:
      'Claude writes new texts from the explanation alone, meant to fire the pole as strongly as possible, and ' +
      "the model is run on them. A text's score is its peak activation on the pole's side divided by the pole's " +
      'corpus maximum.',
    scoreDescription: 'Share of the probe texts that fire strong, at least half the corpus maximum.',
    scorerModel: FORK_EXPLAINER_MODEL,
    featured: false,
    creatorName: CREATOR_NAME,
  },
];
