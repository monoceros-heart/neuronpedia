import { prisma } from '@/lib/db';
import { PUBLIC_ACTIVATIONS_USER_IDS } from '@/lib/env';
import { getActivationForFeature } from '@/lib/utils/inference';
import {
  BOTTOM_ACTIVATION_DATA_SOURCE,
  poleShare,
  TRIGGER_DATA_SOURCE,
  TRIGGER_EXPLANATION_TYPE,
} from '@/lib/utils/raw-neurons';
import { AuthenticatedUser } from '@/lib/with-user';

// The public shape of a shared trigger. `/api/trigger/*` returns exactly this, so agents can rely
// on the field names; the rows behind it are an activation, an explanation and the link between.
export type NeuronTrigger = {
  id: string;
  modelId: string;
  layer: string;
  index: string;
  meaning: string;
  author: string;
  createdAt: Date;
  tokens: string[];
  values: number[];
  peak: number;
  trough: number;
  // Peak as a share of the neuron's strongest corpus example, trough as a share of its most negative.
  peakShare: number;
  troughShare: number;
  corpusMax: number;
  corpusMin: number;
};

type NeuronKey = { modelId: string; layer: string; index: string };

async function getCorpusExtremes({ modelId, layer, index }: NeuronKey) {
  const [neuron, bottom] = await Promise.all([
    prisma.neuron.findUnique({
      where: { modelId_layer_index: { modelId, layer, index } },
      select: { maxActApprox: true },
    }),
    prisma.activation.aggregate({
      _min: { minValue: true },
      where: {
        modelId,
        layer,
        index,
        dataSource: BOTTOM_ACTIVATION_DATA_SOURCE,
        creatorId: { in: PUBLIC_ACTIVATIONS_USER_IDS },
      },
    }),
  ]);
  if (!neuron) {
    throw new Error(`Neuron ${modelId}/${layer}/${index} not found.`);
  }
  return { corpusMax: neuron.maxActApprox || 0, corpusMin: bottom._min.minValue || 0 };
}

function toTrigger(
  link: {
    explanation: { id: string; description: string; author: { name: string } };
    activation: { tokens: string[]; values: number[]; maxValue: number; minValue: number; createdAt: Date };
  },
  key: NeuronKey,
  extremes: { corpusMax: number; corpusMin: number },
): NeuronTrigger {
  const { activation, explanation } = link;
  return {
    id: explanation.id,
    ...key,
    meaning: explanation.description,
    author: explanation.author.name,
    createdAt: activation.createdAt,
    tokens: activation.tokens,
    values: activation.values,
    peak: activation.maxValue,
    trough: activation.minValue,
    peakShare: poleShare(activation.maxValue, extremes.corpusMax),
    troughShare: poleShare(activation.minValue, extremes.corpusMin),
    ...extremes,
  };
}

const TRIGGER_LINK_INCLUDE = {
  explanation: { select: { id: true, description: true, author: { select: { name: true } } } },
  activation: { select: { tokens: true, values: true, maxValue: true, minValue: true, createdAt: true } },
} as const;

export async function listTriggers(key: NeuronKey): Promise<NeuronTrigger[]> {
  const extremes = await getCorpusExtremes(key);
  const links = await prisma.explanationActivationV1.findMany({
    where: {
      explanation: { ...key, typeName: TRIGGER_EXPLANATION_TYPE },
      activation: { dataSource: TRIGGER_DATA_SOURCE },
    },
    include: TRIGGER_LINK_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
  return links.map((link) => toTrigger(link, key, extremes)).toSorted((a, b) => b.peakShare - a.peakShare);
}

// Runs the text through the neuron and saves it with the author's proposed meaning. The values are
// always computed here, never accepted from the caller, so a shared trigger is a real measurement.
export async function createTrigger(key: NeuronKey, text: string, meaning: string, user: AuthenticatedUser) {
  const extremes = await getCorpusExtremes(key);
  const result = await getActivationForFeature(key, text, user);
  if (Array.isArray(result)) {
    throw new Error('Expected one activation for one text.');
  }
  const link = await prisma.$transaction(async (tx) => {
    const activation = await tx.activation.create({
      data: {
        ...key,
        tokens: result.tokens,
        values: result.values,
        maxValue: result.maxValue,
        minValue: result.minValue,
        maxValueTokenIndex: result.maxValueTokenIndex,
        dataSource: TRIGGER_DATA_SOURCE,
        creatorId: user.id,
      },
    });
    const explanation = await tx.explanation.create({
      data: {
        ...key,
        description: meaning,
        authorId: user.id,
        typeName: TRIGGER_EXPLANATION_TYPE,
      },
    });
    // Version 0 is "user scored" in this table; the score is the trigger's share of the corpus max.
    return tx.explanationActivationV1.create({
      data: {
        explanationId: explanation.id,
        activationId: activation.id,
        expectedValues: [],
        score: poleShare(result.maxValue, extremes.corpusMax),
        scorerId: user.id,
        version: 0,
      },
      include: TRIGGER_LINK_INCLUDE,
    });
  });
  return toTrigger(link, key, extremes);
}
