import { UserSecretType, Visibility } from '@prisma/client';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addModelWithNeurons, Db, ensureUserKey, updateSourceSet, writeSecretFile } from './local-admin';

type UpsertArgs = { where: Record<string, unknown>; update: Record<string, unknown>; create: Record<string, unknown> };

// One mock client serves as both the top-level client and the transaction client.
function mockDb() {
  const db = {
    user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    userSecret: { findUnique: vi.fn(), upsert: vi.fn() },
    model: {
      upsert: vi.fn(
        async (_args: UpsertArgs): Promise<{ id?: string; defaultSourceSetName: string | null }> => ({
          defaultSourceSetName: null,
        }),
      ),
      update: vi.fn(async ({ where }) => ({ id: where.id, layers: 3 })),
    },
    sourceSet: {
      findUnique: vi.fn(),
      upsert: vi.fn(async (_args: UpsertArgs) => ({ visibility: 'PUBLIC', allowInferenceSearch: false })),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => args),
    },
    source: { createMany: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
  return db;
}

let db: ReturnType<typeof mockDb>;
const asDb = () => db as unknown as Db;

beforeEach(() => {
  db = mockDb();
  db.user.findUnique.mockImplementation(async ({ where }) =>
    where.name === 'bot' ? { id: 'bot-id', admin: true } : null,
  );
});

describe('ensureUserKey', () => {
  it('creates the user and a key in the sk-np- format', async () => {
    db.userSecret.findUnique.mockResolvedValue(null);
    const result = await ensureUserKey(asDb(), { username: 'Local', admin: true });

    expect(db.user.create).toHaveBeenCalledWith({
      data: { name: 'local', admin: true, emailNewsletterNotification: false },
    });
    expect(result.key).toMatch(/^sk-np-[A-Za-z0-9]{44}$/);
    expect(result).toMatchObject({ username: 'local', admin: true, createdUser: true, createdKey: true });
    expect(db.userSecret.upsert.mock.calls[0][0].create).toEqual({
      username: 'local',
      type: UserSecretType.NEURONPEDIA,
      value: result.key,
    });
  });

  it('hands back the existing key unless asked to rotate', async () => {
    db.user.findUnique.mockResolvedValue({ id: 'u', admin: false });
    db.userSecret.findUnique.mockResolvedValue({ value: 'sk-np-existing' });

    const reused = await ensureUserKey(asDb(), { username: 'local' });
    expect(reused).toMatchObject({ key: 'sk-np-existing', createdUser: false, createdKey: false });
    expect(db.userSecret.upsert).not.toHaveBeenCalled();

    const rotated = await ensureUserKey(asDb(), { username: 'local', rotate: true });
    expect(rotated.key).not.toBe('sk-np-existing');
    expect(db.userSecret.upsert).toHaveBeenCalledTimes(1);
  });

  it('grants admin to an existing user but never takes it away', async () => {
    db.user.findUnique.mockResolvedValue({ id: 'u', admin: false });
    db.userSecret.findUnique.mockResolvedValue({ value: 'k' });
    await ensureUserKey(asDb(), { username: 'local', admin: true });
    expect(db.user.update).toHaveBeenCalledWith({ where: { name: 'local' }, data: { admin: true } });

    db.user.update.mockClear();
    db.user.findUnique.mockResolvedValue({ id: 'b', admin: true });
    const result = await ensureUserKey(asDb(), { username: 'bot', admin: false });
    expect(db.user.update).not.toHaveBeenCalled();
    expect(result.admin).toBe(true);
  });

  it('rejects names the webapp would reject', async () => {
    await expect(ensureUserKey(asDb(), { username: 'has space' })).rejects.toThrow('not a valid username');
  });
});

describe('addModelWithNeurons', () => {
  it('creates the model, a neurons set and one source per layer, then makes the set the default', async () => {
    await addModelWithNeurons(asDb(), {
      id: 'Qwen3-0.6B',
      layers: 3,
      neuronsPerLayer: 3072,
      hfRepoId: 'Qwen/Qwen3-0.6B',
      dashboardsUrl: 'http://127.0.0.1:3001/v2/qwen3-0.6b',
    });

    const model = db.model.upsert.mock.calls[0][0];
    expect(model.where).toEqual({ id: 'qwen3-0.6b' });
    expect(model.create).toMatchObject({
      creatorId: 'bot-id',
      layers: 3,
      neuronsPerLayer: 3072,
      hfRepoId: 'Qwen/Qwen3-0.6B',
      visibility: Visibility.PUBLIC,
      inferenceEnabled: false,
    });
    expect(db.sourceSet.upsert.mock.calls[0][0].create).toMatchObject({
      modelId: 'qwen3-0.6b',
      name: 'neurons',
      externalDashboardsUrl: 'http://127.0.0.1:3001/v2/qwen3-0.6b',
    });
    const sources = db.source.createMany.mock.calls[0][0];
    expect(sources.data.map((s: { id: string }) => s.id)).toEqual(['0', '1', '2']);
    expect(sources.skipDuplicates).toBe(true);
    expect(db.model.update).toHaveBeenCalledWith({
      where: { id: 'qwen3-0.6b' },
      data: { defaultSourceSetName: 'neurons', defaultSourceId: '0' },
    });
  });

  it('changes only the options it was given on a second run', async () => {
    await addModelWithNeurons(asDb(), { id: 'm', layers: 3, neuronsPerLayer: 8 });

    expect(db.model.upsert.mock.calls[0][0].update).toEqual({ layers: 3, neuronsPerLayer: 8 });
    expect(db.sourceSet.upsert.mock.calls[0][0].update).toEqual({});
    expect(db.source.updateMany).not.toHaveBeenCalled();
  });

  it('turns inference on for the model, set and every source when asked', async () => {
    await addModelWithNeurons(asDb(), { id: 'm', layers: 2, neuronsPerLayer: 8, inference: true });

    expect(db.model.upsert.mock.calls[0][0].update).toMatchObject({ inferenceEnabled: true });
    expect(db.sourceSet.upsert.mock.calls[0][0].update).toEqual({ allowInferenceSearch: true });
    expect(db.source.updateMany).toHaveBeenCalledWith({
      where: { modelId: 'm', setName: 'neurons' },
      data: { inferenceEnabled: true },
    });
  });

  it("keeps a model's existing default, and gives new layers the set's current settings", async () => {
    db.model.upsert.mockResolvedValue({ id: 'm', defaultSourceSetName: 'res-jb' });
    db.sourceSet.upsert.mockResolvedValue({ visibility: Visibility.UNLISTED, allowInferenceSearch: true });
    await addModelWithNeurons(asDb(), { id: 'm', layers: 4, neuronsPerLayer: 8 });

    expect(db.model.update).not.toHaveBeenCalled();
    expect(db.source.createMany.mock.calls[0][0].data[3]).toMatchObject({
      id: '3',
      visibility: Visibility.UNLISTED,
      inferenceEnabled: true,
    });
  });

  it('needs an existing creator', async () => {
    await expect(
      addModelWithNeurons(asDb(), { id: 'm', layers: 1, neuronsPerLayer: 1, creatorName: 'nobody' }),
    ).rejects.toThrow('No user named "nobody"');
  });
});

describe('updateSourceSet', () => {
  beforeEach(() => db.sourceSet.findUnique.mockResolvedValue({ name: 'neurons' }));

  it('sets and clears the dashboards URL', async () => {
    await updateSourceSet(asDb(), { modelId: 'm', setName: 'neurons', dashboardsUrl: 'http://x/v2/m' });
    expect(db.sourceSet.update.mock.calls[0][0].data).toEqual({ externalDashboardsUrl: 'http://x/v2/m' });
    expect(db.source.updateMany).not.toHaveBeenCalled();

    await updateSourceSet(asDb(), { modelId: 'm', setName: 'neurons', dashboardsUrl: null });
    expect(db.sourceSet.update.mock.calls[1][0].data).toEqual({ externalDashboardsUrl: null });
  });

  it('applies inference and visibility to the sources too', async () => {
    await updateSourceSet(asDb(), {
      modelId: 'm',
      setName: 'neurons',
      inference: true,
      visibility: Visibility.UNLISTED,
    });
    expect(db.source.updateMany).toHaveBeenCalledWith({
      where: { modelId: 'm', setName: 'neurons' },
      data: { inferenceEnabled: true, visibility: Visibility.UNLISTED },
    });
    expect(db.model.update).toHaveBeenCalledWith({ where: { id: 'm' }, data: { inferenceEnabled: true } });
  });

  it('refuses a missing set or an empty change', async () => {
    db.sourceSet.findUnique.mockResolvedValueOnce(null);
    await expect(updateSourceSet(asDb(), { modelId: 'm', setName: 'x', inference: true })).rejects.toThrow(
      'has no source set "x"',
    );
    await expect(updateSourceSet(asDb(), { modelId: 'm', setName: 'neurons' })).rejects.toThrow('Nothing to change');
  });
});

describe('writeSecretFile', () => {
  it('writes the secret readable by its owner only, tightening an existing file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-key-'));
    const file = path.join(dir, 'nested', 'local.key');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, 'old', { mode: 0o644 });

    writeSecretFile(file, 'sk-np-abc');
    expect(fs.readFileSync(file, 'utf8')).toBe('sk-np-abc\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
