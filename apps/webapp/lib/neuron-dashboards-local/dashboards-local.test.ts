import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import zlib from 'zlib';
import fixture from '../utils/__fixtures__/neuron-dashboard-qwen3-32b-31-12345.json';
import { checkDashboards, readLayerIndex } from './check';

const LAYERS = 2;
const NEURONS = 5;

/** Writes a dashboard set for `test-model` from the fixture record, one record per neuron. */
function writeDashboardSet(root: string) {
  const base = path.join(root, 'v2', 'test-model');
  fs.mkdirSync(path.join(base, 'neurons'), { recursive: true });
  fs.mkdirSync(path.join(base, 'corpus'), { recursive: true });
  const sparse = fixture.vocab as Record<string, string>;
  const size = Math.max(...Object.keys(sparse).map(Number)) + 1;
  const vocab = Array.from({ length: size }, (_, i) => sparse[String(i)] ?? `<${i}>`);
  fs.writeFileSync(path.join(base, 'corpus', 'vocab.json'), JSON.stringify(vocab));
  for (let layer = 0; layer < LAYERS; layer += 1) {
    const members = Array.from({ length: NEURONS }, (_, neuron) =>
      zlib.gzipSync(JSON.stringify({ ...fixture.record, layer, neuron })),
    );
    const offsets = Buffer.alloc(8 * (NEURONS + 1));
    let at = 0;
    members.forEach((member, i) => {
      offsets.writeBigUInt64LE(BigInt(at), 8 * i);
      at += member.length;
    });
    offsets.writeBigUInt64LE(BigInt(at), 8 * NEURONS);
    const stem = path.join(base, 'neurons', `layer_${String(layer).padStart(2, '0')}`);
    fs.writeFileSync(`${stem}.idx`, offsets);
    fs.writeFileSync(`${stem}.json.gz`, Buffer.concat(members));
  }
}

const URL_BASE = 'http://dashboards.test';
let root: string;
const url = URL_BASE;

/**
 * fetch answered from files under root, with single byte ranges the way http-server or the
 * Cloudflare worker answers them, so the checker runs against real files with no server.
 */
async function fileFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const file = path.join(root, new URL(String(input)).pathname);
  if (!fs.existsSync(file)) return new Response('not found', { status: 404 });
  const bytes = fs.readFileSync(file);
  const range = new Headers(init?.headers).get('range');
  const match = range && /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match) return new Response(bytes, { status: 200, headers: { 'Content-Length': String(bytes.length) } });
  const start = Number(match[1]);
  const end = Math.min(match[2] === '' ? bytes.length - 1 : Number(match[2]), bytes.length - 1);
  if (start >= bytes.length) return new Response(null, { status: 416 });
  return new Response(bytes.subarray(start, end + 1), {
    status: 206,
    headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` },
  });
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-dash-'));
  writeDashboardSet(root);
  vi.stubGlobal('fetch', fileFetch);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('checkDashboards', () => {
  it('loads sampled neurons of every layer through the webapp reader', async () => {
    const report = await checkDashboards(`${url}/v2/test-model`, { sample: 2 });
    expect(report.problems).toEqual([]);
    expect(report.layers.map((l) => [l.layer, l.neurons])).toEqual([
      [0, NEURONS],
      [1, NEURONS],
    ]);
    expect(report.layers[0].checked).toEqual([0, 1, 3, 4]);
    expect(report.layers[0].topLogits[0]).toBe(fixture.record.logits.pos[0][1]);
  });

  it('reports a layer that is asked for and missing', async () => {
    const report = await checkDashboards(`${url}/v2/test-model`, { layers: [1, 7] });
    expect(report.problems).toEqual(['layer 7: no neurons/layer_07.idx']);
  });

  it('reports a gap in the layers and a .json.gz that does not match its index', async () => {
    const from = path.join(root, 'v2', 'test-model');
    const to = path.join(root, 'v2', 'gappy-model');
    fs.cpSync(from, to, { recursive: true });
    fs.renameSync(path.join(to, 'neurons', 'layer_01.idx'), path.join(to, 'neurons', 'layer_03.idx'));
    fs.renameSync(path.join(to, 'neurons', 'layer_01.json.gz'), path.join(to, 'neurons', 'layer_03.json.gz'));
    fs.appendFileSync(path.join(to, 'neurons', 'layer_00.json.gz'), Buffer.from('extra'));

    const report = await checkDashboards(`${url}/v2/gappy-model`, { sample: 1 });
    expect(report.layers.map((l) => l.layer)).toEqual([0, 3]);
    // The moved layer's records still say layer 1, which the reader refuses as well.
    expect(report.problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^layer 0: index ends at byte \d+, but the .json.gz is \d+ bytes$/),
        'layer 1: no neurons/layer_01.idx',
        'layer 2: no neurons/layer_02.idx',
        '3/0: asked for 3/0, got 1/0',
      ]),
    );
  });

  it('flags an index whose offsets do not increase', () => {
    const bad = Buffer.alloc(24);
    bad.writeBigUInt64LE(10n, 0);
    bad.writeBigUInt64LE(5n, 8);
    expect(readLayerIndex(new Uint8Array(bad).buffer).problems[0]).toMatch('does not increase');
  });
});
