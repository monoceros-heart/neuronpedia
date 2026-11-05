import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DATASET_BUCKET, datasetsConfig, listLocalDatasets, localDatasetPath } from './s3';

describe('datasetsConfig', () => {
  it("defaults to Neuronpedia's public bucket, unsigned", () => {
    expect(datasetsConfig({})).toEqual({
      kind: 's3',
      bucket: DATASET_BUCKET,
      region: 'us-east-1',
      endpoint: undefined,
      credentials: undefined,
    });
  });

  it('reads another bucket with an endpoint and keys, as for Cloudflare R2', () => {
    expect(
      datasetsConfig({
        NEURONPEDIA_DATASETS_URL: 's3://my-datasets/',
        NEURONPEDIA_DATASETS_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
        NEURONPEDIA_DATASETS_REGION: 'auto',
        NEURONPEDIA_DATASETS_ACCESS_KEY_ID: 'id',
        NEURONPEDIA_DATASETS_SECRET_ACCESS_KEY: 'secret',
      }),
    ).toEqual({
      kind: 's3',
      bucket: 'my-datasets',
      region: 'auto',
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      credentials: { accessKeyId: 'id', secretAccessKey: 'secret' },
    });
  });

  it("ignores the machine's own AWS credentials", () => {
    expect(datasetsConfig({ AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' })).toMatchObject({
      kind: 's3',
      credentials: undefined,
    });
  });

  it('reads a local directory from a file:// URL', () => {
    expect(datasetsConfig({ NEURONPEDIA_DATASETS_URL: 'file:///data/my%20exports/' })).toEqual({
      kind: 'file',
      dir: '/data/my exports',
    });
    expect(() => datasetsConfig({ NEURONPEDIA_DATASETS_URL: 'file://data' })).toThrow('absolute path');
  });

  it('refuses a URL that is not s3://<bucket>, and half a key pair', () => {
    expect(() => datasetsConfig({ NEURONPEDIA_DATASETS_URL: 'gs://data' })).toThrow('s3://<bucket>');
    expect(() => datasetsConfig({ NEURONPEDIA_DATASETS_URL: 's3://b/prefix' })).toThrow('s3://<bucket>');
    expect(() => datasetsConfig({ NEURONPEDIA_DATASETS_ACCESS_KEY_ID: 'id' })).toThrow('or neither');
  });
});

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-datasets-'));
  [
    'v1/config/explanation_type.jsonl',
    'v1/qwen3-8b/model.jsonl',
    'v1/qwen3-8b/18/source.jsonl',
    'v1/qwen3-8b/18/features/batch-0.jsonl.gz',
    'v1/qwen3-8b/18/activations/batch-0.jsonl.gz',
    'v1/qwen3-8b/18/activations/old/batch-0.jsonl.gz',
    'v1/gpt2-small/6-res-jb/source.jsonl',
  ].forEach((key) => {
    fs.mkdirSync(path.join(root, path.dirname(key)), { recursive: true });
    fs.writeFileSync(path.join(root, key), '');
  });
});

describe('listLocalDatasets', () => {
  it('groups by the delimiter like S3 common prefixes', () => {
    expect(listLocalDatasets(root, 'v1/', '/').prefixes).toEqual(['v1/config/', 'v1/gpt2-small/', 'v1/qwen3-8b/']);
    expect(listLocalDatasets(root, 'v1/qwen3-8b/', '/')).toEqual({
      prefixes: ['v1/qwen3-8b/18/'],
      keys: ['v1/qwen3-8b/model.jsonl'],
    });
  });

  it('lists every key under a prefix that is not a whole directory name', () => {
    expect(listLocalDatasets(root, 'v1/qwen3-8b/18/activations').keys).toEqual([
      'v1/qwen3-8b/18/activations/batch-0.jsonl.gz',
      'v1/qwen3-8b/18/activations/old/batch-0.jsonl.gz',
    ]);
  });

  it('returns nothing for a prefix that does not exist', () => {
    expect(listLocalDatasets(root, 'v1/nope/', '/')).toEqual({ prefixes: [], keys: [] });
  });
});

describe('localDatasetPath', () => {
  it('refuses keys that leave the datasets directory', () => {
    expect(localDatasetPath(root, 'v1/qwen3-8b/model.jsonl')).toBe(path.join(root, 'v1/qwen3-8b/model.jsonl'));
    expect(() => localDatasetPath(root, '../etc/passwd')).toThrow('escapes the datasets directory');
    expect(() => localDatasetPath(root, '/etc/passwd')).toThrow('escapes the datasets directory');
  });
});
