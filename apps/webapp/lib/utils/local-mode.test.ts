import { describe, expect, it } from 'vitest';
import { isLocalMode } from './local-mode';

describe('isLocalMode', () => {
  it('keeps the original rule when the flag is unset', () => {
    expect(isLocalMode(undefined, 'http://localhost:3000')).toBe(true);
    expect(isLocalMode(undefined, 'https://www.neuronpedia.org')).toBe(false);
    expect(isLocalMode('', 'http://100.96.206.20:3000')).toBe(false);
  });

  it('turns local mode on at any URL', () => {
    expect(isLocalMode('true', 'http://100.96.206.20:3000')).toBe(true);
    expect(isLocalMode(' TRUE ', 'http://monoceros.local:3000')).toBe(true);
  });

  it('turns local mode off even at localhost', () => {
    expect(isLocalMode('false', 'http://localhost:3000')).toBe(false);
    expect(isLocalMode('0', 'http://localhost:3000')).toBe(false);
  });

  it('ignores a value it does not understand', () => {
    expect(isLocalMode('maybe', 'http://localhost:3000')).toBe(true);
    expect(isLocalMode('maybe', 'http://10.0.0.2:3000')).toBe(false);
  });

  it('is never on in a Vercel production or preview build', () => {
    expect(isLocalMode('true', 'https://www.neuronpedia.org', 'production')).toBe(false);
    expect(isLocalMode(undefined, 'http://localhost:3000', 'preview')).toBe(false);
    expect(isLocalMode('true', 'http://localhost:3000', 'development')).toBe(true);
  });
});
