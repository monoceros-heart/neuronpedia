import { describe, expect, it } from 'vitest';
import { DATASET_BUCKET, datasetsConfig } from './s3';

describe('datasetsConfig', () => {
  it("defaults to Neuronpedia's public bucket, unsigned", () => {
    expect(datasetsConfig({})).toEqual({
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
      bucket: 'my-datasets',
      region: 'auto',
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      credentials: { accessKeyId: 'id', secretAccessKey: 'secret' },
    });
  });

  it("ignores the machine's own AWS credentials", () => {
    expect(datasetsConfig({ AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' }).credentials).toBeUndefined();
  });

  it('refuses a URL that is not s3://<bucket>, and half a key pair', () => {
    expect(() => datasetsConfig({ NEURONPEDIA_DATASETS_URL: 'file:///data' })).toThrow('s3://<bucket>');
    expect(() => datasetsConfig({ NEURONPEDIA_DATASETS_URL: 's3://b/prefix' })).toThrow('s3://<bucket>');
    expect(() => datasetsConfig({ NEURONPEDIA_DATASETS_ACCESS_KEY_ID: 'id' })).toThrow('or neither');
  });
});
