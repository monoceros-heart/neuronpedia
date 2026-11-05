/**
 * Whether explanation embeddings are skipped.
 *
 * Every explanation gets an OpenAI embedding so explanation search can find it, which makes a key
 * a hard requirement for writing any explanation. On a local instance with no key, uploads and
 * generated labels should still save, so there, and only there, the embedding is left null and
 * explanation search reports that it needs a key. Anywhere else a missing key stays an error.
 *
 * Nothing fills these in later: explanations saved while no key was set stay out of search even
 * after a key is added.
 */
export function shouldSkipExplanationEmbeddings(
  isLocalMode: boolean,
  provider: 'openai' | 'azure' | 'openrouter',
  keys: { openai: string; azure: string; openrouter: string },
): boolean {
  return isLocalMode && !keys[provider];
}

export const EMBEDDINGS_DISABLED_MESSAGE =
  'Explanation search needs embeddings, which are off on this local instance because no key is set ' +
  'for its EMBEDDING_PROVIDER (OPENAI_API_KEY, AZURE_OPENAI_API_KEY or OPENROUTER_API_KEY).';

/** Thrown by a search when embeddings are skipped; search routes answer it with a 503. */
export class EmbeddingsSkippedError extends Error {
  constructor() {
    super(EMBEDDINGS_DISABLED_MESSAGE);
    this.name = 'EmbeddingsSkippedError';
  }
}
