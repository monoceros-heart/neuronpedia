import { GetObjectCommand, ListObjectsV2Command, S3 } from '@aws-sdk/client-s3';
import { ungzip } from 'node-gzip';
import { getLayerNumFromSource, getSourceSetNameFromSource } from './source';

// Server-only: it can hold the datasets bucket's credentials. The admin pages list datasets
// through the server action in datasets-index.ts rather than importing this.

export const DATASET_BUCKET = 'neuronpedia-datasets';
export const DATASET_REGION = 'us-east-1';
export const DATASET_VERSION = 'v1';
export const DATASET_BASE_PATH = `${DATASET_VERSION}/`;
export const CONFIG_DIR_NAME = 'config';
export const CONFIG_BASE_PATH = `${DATASET_BASE_PATH}${CONFIG_DIR_NAME}/`;

export type DatasetsConfig = {
  bucket: string;
  region: string;
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
};

/**
 * Where the admin importers read datasets from. Unset, it is Neuronpedia's public bucket, read
 * anonymously. NEURONPEDIA_DATASETS_URL=s3://<bucket> names another bucket laid out the same way
 * (`v1/config/...`, `v1/<model>/<source>/...`). For an S3-compatible store such as Cloudflare R2,
 * also set NEURONPEDIA_DATASETS_ENDPOINT (and NEURONPEDIA_DATASETS_REGION, `auto` for R2). With
 * NEURONPEDIA_DATASETS_ACCESS_KEY_ID and NEURONPEDIA_DATASETS_SECRET_ACCESS_KEY requests are
 * signed, which R2 always needs. These are separate from AWS_*, so a machine's own AWS
 * credentials never sign requests to the public bucket.
 */
export function datasetsConfig(env: Record<string, string | undefined>): DatasetsConfig {
  const url = env.NEURONPEDIA_DATASETS_URL || `s3://${DATASET_BUCKET}`;
  const match = /^s3:\/\/([^/]+)\/?$/.exec(url);
  if (!match) {
    throw new Error(`NEURONPEDIA_DATASETS_URL must look like s3://<bucket>, not ${url}`);
  }
  const accessKeyId = env.NEURONPEDIA_DATASETS_ACCESS_KEY_ID;
  const secretAccessKey = env.NEURONPEDIA_DATASETS_SECRET_ACCESS_KEY;
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error(
      'Set both NEURONPEDIA_DATASETS_ACCESS_KEY_ID and NEURONPEDIA_DATASETS_SECRET_ACCESS_KEY, or neither',
    );
  }
  return {
    bucket: match[1],
    region: env.NEURONPEDIA_DATASETS_REGION || DATASET_REGION,
    endpoint: env.NEURONPEDIA_DATASETS_ENDPOINT || undefined,
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
  };
}

export function makeDatasetsClient(config: DatasetsConfig): S3 {
  return new S3({
    region: config.region,
    endpoint: config.endpoint,
    // A custom endpoint is usually R2 or MinIO, which want the bucket in the path.
    forcePathStyle: Boolean(config.endpoint),
    ...(config.credentials
      ? { credentials: config.credentials }
      : { credentials: { accessKeyId: '', secretAccessKey: '' }, signer: { sign: async (req) => req } }),
  });
}

const DATASETS = datasetsConfig(process.env);
export const datasetsClient = makeDatasetsClient(DATASETS);

async function downloadFile(path: string) {
  const response = await datasetsClient.send(
    new GetObjectCommand({
      Bucket: DATASETS.bucket,
      Key: path,
    }),
  );
  return response.Body;
}

export async function listBucketAtPath(path: string, delimiter?: string) {
  const response = await datasetsClient.send(
    new ListObjectsV2Command({
      Bucket: DATASETS.bucket,
      Prefix: path,
      Delimiter: delimiter,
    }),
  );
  return response;
}

export function parseLine(line: string) {
  const parsedData = JSON.parse(line);
  if (parsedData.createdAt) {
    parsedData.createdAt = new Date(parsedData.createdAt);
  }
  if (parsedData.updatedAt) {
    parsedData.updatedAt = new Date(parsedData.updatedAt);
  }
  return parsedData;
}

export async function getS3ModelsToSources() {
  const s3ModelsResponse = await listBucketAtPath(DATASET_BASE_PATH, '/');
  const s3models = s3ModelsResponse.CommonPrefixes?.map((content) => content.Prefix || '') || [];

  const s3modelToSources: Record<string, string[]> = Object.fromEntries(
    await Promise.all(
      s3models.map(async (model) => {
        const response = await listBucketAtPath(model, '/');
        return [
          model.replace(DATASET_BASE_PATH, '').replace('/', ''),
          response.CommonPrefixes?.map((content) => content.Prefix?.split('/')[2]) || [],
        ];
      }),
    ),
  );
  Object.keys(s3modelToSources).forEach((model) => {
    if (model === CONFIG_DIR_NAME) {
      delete s3modelToSources[model];
    }
  });
  // Sort sources for each model
  Object.keys(s3modelToSources).forEach((model) => {
    s3modelToSources[model].sort((a, b) => {
      const sourceSetA = getSourceSetNameFromSource(a || '');
      const sourceSetB = getSourceSetNameFromSource(b || '');
      if (sourceSetA !== sourceSetB) {
        return sourceSetA.localeCompare(sourceSetB);
      }
      return getLayerNumFromSource(a || '') - getLayerNumFromSource(b || '');
    });
  });
  return s3modelToSources;
}

export async function getFilesInPath(
  path: string,
  filterByFileSuffix?: string,
  includeSubdirectories: boolean = true,
): Promise<string[]> {
  const response = await datasetsClient.send(
    new ListObjectsV2Command({
      Bucket: DATASETS.bucket,
      Prefix: path,
    }),
  );
  const files =
    response.Contents?.map((content) => content.Key || '')
      .filter(Boolean)
      .filter((file) => {
        if (includeSubdirectories) return true;
        // Extract the part of the path after the prefix, truncating the first slash. eg "v1/activations/batch-1.json.gz" -> "/batch-1.json.gz" -> "batch-1.json.jz"
        const relativePath = file.substring(path.length).substring(1);
        // if it still has a slash, it's in a subdirectory
        return !relativePath.includes('/');
      })
      .filter((file) => (filterByFileSuffix ? file.endsWith(filterByFileSuffix) : true)) || [];
  console.log('Files in path', files);
  return files;
}

export async function downloadAndDecompressFile(path: string): Promise<string> {
  console.log('Downloading and decompressing file', path);
  const file = await downloadFile(path);
  const arrayBuffer = await file?.transformToByteArray();
  return arrayBuffer ? (await ungzip(Buffer.from(arrayBuffer))).toString() : '';
}

async function downloadFileAsString(path: string): Promise<string> {
  const file = await downloadFile(path);
  if (!file) {
    throw new Error('File not found');
  }
  return file?.transformToString() || '';
}

export async function downloadFileJsonlParsedLines(path: string): Promise<any[]> {
  const file = await downloadFileAsString(path);
  return file.split('\n').filter(Boolean).map(parseLine);
}
