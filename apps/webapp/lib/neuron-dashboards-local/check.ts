/**
 * Check a neuron dashboard set (docs/NEURON_DASHBOARDS.md) the way the webapp reads it: over HTTP,
 * with the webapp's own reader (lib/utils/neuron-dashboards.ts). Works against a local
 * `make dashboards-serve` or any public URL, and needs no browser.
 */
import {
  fetchNeuronDashboard,
  fetchNeuronDashboardVocab,
  layerFileStem,
  NeuronDashboardExample,
} from '@/lib/utils/neuron-dashboards';

export type LayerReport = { layer: number; neurons: number; checked: number[]; topLogits: string[] };
export type CheckReport = { vocabSize: number; layers: LayerReport[]; problems: string[] };

async function fetchBytes(url: string): Promise<ArrayBuffer | null> {
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.arrayBuffer();
}

/** Problems with one example's shape: lengths that disagree, or token ids outside the vocabulary. */
export function exampleProblems(example: NeuronDashboardExample, vocabSize: number): string[] {
  const problems: string[] = [];
  if (example.acts.length !== example.tokens.length) {
    problems.push(`acts has ${example.acts.length} values for ${example.tokens.length} tokens`);
  }
  if (example.gate_closed.length !== example.tokens.length) {
    problems.push(`gate_closed has ${example.gate_closed.length} chars for ${example.tokens.length} tokens`);
  }
  const peak = example.pos - example.start;
  if (peak < 0 || peak >= example.tokens.length) {
    problems.push(`peak position ${example.pos} is outside the window starting at ${example.start}`);
  }
  if (example.tokens.some((t) => !Number.isInteger(t) || t < 0 || t >= vocabSize)) {
    problems.push('a token id is outside corpus/vocab.json');
  }
  return problems;
}

/**
 * Offsets in a layer's .idx file: one more than the neurons, little-endian uint64, increasing.
 * `last` is the final offset, which must be the size of the layer's .json.gz.
 */
export function readLayerIndex(bytes: ArrayBuffer): { neurons: number; last: number; problems: string[] } {
  if (bytes.byteLength % 8 !== 0 || bytes.byteLength < 16) {
    return { neurons: 0, last: 0, problems: [`index is ${bytes.byteLength} bytes, not 8 * (neurons + 1)`] };
  }
  const view = new DataView(bytes);
  const count = bytes.byteLength / 8;
  let previous = -1;
  for (let i = 0; i < count; i += 1) {
    const offset = Number(view.getBigUint64(8 * i, true));
    if (offset <= previous) {
      return { neurons: count - 1, last: 0, problems: [`index offset ${i} (${offset}) does not increase`] };
    }
    previous = offset;
  }
  return { neurons: count - 1, last: previous, problems: [] };
}

/** The size of a file, from a one-byte range request, or null when the server doesn't say. */
async function fileSize(url: string): Promise<number | null> {
  const response = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  await response.arrayBuffer();
  if (response.status === 206) {
    const total = response.headers.get('content-range')?.split('/')[1];
    return total && total !== '*' ? Number(total) : null;
  }
  const length = response.headers.get('content-length');
  return response.ok && length ? Number(length) : null;
}

function pick(neurons: number, sample: number): number[] {
  const chosen = new Set([0, neurons - 1]);
  // Spread evenly rather than at random, so two runs check the same neurons.
  for (let i = 1; i <= sample; i += 1) chosen.add(Math.floor((i * neurons) / (sample + 1)));
  return Array.from(chosen).sort((a, b) => a - b);
}

export async function checkDashboards(
  baseUrl: string,
  opts: { modelId?: string; layers?: number[]; sample?: number; maxLayers?: number } = {},
): Promise<CheckReport> {
  const base = baseUrl.replace(/\/+$/, '');
  const modelId = opts.modelId ?? base.split('/').pop() ?? 'model';
  const problems: string[] = [];
  const vocab = await fetchNeuronDashboardVocab(base);
  const layers: LayerReport[] = [];

  // With no layer list, layers are found by trying 0, 1, 2, ... and the scan ends after this many
  // misses in a row. A missing layer before the last one found is a gap, and is reported.
  const MISSES_TO_STOP = 8;
  const wanted = opts.layers ?? Array.from({ length: opts.maxLayers ?? 256 }, (_, i) => i);
  const missing: number[] = [];
  let missesInARow = 0;
  for (const layer of wanted) {
    // eslint-disable-next-line no-await-in-loop
    const idx = await fetchBytes(`${base}/${layerFileStem(layer)}.idx`);
    if (!idx) {
      missing.push(layer);
      missesInARow += 1;
      if (!opts.layers && missesInARow >= MISSES_TO_STOP) break;
      continue;
    }
    missesInARow = 0;
    const index = readLayerIndex(idx);
    problems.push(...index.problems.map((p) => `layer ${layer}: ${p}`));
    if (index.problems.length === 0) {
      // eslint-disable-next-line no-await-in-loop
      const size = await fileSize(`${base}/${layerFileStem(layer)}.json.gz`);
      if (size !== null && size !== index.last) {
        problems.push(`layer ${layer}: index ends at byte ${index.last}, but the .json.gz is ${size} bytes`);
      }
    }
    const report: LayerReport = { layer, neurons: index.neurons, checked: [], topLogits: [] };
    for (const neuron of index.neurons > 0 ? pick(index.neurons, opts.sample ?? 3) : []) {
      const ids = { modelId, layer: String(layer), index: String(neuron) };
      try {
        // eslint-disable-next-line no-await-in-loop
        const dashboard = await fetchNeuronDashboard(base, ids);
        const { record } = dashboard;
        const examples = [
          ...record.top,
          ...record.bottom,
          ...(record.echo_top ?? []),
          ...(record.echo_bottom ?? []),
          ...record.bands.flatMap((b) => b.examples),
        ];
        examples.forEach((example) =>
          exampleProblems(example, vocab.length).forEach((p) => problems.push(`${layer}/${neuron}: ${p}`)),
        );
        report.checked.push(neuron);
        if (report.topLogits.length === 0) {
          report.topLogits = dashboard.neuron.pos_str?.slice(0, 5) ?? [];
        }
      } catch (e) {
        problems.push(`${layer}/${neuron}: ${(e as Error).message}`);
      }
    }
    layers.push(report);
  }
  const lastFound = layers.length > 0 ? layers[layers.length - 1].layer : -1;
  missing
    .filter((layer) => opts.layers || layer < lastFound)
    .forEach((layer) => problems.push(`layer ${layer}: no ${layerFileStem(layer)}.idx`));
  if (layers.length === 0) {
    problems.push(`no layer files under ${base}/neurons/`);
  }
  return { vocabSize: vocab.length, layers, problems };
}
