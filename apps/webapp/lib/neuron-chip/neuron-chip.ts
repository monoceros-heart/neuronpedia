/**
 * The naming and label rules behind the neuron chip, ( L16.N1744 | Wind Whisperer ), for the
 * webapp's React `NeuronChip`. `public/np-neuron.js` is the same chip as a dependency-free web
 * component for static pages; it cannot import this file, so it repeats these helpers, and
 * `neuron-chip.test.ts` runs both copies on the same cases to keep them in step.
 *
 * The optional labels file both chips read is described in docs/NEURON_CHIP.md.
 */

export const LABELS_FORMAT = 'np-labels/1';
export const NEURONS_SET = 'neurons';

/** Layer counts for the models we link to most; a labels file can add more. */
export const MODEL_LAYERS: Record<string, number> = {
  'qwen3-0.6b': 28,
  'qwen3-8b': 36,
  'qwen3-32b': 64,
  'gpt2-small': 12,
  'gemma-2-2b': 26,
  'llama3.1-8b': 32,
};

const MODEL_COLORS: Record<string, string> = {
  'qwen3-0.6b': '#0f9d8a',
  'qwen3-8b': '#7c4dff',
  'qwen3-32b': '#d9822b',
};
const FALLBACK_COLOR = '#64748b';

export type NeuronRef = { layer?: string | number; set?: string | null; source?: string | null };

export type LabelEntry = { label: string; href?: string; score?: number | null; explanationId?: string };

export type LabelsFile = {
  format: typeof LABELS_FORMAT;
  host: string | null;
  generatedAt?: string;
  models: Record<string, { layers?: number }>;
  neurons: Record<string, LabelEntry>;
};

export type ParsedLabels = {
  host: string | null;
  models: Record<string, { layers?: number }>;
  neurons: Record<string, LabelEntry>;
};

const stripSlash = (url: string) => url.replace(/\/+$/, '');

/**
 * The Neuronpedia source id for a layer of a source set: raw neurons (`neurons`) are the bare
 * layer number, every other set is `<layer>-<set>`. An explicit `source` wins.
 */
export function sourceId(ref: NeuronRef): string {
  if (ref.source) return String(ref.source).toLowerCase();
  const layer = String(ref.layer ?? '');
  const set = ref.set ? ref.set.toLowerCase() : NEURONS_SET;
  return set === NEURONS_SET ? layer : `${layer}-${set}`;
}

/** The layer number at the front of a source id, or null. */
export function layerOf(source: string): number | null {
  const m = /^(-?\d+)/.exec(source);
  return m ? parseInt(m[1], 10) : null;
}

/** The set name a source id belongs to (`neurons` for a bare layer number). */
export function setOf(source: string): string {
  if (/^-?\d+$/.test(source)) return NEURONS_SET;
  const dash = source.indexOf('-', source.startsWith('-') ? 1 : 0);
  return dash === -1 ? source : source.slice(dash + 1);
}

/** The lookup key a labels file uses: `<model>/<source>/<index>`. */
export function neuronKey(model: string, source: string, index: string | number): string {
  return `${model.toLowerCase()}/${source.toLowerCase()}/${index}`;
}

/** `L16.N1744`; a source with no leading layer number keeps its own name. */
export function formatId(source: string, index: string | number): string {
  const layer = layerOf(source);
  return `${layer === null ? source : `L${layer}`}.N${index}`;
}

/** The neuron's page; an empty host gives a path on the current site. */
export function neuronUrl(host: string, model: string, source: string, index: string | number): string {
  return `${stripSlash(host)}/${encodeURIComponent(model)}/${encodeURIComponent(source)}/${index}`;
}

export function featureApiUrl(host: string, model: string, source: string, index: string | number): string {
  return `${stripSlash(host)}/api/feature/${encodeURIComponent(model)}/${encodeURIComponent(source)}/${index}`;
}

/** Read a labels file; a neuron's value may be a bare label string. Throws on another format. */
export function parseLabels(data: unknown): ParsedLabels {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('labels: expected a JSON object');
  const obj = data as Record<string, unknown>;
  if (obj.format && obj.format !== LABELS_FORMAT) throw new Error(`labels: unknown format ${String(obj.format)}`);
  const neurons: Record<string, LabelEntry> = {};
  Object.entries((obj.neurons as Record<string, unknown>) ?? {}).forEach(([k, v]) => {
    const entry = typeof v === 'string' ? { label: v } : (v as LabelEntry | null);
    if (entry && typeof entry.label === 'string') neurons[k.toLowerCase()] = entry;
  });
  return {
    host: typeof obj.host === 'string' && obj.host ? stripSlash(obj.host) : null,
    models: (obj.models as ParsedLabels['models']) ?? {},
    neurons,
  };
}

/** The label to show from a /api/feature response: its first non-empty explanation. */
export function labelFromFeature(feature: unknown): string | null {
  const exps = ((feature as { explanations?: { description?: unknown }[] } | null)?.explanations ?? []) as {
    description?: unknown;
  }[];
  const hit = exps.find((e) => typeof e?.description === 'string' && e.description.trim());
  return hit ? (hit.description as string).trim() : null;
}

/** How deep the layer sits, 0..1, or null when the model's layer count is unknown. */
export function depth(layer: number | null, layers: number | null | undefined): number | null {
  if (layer === null || !layers) return null;
  return Math.max(0, Math.min(1, (layer + 1) / layers));
}

export function modelColor(model: string): string {
  return MODEL_COLORS[model.toLowerCase()] ?? FALLBACK_COLOR;
}

/** The arc around the chip's dot, as an SVG path on a 16x16 box, or null for no arc. */
export function depthArc(d: number | null): string | null {
  if (d === null) return null;
  if (d >= 0.999) return 'M8 2 A6 6 0 1 1 7.99 2';
  const a = d * 2 * Math.PI;
  return `M8 2 A6 6 0 ${d > 0.5 ? 1 : 0} 1 ${(8 + 6 * Math.sin(a)).toFixed(2)} ${(8 - 6 * Math.cos(a)).toFixed(2)}`;
}

// ---------------------------------------------------------------- label lookups for the React chip

const MAX_PARALLEL = 6;
const featureLabels = new Map<string, Promise<string | null>>();
const waiting: (() => Promise<void>)[] = [];
let running = 0;

function pump() {
  while (running < MAX_PARALLEL && waiting.length) {
    const job = waiting.shift() as () => Promise<void>;
    running += 1;
    job().finally(() => {
      running -= 1;
      pump();
    });
  }
}

/**
 * A neuron's label from the per-neuron API, at most six requests at a time and one per neuron per
 * page load, however many chips name it. A failed request is forgotten so the next render retries.
 */
export function fetchFeatureLabel(
  host: string,
  model: string,
  source: string,
  index: string | number,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const id = `${stripSlash(host)}|${neuronKey(model, source, index)}`;
  const known = featureLabels.get(id);
  if (known) return known;
  const request = new Promise<string | null>((resolve, reject) => {
    waiting.push(() =>
      fetchImpl(featureApiUrl(host, model, source, index))
        .then(async (r) => {
          if (r.status === 404) return null;
          if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
          return labelFromFeature(await r.json());
        })
        .then(resolve, (e) => {
          featureLabels.delete(id);
          reject(e);
        }),
    );
    pump();
  });
  featureLabels.set(id, request);
  return request;
}

/** For tests: forget every cached lookup. */
export function resetFeatureLabelCache() {
  featureLabels.clear();
}
