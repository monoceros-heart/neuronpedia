/**
 * Import explanations, and the scores that go with them, from a JSONL file into a local database.
 *
 * This is an admin job rather than an API: there is no public route for writing scores, and this
 * is meant for loading an offline pipeline's output into an instance you run. One line per
 * explanation:
 *
 *   {"modelId": "qwen3-8b", "layer": "18", "index": "7807",
 *    "description": "eternal, divine", "typeName": "np_max-act-logits",
 *    "explanationModelName": "claude-opus", "notes": "optional",
 *    "scores": [{"typeName": "recall_alt", "modelName": "claude-opus", "value": 0.82,
 *                "jsonDetails": {"any": "json"}}]}
 *
 * - `typeName` and each score's `typeName` must name an existing explanation or score type, such
 *   as `np_max-act-logits` or `recall_alt`. These rows come from Neuronpedia's dataset config,
 *   loaded by Sync Config on /admin (and by every source import), which also loads this fork's own
 *   `claude-blind` and `blind-probe-strong` from `lib/db/fork-config.ts`. The generate and score
 *   routes switch on their names, so a type is a method in code rather than something to add here.
 * - Model names (`explanationModelName`, a score's `modelName`) must exist too. They come from the
 *   same config (`explanation_model_type.jsonl`, `explanation_score_model.jsonl`), and refusing an
 *   unknown one catches a typo before it splits scores across two labels.
 * - The neuron's layer must be a Source of the model (`make model-add`); its Neuron row is created
 *   if it isn't there yet.
 * - Re-importing a line updates it instead of duplicating it: an explanation is matched on neuron,
 *   type, description and author, and its scores are replaced per score type and model. A score
 *   left out of the file is kept.
 * - All or nothing: every reference is checked before anything is written, and the writes run in
 *   one transaction.
 * - Embeddings are left null, so imported explanations don't show up in explanation search.
 *
 * Imported by relative path from ts-node, so this file must not use the `@/` alias.
 */
import { PrismaClient } from '@prisma/client';

export type ImportScore = { typeName: string; modelName: string; value: number; jsonDetails?: unknown };

export type ImportLine = {
  modelId: string;
  layer: string;
  index: string;
  description: string;
  typeName?: string;
  explanationModelName?: string;
  notes?: string;
  scores: ImportScore[];
};

export type ImportDb = Pick<
  PrismaClient,
  | 'user'
  | 'source'
  | 'neuron'
  | 'explanation'
  | 'explanationType'
  | 'explanationScoreType'
  | 'explanationModelType'
  | 'explanationScoreModel'
  | 'explanationScore'
  | '$transaction'
>;

const asString = (value: unknown) => (typeof value === 'number' ? String(value) : value);

/** Parse and check one JSONL line; `lineNumber` is for the error message. */
export function parseImportLine(raw: string, lineNumber: number): ImportLine {
  const fail = (why: string): never => {
    throw new Error(`Line ${lineNumber}: ${why}`);
  };
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    return fail('not valid JSON');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return fail('expected a JSON object');
  }
  const str = (key: string, required: boolean) => {
    const value = asString(data[key]);
    if (value === undefined || value === null) {
      return required ? fail(`missing "${key}"`) : undefined;
    }
    if (typeof value !== 'string' || (required && value.trim() === '')) {
      return fail(`"${key}" must be a non-empty string`);
    }
    return value;
  };

  const scoresRaw = data.scores ?? [];
  if (!Array.isArray(scoresRaw)) {
    return fail('"scores" must be a list');
  }
  const scores = scoresRaw.map((score, i): ImportScore => {
    const s = score as Record<string, unknown>;
    if (typeof s?.typeName !== 'string' || typeof s?.modelName !== 'string') {
      return fail(`scores[${i}] needs "typeName" and "modelName"`);
    }
    if (typeof s.value !== 'number' || !Number.isFinite(s.value)) {
      return fail(`scores[${i}].value must be a number`);
    }
    return { typeName: s.typeName, modelName: s.modelName, value: s.value, jsonDetails: s.jsonDetails };
  });

  return {
    modelId: (str('modelId', true) as string).toLowerCase(),
    layer: str('layer', true) as string,
    index: str('index', true) as string,
    description: str('description', true) as string,
    typeName: str('typeName', false),
    explanationModelName: str('explanationModelName', false),
    notes: str('notes', false),
    scores,
  };
}

/** Parse a whole JSONL file's text, skipping blank lines; reports every bad line at once. */
export function parseImportFile(text: string): ImportLine[] {
  const lines: ImportLine[] = [];
  const errors: string[] = [];
  text.split('\n').forEach((raw, i) => {
    if (raw.trim() === '') return;
    try {
      lines.push(parseImportLine(raw, i + 1));
    } catch (e) {
      errors.push((e as Error).message);
    }
  });
  if (errors.length > 0) {
    throw new Error(`${errors.length} bad line(s), nothing imported:\n${errors.slice(0, 20).join('\n')}`);
  }
  return lines;
}

export type ImportResult = {
  explanationsCreated: number;
  explanationsUpdated: number;
  scoresWritten: number;
  neuronsCreated: number;
};

/**
 * Check that every referenced type and source exists before writing anything, so a typo fails
 * the whole file instead of leaving half of it imported.
 */
async function checkReferences(db: ImportDb, lines: ImportLine[]): Promise<Map<string, string>> {
  const unique = <T>(values: (T | undefined)[]) => Array.from(new Set(values.filter((v): v is T => v !== undefined)));
  const missing: string[] = [];

  const types = unique(lines.map((l) => l.typeName));
  const foundTypes = await db.explanationType.findMany({ where: { name: { in: types } }, select: { name: true } });
  types
    .filter((t) => !foundTypes.some((f) => f.name === t))
    .forEach((t) => missing.push(`explanation type "${t}" (Sync Config on /admin loads Neuronpedia's types)`));

  const scoreTypes = unique(lines.flatMap((l) => l.scores.map((s) => s.typeName)));
  const foundScoreTypes = await db.explanationScoreType.findMany({
    where: { name: { in: scoreTypes } },
    select: { name: true },
  });
  scoreTypes
    .filter((t) => !foundScoreTypes.some((f) => f.name === t))
    .forEach((t) => missing.push(`score type "${t}" (Sync Config on /admin loads Neuronpedia's types)`));

  const explanationModels = unique(lines.map((l) => l.explanationModelName));
  const foundExplanationModels = await db.explanationModelType.findMany({
    where: { name: { in: explanationModels } },
    select: { name: true },
  });
  explanationModels
    .filter((m) => !foundExplanationModels.some((f) => f.name === m))
    .forEach((m) => missing.push(`explainer model "${m}" (Sync Config on /admin loads Neuronpedia's models)`));

  const scoreModels = unique(lines.flatMap((l) => l.scores.map((s) => s.modelName)));
  const foundScoreModels = await db.explanationScoreModel.findMany({
    where: { name: { in: scoreModels } },
    select: { name: true },
  });
  scoreModels
    .filter((m) => !foundScoreModels.some((f) => f.name === m))
    .forEach((m) => missing.push(`scorer model "${m}" (Sync Config on /admin loads Neuronpedia's models)`));

  // The source set of each neuron, read from its Source, for the Neuron rows created below.
  const setNames = new Map<string, string>();
  const sources = unique(lines.map((l) => `${l.modelId}\u0000${l.layer}`));
  await Promise.all(
    sources.map(async (key) => {
      const [modelId, layer] = key.split('\u0000');
      const source = await db.source.findUnique({
        where: { modelId_id: { modelId, id: layer } },
        select: { setName: true },
      });
      if (source) setNames.set(key, source.setName);
      else missing.push(`source "${layer}" of model "${modelId}" (make model-add)`);
    }),
  );

  if (missing.length > 0) {
    throw new Error(`Missing, nothing imported:\n  ${missing.join('\n  ')}`);
  }
  return setNames;
}

export async function importExplanations(
  db: ImportDb,
  lines: ImportLine[],
  opts: { authorName: string },
): Promise<ImportResult> {
  const author = await db.user.findUnique({ where: { name: opts.authorName }, select: { id: true } });
  if (!author) {
    throw new Error(`No user named "${opts.authorName}". Create one with: make user-key NAME=${opts.authorName}`);
  }
  const setNames = await checkReferences(db, lines);

  const result: ImportResult = { explanationsCreated: 0, explanationsUpdated: 0, scoresWritten: 0, neuronsCreated: 0 };

  await db.$transaction(
    async (tx) => {
      // Sequential on purpose: lines may share a neuron, and the counts stay exact.
      for (const line of lines) {
        const neuronKey = { modelId: line.modelId, layer: line.layer, index: line.index };
        // eslint-disable-next-line no-await-in-loop
        const neuron = await tx.neuron.findUnique({
          where: { modelId_layer_index: neuronKey },
          select: { index: true },
        });
        if (!neuron) {
          // eslint-disable-next-line no-await-in-loop
          await tx.neuron.create({
            data: {
              ...neuronKey,
              sourceSetName: setNames.get(`${line.modelId}\u0000${line.layer}`) as string,
              creatorId: author.id,
            },
          });
          result.neuronsCreated += 1;
        }

        const fields = {
          notes: line.notes ?? null,
          explanationModelName: line.explanationModelName ?? null,
        };
        // eslint-disable-next-line no-await-in-loop
        const existing = await tx.explanation.findFirst({
          where: { ...neuronKey, typeName: line.typeName ?? null, description: line.description, authorId: author.id },
          select: { id: true },
        });
        const explanation = existing
          ? // eslint-disable-next-line no-await-in-loop
            await tx.explanation.update({ where: { id: existing.id }, data: fields, select: { id: true } })
          : // eslint-disable-next-line no-await-in-loop
            await tx.explanation.create({
              data: {
                ...neuronKey,
                description: line.description,
                typeName: line.typeName ?? null,
                authorId: author.id,
                ...fields,
              },
              select: { id: true },
            });
        if (existing) result.explanationsUpdated += 1;
        else result.explanationsCreated += 1;

        for (const score of line.scores) {
          // eslint-disable-next-line no-await-in-loop
          await tx.explanationScore.deleteMany({
            where: {
              explanationId: explanation.id,
              explanationScoreTypeName: score.typeName,
              explanationScoreModelName: score.modelName,
            },
          });
          // eslint-disable-next-line no-await-in-loop
          await tx.explanationScore.create({
            data: {
              explanationId: explanation.id,
              explanationScoreTypeName: score.typeName,
              explanationScoreModelName: score.modelName,
              value: score.value,
              initiatedByUserId: author.id,
              jsonDetails: score.jsonDetails === undefined ? '' : JSON.stringify(score.jsonDetails),
            },
          });
          result.scoresWritten += 1;
        }
      }
    },
    // Long enough for a file of thousands of lines, written one at a time.
    { timeout: 10 * 60 * 1000 },
  );
  return result;
}
