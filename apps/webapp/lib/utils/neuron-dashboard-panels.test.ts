import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/neuron-dashboard-qwen3-32b-31-12345.json';
import { gatePoints, quadrantOf, quadrantShares, silu } from './neuron-dashboard-panels';
import { NeuronDashboardRecord, recordToNeuronDashboard } from './neuron-dashboards';

const record = fixture.record as NeuronDashboardRecord;
const vocab: string[] = [];
Object.entries(fixture.vocab).forEach(([id, token]) => {
  vocab[Number(id)] = token;
});
const ids = { modelId: 'qwen3-32b', layer: '31', index: '12345' };

describe('quadrantOf', () => {
  it('counts a zero gate as closed', () => {
    expect(quadrantOf(0, 1)).toBe('g−u+');
    expect(quadrantOf(-2, -3)).toBe('g−u−');
    expect(quadrantOf(2, -3)).toBe('g+u−');
  });
});

describe('gatePoints', () => {
  const points = gatePoints(record, vocab, ids);

  it('has a point per example, echoes included', () => {
    const bandCount = record.bands.reduce((s, b) => s + b.examples.length, 0);
    expect(points).toHaveLength(
      record.top.length + bandCount + record.bottom.length + record.echo_top.length + record.echo_bottom.length,
    );
  });

  it('matches every activation row id and leaves echoes without one', () => {
    const rowIds = new Set(recordToNeuronDashboard(record, vocab, ids).activations.map((a) => a.id));
    points.filter((p) => p.activationId).forEach((p) => expect(rowIds.has(p.activationId!)).toBe(true));
    expect(points.filter((p) => p.activationId === null).every((p) => p.kind.startsWith('echo'))).toBe(true);
  });

  it('agrees with a = silu(g) * u at the peak within the file rounding', () => {
    points.forEach((p) => expect(Math.abs(silu(p.g) * p.u - p.a)).toBeLessThan(0.02 * Math.max(1, Math.abs(p.a))));
  });

  it('puts echoes on the closed side of the gate', () => {
    points.filter((p) => p.kind.startsWith('echo')).forEach((p) => expect(p.g).toBeLessThanOrEqual(0));
  });
});

describe('quadrantShares', () => {
  it('maps open/closed and the sign of a onto g and u', () => {
    const shares = Object.fromEntries(quadrantShares(record).map((q) => [q.quadrant, q.tokens]));
    const sum = (c: number[]) => c.reduce((s, v) => s + v, 0);
    expect(shares['g+u+']).toBe(sum(record.hist.open_pos));
    expect(shares['g−u−']).toBe(sum(record.hist.closed_pos));
    expect(shares['g−u+']).toBe(sum(record.hist.closed_neg));
    expect(quadrantShares(record).reduce((s, q) => s + q.share, 0)).toBeCloseTo(1, 9);
  });
});
