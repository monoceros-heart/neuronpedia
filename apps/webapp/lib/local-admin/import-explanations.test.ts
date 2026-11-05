import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportDb, importExplanations, parseImportFile, parseImportLine } from './import-explanations';

describe('parseImportLine', () => {
  it('reads a full line, taking numeric layer and index as strings', () => {
    const line = parseImportLine(
      JSON.stringify({
        modelId: 'Qwen3-8B',
        layer: 18,
        index: 7807,
        description: 'eternal, divine',
        typeName: 'np_max-act-logits',
        scores: [{ typeName: 'recall_alt', modelName: 'opus', value: 0.8, jsonDetails: { n: 50 } }],
      }),
      1,
    );
    expect(line).toMatchObject({ modelId: 'qwen3-8b', layer: '18', index: '7807', typeName: 'np_max-act-logits' });
    expect(line.scores).toEqual([{ typeName: 'recall_alt', modelName: 'opus', value: 0.8, jsonDetails: { n: 50 } }]);
  });

  it('names the line and the field that is wrong', () => {
    expect(() => parseImportLine('{"modelId":"m","layer":"1","index":"2"}', 7)).toThrow(
      'Line 7: missing "description"',
    );
    expect(() =>
      parseImportLine('{"modelId":"m","layer":"1","index":"2","description":"d","scores":[{"typeName":"t"}]}', 2),
    ).toThrow('scores[0] needs "typeName" and "modelName"');
    expect(() => parseImportLine('[1]', 3)).toThrow('expected a JSON object');
  });
});

describe('parseImportFile', () => {
  it('skips blank lines and reports every bad line before importing anything', () => {
    expect(parseImportFile('\n{"modelId":"m","layer":"1","index":"2","description":"d"}\n\n')).toHaveLength(1);
    expect(() => parseImportFile('nope\n{"modelId":"m"}')).toThrow(/2 bad line\(s\)[\s\S]*Line 1[\s\S]*Line 2/);
  });
});

function mockDb() {
  const db = {
    user: { findUnique: vi.fn(async () => ({ id: 'bot-id' })) },
    source: { findUnique: vi.fn(async () => ({ setName: 'neurons' })) },
    neuron: { findUnique: vi.fn(async () => null), create: vi.fn() },
    explanation: {
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
      create: vi.fn(async () => ({ id: 'new-exp' })),
      update: vi.fn(async () => ({ id: 'old-exp' })),
    },
    explanationType: { findMany: vi.fn(async () => [{ name: 'np_max-act-logits' }]) },
    explanationScoreType: { findMany: vi.fn(async () => [{ name: 'recall_alt' }]) },
    explanationModelType: { findMany: vi.fn(async () => [{ name: 'opus' }]) },
    explanationScoreModel: { findMany: vi.fn(async () => [{ name: 'opus' }]) },
    explanationScore: { deleteMany: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  };
  // One mock client serves as both the top-level client and the transaction client.
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
  return db;
}

const LINE = {
  modelId: 'm',
  layer: '18',
  index: '7807',
  description: 'eternal',
  typeName: 'np_max-act-logits',
  explanationModelName: 'opus',
  scores: [{ typeName: 'recall_alt', modelName: 'opus', value: 0.8, jsonDetails: { n: 50 } }],
};

let db: ReturnType<typeof mockDb>;
const asDb = () => db as unknown as ImportDb;
beforeEach(() => {
  db = mockDb();
});

describe('importExplanations', () => {
  it('creates the neuron row in its source set, the explanation and its score, in one transaction', async () => {
    const result = await importExplanations(asDb(), [LINE], { authorName: 'bot' });

    expect(result).toEqual({ explanationsCreated: 1, explanationsUpdated: 0, scoresWritten: 1, neuronsCreated: 1 });
    expect(db.neuron.create).toHaveBeenCalledWith({
      data: { modelId: 'm', layer: '18', index: '7807', sourceSetName: 'neurons', creatorId: 'bot-id' },
    });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.explanationScore.create.mock.calls[0]).toEqual([
      {
        data: {
          explanationId: 'new-exp',
          explanationScoreTypeName: 'recall_alt',
          explanationScoreModelName: 'opus',
          value: 0.8,
          initiatedByUserId: 'bot-id',
          jsonDetails: '{"n":50}',
        },
      },
    ]);
  });

  it('updates a matching explanation and replaces its scores on a re-import', async () => {
    db.neuron.findUnique.mockResolvedValue({ index: '7807' } as never);
    db.explanation.findFirst.mockResolvedValue({ id: 'old-exp' });

    const result = await importExplanations(asDb(), [LINE], { authorName: 'bot' });

    expect(result).toEqual({ explanationsCreated: 0, explanationsUpdated: 1, scoresWritten: 1, neuronsCreated: 0 });
    expect(db.explanation.create).not.toHaveBeenCalled();
    expect(db.explanationScore.deleteMany).toHaveBeenCalledWith({
      where: { explanationId: 'old-exp', explanationScoreTypeName: 'recall_alt', explanationScoreModelName: 'opus' },
    });
  });

  it('writes nothing when a type, model or source is missing, and lists all of them', async () => {
    db.explanationType.findMany.mockResolvedValue([]);
    db.explanationScoreType.findMany.mockResolvedValue([]);
    db.explanationModelType.findMany.mockResolvedValue([]);
    db.explanationScoreModel.findMany.mockResolvedValue([]);
    db.source.findUnique.mockResolvedValue(null as never);

    await expect(importExplanations(asDb(), [LINE], { authorName: 'bot' })).rejects.toThrow(
      /explanation type "np_max-act-logits"[\s\S]*score type "recall_alt"[\s\S]*explainer model "opus"[\s\S]*scorer model "opus"[\s\S]*source "18" of model "m"/,
    );
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('needs an existing author', async () => {
    db.user.findUnique.mockResolvedValue(null as never);
    await expect(importExplanations(asDb(), [LINE], { authorName: 'nobody' })).rejects.toThrow(
      'No user named "nobody"',
    );
  });
});
