import { describe, expect, it } from 'vitest';
import { shouldSkipExplanationEmbeddings } from './embedding-availability';

const NO_KEYS = { openai: '', azure: '', openrouter: '' };

describe('shouldSkipExplanationEmbeddings', () => {
  it('skips only in local mode with no key for the provider', () => {
    expect(shouldSkipExplanationEmbeddings(true, 'openai', NO_KEYS)).toBe(true);
    expect(shouldSkipExplanationEmbeddings(true, 'openai', { ...NO_KEYS, openai: 'sk-x' })).toBe(false);
  });

  it('never skips outside local mode, so a missing key stays an error there', () => {
    expect(shouldSkipExplanationEmbeddings(false, 'openai', NO_KEYS)).toBe(false);
  });

  it('checks the key of the configured provider, not any key', () => {
    expect(shouldSkipExplanationEmbeddings(true, 'azure', { ...NO_KEYS, openai: 'sk-x' })).toBe(true);
    expect(shouldSkipExplanationEmbeddings(true, 'openrouter', { ...NO_KEYS, openrouter: 'or-x' })).toBe(false);
  });
});
