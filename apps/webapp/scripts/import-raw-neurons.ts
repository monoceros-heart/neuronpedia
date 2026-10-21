// Imports raw MLP neurons, both poles, from a JSON export into a local Neuronpedia database.
//
//   npx env-cmd -f .env.localhost ts-node --compiler-options '{"module":"CommonJS"}' \
//     scripts/import-raw-neurons.ts path/to/export.json[.gz]
//
// The export format (one model, any subset of its neurons) is written by
// monoceros-heart/mechanistic-interpretability `llm/neuronpedia_app.py`:
//
//   { model, hfRepoId, act?, layers, neuronsPerLayer, scan, tokensScanned, dataset,
//     neurons: [{ layer, index, maxActApprox, activations: [{ tokens, values, maxValue,
//                 maxValueTokenIndex, minValue, dataSource: 'top' | 'bottom', dataIndex, gate?, up? }],
//                quadCounts? }] }
//
// `gate` and `up` are the example's g and u at its peak token. With the neuron's gate/up sign counts
// they go in the row's `logitContributions` JSON under GATE_VALUE_KEY, which the page's gate and value
// charts read (lib/utils/raw-neurons.ts); that keeps them out of the schema. `act` names the model's
// gate curve and defaults to Qwen3's silu.
//
// Neurons go in the `neurons` source set, whose sources are bare layer numbers, so a neuron's page is
// /<model>/<layer>/<index> as for GPT-2's neurons. Re-running replaces each imported neuron's
// corpus examples and leaves everything people added (explanations, triggers, comments) alone.
// It only writes rows for this model; it never alters the schema.

import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { GATE_ACT, GATE_VALUE_KEY } from '../lib/utils/raw-neurons';

type ExportActivation = {
  tokens: string[];
  values: number[];
  maxValue: number;
  maxValueTokenIndex: number;
  minValue: number;
  dataSource: 'top' | 'bottom';
  dataIndex?: string;
  gate?: number;
  up?: number;
};

type ExportNeuron = {
  layer: string;
  index: string;
  maxActApprox: number;
  activations: ExportActivation[];
  quadCounts?: Record<string, number>;
};

type RawNeuronExport = {
  model: string;
  hfRepoId: string;
  act?: string;
  layers: number;
  neuronsPerLayer: number;
  scan: string;
  tokensScanned: number;
  dataset: string;
  neurons: ExportNeuron[];
};

const NEURONS_SOURCESET = 'neurons';
// The seed's bot user: the creator of imported rows, and the only creator whose activations the
// neuron page shows as corpus examples (PUBLIC_ACTIVATIONS_USER_IDS).
const BOT_USER_ID = 'clkht01d40000jv08hvalcvly';
const TRIGGER_EXPLANATION_TYPE = 'citizen-trigger';
// The exporter's quadrant names (qwen_interp.scan.QUADRANTS), in the order the charts expect.
const SCAN_QUADRANTS = ['g-u-', 'g-u+', 'g+u-', 'g+u+'];

const prisma = new PrismaClient();

async function main() {
  const path = process.argv[2];
  if (!path) {
    throw new Error('usage: import-raw-neurons.ts <export.json[.gz]>');
  }
  const raw = readFileSync(path);
  const data: RawNeuronExport = JSON.parse((path.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8'));
  const modelId = data.model;
  const description = `Raw MLP neurons (SwiGLU, the input to down_proj), both poles: top and bottom examples from a ${(
    data.tokensScanned / 1e6
  ).toFixed(0)}M-token scan of ${data.dataset} (${data.scan}).`;

  await prisma.model.upsert({
    where: { id: modelId },
    update: { inferenceEnabled: true },
    create: {
      id: modelId,
      displayNameShort: modelId.toUpperCase(),
      displayName: data.hfRepoId.split('/').pop() || modelId,
      creatorId: BOT_USER_ID,
      tlensId: data.hfRepoId,
      hfRepoId: data.hfRepoId,
      layers: data.layers,
      neuronsPerLayer: data.neuronsPerLayer,
      owner: data.hfRepoId.split('/')[0],
      visibility: 'PUBLIC',
      inferenceEnabled: true,
      website: `https://huggingface.co/${data.hfRepoId}`,
    },
  });
  await prisma.sourceSet.upsert({
    where: { modelId_name: { modelId, name: NEURONS_SOURCESET } },
    update: { description },
    create: {
      modelId,
      name: NEURONS_SOURCESET,
      description,
      type: 'neurons',
      creatorName: 'qwen-interp',
      creatorId: BOT_USER_ID,
      visibility: 'PUBLIC',
      urls: ['https://github.com/monoceros-heart/mechanistic-interpretability'],
      allowInferenceSearch: true,
      defaultRange: 2,
    },
  });
  for (let layer = 0; layer < data.layers; layer += 1) {
    await prisma.source.upsert({
      where: { modelId_id: { modelId, id: String(layer) } },
      update: { inferenceEnabled: true },
      create: {
        modelId,
        id: String(layer),
        setName: NEURONS_SOURCESET,
        creatorId: BOT_USER_ID,
        visibility: 'PUBLIC',
        inferenceEnabled: true,
        dataset: data.dataset,
        notes: data.scan,
      },
    });
  }
  await prisma.model.update({
    where: { id: modelId },
    data: { defaultSourceSetName: NEURONS_SOURCESET, defaultSourceId: data.neurons[0]?.layer },
  });
  await prisma.explanationType.upsert({
    where: { name: TRIGGER_EXPLANATION_TYPE },
    update: { featured: false },
    create: {
      name: TRIGGER_EXPLANATION_TYPE,
      displayName: 'Shared trigger',
      description: 'A meaning proposed by someone who shared a text that drives this neuron.',
      // Not offered as an auto-interp method: these come from people, through /api/trigger/new.
      featured: false,
      creatorName: 'neuronpedia',
      creatorId: BOT_USER_ID,
    },
  });

  for (const neuron of data.neurons) {
    const key = { modelId, layer: neuron.layer, index: neuron.index };
    await prisma.neuron.upsert({
      where: { modelId_layer_index: key },
      update: { maxActApprox: neuron.maxActApprox },
      create: { ...key, sourceSetName: NEURONS_SOURCESET, creatorId: BOT_USER_ID, maxActApprox: neuron.maxActApprox },
    });
    await prisma.activation.deleteMany({ where: { ...key, creatorId: BOT_USER_ID } });
    const quadCounts = neuron.quadCounts ? SCAN_QUADRANTS.map((q) => neuron.quadCounts![q] ?? 0) : undefined;
    await prisma.activation.createMany({
      data: neuron.activations.map((act) => ({
        ...key,
        tokens: act.tokens,
        values: act.values,
        maxValue: act.maxValue,
        maxValueTokenIndex: act.maxValueTokenIndex,
        minValue: act.minValue,
        dataSource: act.dataSource,
        dataIndex: act.dataIndex,
        logitContributions:
          act.gate !== undefined && act.up !== undefined
            ? JSON.stringify({ [GATE_VALUE_KEY]: { g: act.gate, u: act.up, act: data.act ?? GATE_ACT, quadCounts } })
            : undefined,
        creatorId: BOT_USER_ID,
      })),
    });
  }
  console.log(`imported ${data.neurons.length} neurons of ${modelId} from ${data.scan}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
