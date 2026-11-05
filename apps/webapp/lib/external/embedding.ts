import pgvector from 'pgvector';
import { AZURE_OPENAI_API_KEY, EMBEDDING_PROVIDER, IS_LOCALHOST, OPENAI_API_KEY, OPENROUTER_API_KEY } from '../env';
import { getOpenAIClient } from '../openai-client';
import { EmbeddingsSkippedError, shouldSkipExplanationEmbeddings } from '../utils/embedding-availability';

/** True on a local instance with no embedding key: explanations are saved without an embedding. */
export const EXPLANATION_EMBEDDINGS_SKIPPED = shouldSkipExplanationEmbeddings(IS_LOCALHOST, EMBEDDING_PROVIDER, {
  openai: OPENAI_API_KEY,
  azure: AZURE_OPENAI_API_KEY,
  openrouter: OPENROUTER_API_KEY,
});

const VALID_EMBEDDING_MODELS = ['text-embedding-3-large'];

export async function getOAIEmbedding(embeddingModel: string, dimensions: number, text: string | string[]) {
  if (!VALID_EMBEDDING_MODELS.includes(embeddingModel)) {
    throw new Error('Invalid embedding model');
  }
  // if text is empty string or array, return an empty array
  if (Array.isArray(text) && text.length === 0) {
    return [];
  }
  const openAIClient = getOpenAIClient();
  // TODO: this fails silently when the key is invalid
  const response = await openAIClient.embeddings.create({
    input: text,
    model: embeddingModel,
    dimensions,
  });
  const queryEmbeddingResult = response.data.map((v: any) => v.embedding);
  if (queryEmbeddingResult.length === 0) {
    throw new Error('No embedding result found');
  }
  // if we have an array of strings, return an array of arrays
  if (Array.isArray(text)) {
    return queryEmbeddingResult.map((v: number[]) => v as number[]);
  }
  // otherwise just return the first one
  return queryEmbeddingResult[0] as number[];
}

/**
 * The embedding of an explanation being saved, as SQL, or null when embeddings are skipped (see
 * EXPLANATION_EMBEDDINGS_SKIPPED); the caller then leaves the column null.
 */
export async function getExplanationEmbeddingSql(explanation: string): Promise<string | null> {
  if (EXPLANATION_EMBEDDINGS_SKIPPED) {
    return null;
  }
  return pgvector.toSql(await getOAIEmbedding('text-embedding-3-large', 256, explanation));
}

/** The embedding of a search query, as SQL. Search has no fallback, so this throws when skipped. */
export async function getSearchQueryEmbeddingSql(query: string): Promise<string> {
  if (EXPLANATION_EMBEDDINGS_SKIPPED) {
    throw new EmbeddingsSkippedError();
  }
  return pgvector.toSql(await getOAIEmbedding('text-embedding-3-large', 256, query));
}

export async function getExplanationEmbedding(explanation: string) {
  return getOAIEmbedding('text-embedding-3-large', 256, explanation);
}
