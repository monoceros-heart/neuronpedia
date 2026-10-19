import { describe, expect, it } from 'vitest';
import { hasBottomPole, poleShare } from './raw-neurons';

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
