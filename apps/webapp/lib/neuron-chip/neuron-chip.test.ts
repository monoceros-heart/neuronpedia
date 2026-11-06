import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vm from 'vm';
import * as ts from './neuron-chip';

/** The web component's helpers, loaded the way a non-browser host sees the file. */
function loadWebComponentHelpers() {
  const code = fs.readFileSync(path.join(import.meta.dirname, '../../public/np-neuron.js'), 'utf8');
  const context: { globalThis?: unknown; NpNeuron?: typeof ts & { FORMAT: string } } = {};
  context.globalThis = context;
  vm.runInNewContext(code, context);
  if (!context.NpNeuron) throw new Error('np-neuron.js did not expose NpNeuron');
  return context.NpNeuron;
}

const js = loadWebComponentHelpers();

// Every case runs against both copies, so the web component and the React chip cannot drift.
describe.each([
  ['lib/neuron-chip (React)', ts],
  ['public/np-neuron.js (web component)', js],
])('%s', (_name, h) => {
  it('names raw neurons by bare layer and other sets as <layer>-<set>', () => {
    expect(h.sourceId({ layer: 16 })).toBe('16');
    expect(h.sourceId({ layer: '16', set: 'neurons' })).toBe('16');
    expect(h.sourceId({ layer: 18, set: 'NeuronPersonas' })).toBe('18-neuronpersonas');
    expect(h.sourceId({ layer: 6, set: 'res-jb' })).toBe('6-res-jb');
    expect(h.sourceId({ layer: 6, set: 'res-jb', source: '7-RES-JB' })).toBe('7-res-jb');
  });

  it('reads layer and set back out of a source id', () => {
    expect(h.layerOf('16')).toBe(16);
    expect(h.layerOf('18-neuronpersonas')).toBe(18);
    expect(h.layerOf('embed-res')).toBeNull();
    expect(h.setOf('16')).toBe('neurons');
    expect(h.setOf('18-neuronpersonas')).toBe('neuronpersonas');
    expect(h.setOf('9-mi-canonical-neg')).toBe('mi-canonical-neg');
  });

  it("formats Paul's example as L16.N1744", () => {
    expect(h.formatId('16', 1744)).toBe('L16.N1744');
    expect(h.formatId('18-neuronpersonas', '7807')).toBe('L18.N7807');
    expect(h.formatId('embed-res', 3)).toBe('embed-res.N3');
  });

  it('keys and links neurons the way the webapp routes them', () => {
    expect(h.neuronKey('Qwen3-8B', '16', 1744)).toBe('qwen3-8b/16/1744');
    expect(h.neuronUrl('http://100.96.206.20:3000/', 'qwen3-8b', '16', 1744)).toBe(
      'http://100.96.206.20:3000/qwen3-8b/16/1744',
    );
    expect(h.featureApiUrl('https://www.neuronpedia.org', 'qwen3-32b', '4', 8476)).toBe(
      'https://www.neuronpedia.org/api/feature/qwen3-32b/4/8476',
    );
  });

  it('parses a labels file, accepting bare strings and lower-casing keys', () => {
    const parsed = h.parseLabels({
      format: 'np-labels/1',
      host: 'http://100.96.206.20:3000/',
      models: { 'qwen3-8b': { layers: 36 } },
      neurons: {
        'qwen3-8b/16/1744': { label: 'Wind Whisperer', score: 0.8 },
        'QWEN3-8B/18-neuronpersonas/7807': 'eternal, divine',
        'qwen3-8b/1/1': { notALabel: true },
      },
    });
    expect(parsed.host).toBe('http://100.96.206.20:3000');
    expect(parsed.models['qwen3-8b'].layers).toBe(36);
    expect(parsed.neurons['qwen3-8b/16/1744'].label).toBe('Wind Whisperer');
    expect(parsed.neurons['qwen3-8b/18-neuronpersonas/7807'].label).toBe('eternal, divine');
    expect(parsed.neurons['qwen3-8b/1/1']).toBeUndefined();
    expect(() => h.parseLabels({ format: 'something-else' })).toThrow(/unknown format/);
    expect(() => h.parseLabels([])).toThrow(/JSON object/);
  });

  it('takes the first non-empty explanation from a feature response', () => {
    expect(h.labelFromFeature({ explanations: [{ description: '  ' }, { description: ' Wind Whisperer ' }] })).toBe(
      'Wind Whisperer',
    );
    expect(h.labelFromFeature({ explanations: [] })).toBeNull();
    expect(h.labelFromFeature(null)).toBeNull();
  });

  it('places the layer on the depth ring only when the layer count is known', () => {
    expect(h.depth(16, 36)).toBeCloseTo(17 / 36);
    expect(h.depth(35, 36)).toBe(1);
    expect(h.depth(16, null)).toBeNull();
    expect(h.depth(null, 36)).toBeNull();
    expect(h.MODEL_LAYERS['qwen3-8b']).toBe(36);
    expect(h.modelColor('Qwen3-8B')).toBe(h.modelColor('qwen3-8b'));
  });
});

describe('fetchFeatureLabel', () => {
  afterEach(() => ts.resetFeatureLabelCache());

  const response = (status: number, body: unknown) =>
    ({ ok: status < 400, status, statusText: String(status), json: async () => body }) as Response;

  it('asks once per neuron however many chips name it', async () => {
    const fetchImpl = vi.fn(async () => response(200, { explanations: [{ description: 'Wind Whisperer' }] }));
    const results = await Promise.all(
      [1, 2, 3].map(() => ts.fetchFeatureLabel('', 'qwen3-8b', '16', 1744, fetchImpl as unknown as typeof fetch)),
    );
    expect(results).toEqual(['Wind Whisperer', 'Wind Whisperer', 'Wind Whisperer']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('/api/feature/qwen3-8b/16/1744');
  });

  it('runs at most six requests at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => {
        setTimeout(r, 5);
      });
      inFlight -= 1;
      return response(200, { explanations: [{ description: 'x' }] });
    });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        ts.fetchFeatureLabel('', 'qwen3-8b', '16', i, fetchImpl as unknown as typeof fetch),
      ),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(20);
    expect(peak).toBe(6);
  });

  it('treats a 404 as no label, and forgets a failure so it can retry', async () => {
    const missing = vi.fn(async () => response(404, {}));
    expect(await ts.fetchFeatureLabel('', 'qwen3-8b', '16', 1, missing as unknown as typeof fetch)).toBeNull();

    const failing = vi.fn(async () => response(500, {}));
    await expect(ts.fetchFeatureLabel('', 'qwen3-8b', '16', 2, failing as unknown as typeof fetch)).rejects.toThrow(
      /500/,
    );
    const ok = vi.fn(async () => response(200, { explanations: [{ description: 'back' }] }));
    expect(await ts.fetchFeatureLabel('', 'qwen3-8b', '16', 2, ok as unknown as typeof fetch)).toBe('back');
  });
});
