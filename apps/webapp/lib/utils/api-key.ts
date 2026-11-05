import crypto from 'crypto';

/**
 * A new Neuronpedia API key: `sk-np-` followed by 32 random bytes as base64, with `+`, `/` and
 * `=` replaced by `0` so the key survives URLs, shells and headers unquoted.
 *
 * Shared by sign-up (`authOptions.ts`) and the local admin CLI, so a key minted either way has
 * the same shape.
 */
export function generateNeuronpediaApiKey(): string {
  return `sk-np-${crypto.randomBytes(32).toString('base64').replace(/[+/=]/g, '0')}`;
}
