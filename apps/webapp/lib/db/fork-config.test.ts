import { beforeEach, describe, expect, it, vi } from 'vitest';

const upserts = vi.hoisted(() => ({
  explanationModelType: vi.fn(),
  explanationScoreModel: vi.fn(),
  explanationType: vi.fn(),
  explanationScoreType: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: Object.fromEntries(Object.entries(upserts).map(([table, upsert]) => [table, { upsert }])),
}));

import { DEFAULT_CREATOR_USER_ID } from '@/lib/env';
import { importForkConfig } from './import';

beforeEach(() => Object.values(upserts).forEach((upsert) => upsert.mockClear()));

describe('importForkConfig', () => {
  it("upserts the fork's explainer type, score type and model, owned by the default creator", async () => {
    await importForkConfig();

    expect(upserts.explanationModelType.mock.calls[0][0].where).toEqual({ name: 'claude-opus-5-5' });
    expect(upserts.explanationScoreModel.mock.calls[0][0].where).toEqual({ name: 'claude-opus-5-5' });
    expect(upserts.explanationType.mock.calls[0][0].create).toMatchObject({
      name: 'claude-blind',
      featured: false,
      creatorId: DEFAULT_CREATOR_USER_ID,
    });
    expect(upserts.explanationScoreType.mock.calls[0][0].create).toMatchObject({
      name: 'blind-probe-strong',
      scorerModel: 'claude-opus-5-5',
      featured: false,
      creatorId: DEFAULT_CREATOR_USER_ID,
    });
  });
});
