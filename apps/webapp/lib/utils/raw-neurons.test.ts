import { describe, expect, it } from 'vitest';
import { GATE_VALUE_KEY, hasBottomPole, parseGateValue, poleShare, quadrantOf, silu } from './raw-neurons';

describe('hasBottomPole', () => {
  it('is true only when some activation is a negative-pole example', () => {
    expect(hasBottomPole([{ dataSource: 'top' }, { dataSource: 'bottom' }])).toBe(true);
    expect(hasBottomPole([{ dataSource: 'top' }, { dataSource: null }])).toBe(false);
    expect(hasBottomPole([])).toBe(false);
    expect(hasBottomPole(undefined)).toBe(false);
  });
});

describe('poleShare', () => {
  it('scores a peak against the corpus max and a trough against the corpus min', () => {
    expect(poleShare(3, 6)).toBe(0.5);
    expect(poleShare(-2, -4)).toBe(0.5);
  });

  it('can exceed 1 when a written text beats the whole corpus', () => {
    expect(poleShare(9, 6)).toBe(1.5);
  });

  it('is 0 on the wrong side or with no corpus extreme', () => {
    expect(poleShare(-1, 6)).toBe(0);
    expect(poleShare(1, -4)).toBe(0);
    expect(poleShare(1, 0)).toBe(0);
    expect(poleShare(1, null)).toBe(0);
  });
});

describe('parseGateValue', () => {
  it('reads g and u from its own key and ignores the logit keys', () => {
    const json = JSON.stringify({ pos: [], [GATE_VALUE_KEY]: { g: -1.5, u: -2, quadCounts: [1, 2, 3, 4] } });
    expect(parseGateValue(json)).toEqual({ g: -1.5, u: -2, quadCounts: [1, 2, 3, 4] });
  });

  it('is null when the row has no gate/value data', () => {
    expect(parseGateValue(null)).toBeNull();
    expect(parseGateValue(JSON.stringify({ pos: [] }))).toBeNull();
    expect(parseGateValue('not json')).toBeNull();
  });

  it('skips rows whose gate curve is not silu', () => {
    const row = (act?: string) => JSON.stringify({ [GATE_VALUE_KEY]: { g: 1, u: 2, act } });
    expect(parseGateValue(row())).toEqual({ g: 1, u: 2 });
    expect(parseGateValue(row('silu'))).toEqual({ g: 1, u: 2, act: 'silu' });
    expect(parseGateValue(row('gelu_tanh'))).toBeNull();
  });
});

describe('silu and quadrants', () => {
  it('leaks a small positive product for a double negative', () => {
    expect(silu(0)).toBe(0);
    expect(silu(-1.2785)).toBeCloseTo(-0.2785, 3);
    expect(silu(-2) * -3).toBeGreaterThan(0);
    expect(quadrantOf(-2, -3)).toBe('g−u−');
    expect(quadrantOf(2, -3)).toBe('g+u−');
  });
});
