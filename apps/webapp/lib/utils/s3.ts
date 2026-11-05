import { GetObjectCommand, ListObjectsV2Command, S3 } from '@aws-sdk/client-s3';
import fs from 'fs';
import { ungzip } from 'node-gzip';
import path from 'path';
import { getLayerNumFromSource, getSourceSetNameFromSource } from './source';

// Server-only: it can hold the datasets bucket's credentials, and reads the filesystem for file://. The admin pages list datasets
// through the server action in datasets-index.ts rather than importing this.

export const DATASET_BUCKET = 'neuronpedia-datasets';
export const DATASET_REGION = 'us-east-1';
export const DATASET_VERSION = 'v1';
export const DATASET_BASE_PATH = `${DATASET_VERSION}/`;
export const CONFIG_DIR_NAME = 'config';
export const CONFIG_BASE_PATH = `${DATASET_BASE_PATH}${CONFIG_DIR_NAME}/`;

export type DatasetsConfig =
  | {
      kind: 's3';
      bucket: string;
      region: string;
      endpoint?: string;
      credentials?: { accessKeyId: string; secretAccessKey: string };
    }
  | { kind: 'file'; dir: string };

/**
 * Where the admin importers read datasets from. Unset, it is Neuronpedia's public bucket, read
 * anonymously. NEURONPEDIA_DATASETS_URL=s3://<bucket> names another bucket laid out the same way
 * (`v1/config/...`, `v1/<model>/<source>/...`). For an S3-compatible store such as Cloudflare R2,
 * also set NEURONPEDIA_DATASETS_ENDPOINT (and NEURONPEDIA_DATASETS_REGION, `auto` for R2). With
 * NEURONPEDIA_DATASETS_ACCESS_KEY_ID and NEURONPEDIA_DATASETS_SECRET_ACCESS_KEY requests are
 * signed, which R2 always needs. These are separate from AWS_*, so a machine's own AWS
 * credentials never sign requests to the public bucket.
 *
 * NEURONPEDIA_DATASETS_URL=file:///abs/path reads a local directory with the same layout instead,
 * for exports that were never uploaded anywhere.
 */
export function datasetsConfig(env: Record<string, string | undefined>): DatasetsConfig {
  const url = env.NEURONPEDIA_DATASETS_URL || `s3://${DATASET_BUCKET}`;
  if (url.startsWith('file://')) {
    const dir = decodeURIComponent(url.slice('file://'.length));
    if (!path.isAbsolute(dir)) {
      throw new Error(`NEURONPEDIA_DATASETS_URL must be file:///<absolute path>, not ${url}`);
    }
    return { kind: 'file', dir: path.resolve(dir) };
  }
  const match = /^s3:\/\/([^/]+)\/?$/.exec(url);
  if (!match) {
    throw new Error(`NEURONPEDIA_DATASETS_URL must look like s3://<bucket> or file:///<path>, not ${url}`);
  }
  const accessKeyId = env.NEURONPEDIA_DATASETS_ACCESS_KEY_ID;
  const secretAccessKey = env.NEURONPEDIA_DATASETS_SECRET_ACCESS_KEY;
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error(
      'Set both NEURONPEDIA_DATASETS_ACCESS_KEY_ID and NEURONPEDIA_DATASETS_SECRET_ACCESS_KEY, or neither',
    );
  }
  return {
    kind: 's3',
    bucket: match[1],
    region: env.NEURONPEDIA_DATASETS_REGION || DATASET_REGION,
    endpoint: env.NEURONPEDIA_DATASETS_ENDPOINT || undefined,
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
  };
}

export function makeDatasetsClient(config: Extract<DatasetsConfig, { kind: 's3' }>): S3 {
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

type ObjectListing = { prefixes: string[]; keys: string[] };

/** A dataset key as a path inside `root`, refusing any key that would leave it. */
export function localDatasetPath(root: string, key: string): string {
  const base = path.resolve(root);
  const resolved = path.resolve(base, key);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Dataset path escapes the datasets directory: ${key}`);
  }
  return resolved;
}

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(full) : [full];
  });
}

/** List keys under a prefix in a local datasets directory, with S3's delimiter semantics. */
export function listLocalDatasets(root: string, prefix: string, delimiter?: string): ObjectListing {
  const dirKey = prefix.slice(0, prefix.lastIndexOf('/') + 1);
  const searchDir = localDatasetPath(root, dirKey);
  if (delimiter === '/' && dirKey === prefix) {
    // One directory level, which is all the admin listing asks for; no need to walk the tree.
    if (!fs.existsSync(searchDir)) return { prefixes: [], keys: [] };
    const entries = fs.readdirSync(searchDir, { withFileTypes: true });
    return {
      prefixes: entries
        .filter((e) => e.isDirectory())
        .map((e) => `${prefix}${e.name}/`)
        .sort(),
      keys: entries
        .filter((e) => e.isFile())
        .map((e) => `${prefix}${e.name}`)
        .sort(),
    };
  }
  const base = path.resolve(root);
  const keys = walkFiles(searchDir)
    .map((file) => path.relative(base, file).split(path.sep).join('/'))
    .filter((key) => key.startsWith(prefix))
    .sort();
  if (!delimiter) {
    return { prefixes: [], keys };
  }
  const prefixes = new Set<string>();
  const direct: string[] = [];
  keys.forEach((key) => {
    const rest = key.slice(prefix.length);
    const cut = rest.indexOf(delimiter);
    if (cut === -1) direct.push(key);
    else prefixes.add(prefix + rest.slice(0, cut + delimiter.length));
  });
  return { prefixes: Array.from(prefixes).sort(), keys: direct };
}

const DATASETS = datasetsConfig(process.env);
const datasetsClient = DATASETS.kind === 's3' ? makeDatasetsClient(DATASETS) : null;

async function downloadBytes(key: string): Promise<Uint8Array | undefined> {
  if (DATASETS.kind === 'file') {
    const file = localDatasetPath(DATASETS.dir, key);
    if (!fs.existsSync(file)) {
      throw new Error(`File not found in ${DATASETS.dir}: ${key}`);
    }
    return fs.readFileSync(file);
  }
  const response = await datasetsClient!.send(new GetObjectCommand({ Bucket: DATASETS.bucket, Key: key }));
  return response.Body?.transformToByteArray();
}

async function listObjects(prefix: string, delimiter?: string): Promise<ObjectListing> {
  if (DATASETS.kind === 'file') {
    return listLocalDatasets(DATASETS.dir, prefix, delimiter);
  }
  const response = await datasetsClient!.send(
    new ListObjectsV2Command({ Bucket: DATASETS.bucket, Prefix: prefix, Delimiter: delimiter }),
  );
  return {
    prefixes: response.CommonPrefixes?.map((p) => p.Prefix || '').filter(Boolean) || [],
    keys: response.Contents?.map((c) => c.Key || '').filter(Boolean) || [],
  };
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
  const s3models = (await listObjects(DATASET_BASE_PATH, '/')).prefixes;

  const s3modelToSources: Record<string, string[]> = Object.fromEntries(
    await Promise.all(
      s3models.map(async (model) => {
        const { prefixes } = await listObjects(model, '/');
        return [model.replace(DATASET_BASE_PATH, '').replace('/', ''), prefixes.map((prefix) => prefix.split('/')[2])];
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
  prefix: string,
  filterByFileSuffix?: string,
  includeSubdirectories: boolean = true,
): Promise<string[]> {
  const files =
    (await listObjects(prefix)).keys
      .filter((file) => {
        if (includeSubdirectories) return true;
        // Extract the part of the path after the prefix, truncating the first slash. eg "v1/activations/batch-1.json.gz" -> "/batch-1.json.gz" -> "batch-1.json.jz"
        const relativePath = file.substring(prefix.length).substring(1);
        // if it still has a slash, it's in a subdirectory
        return !relativePath.includes('/');
      })
      .filter((file) => (filterByFileSuffix ? file.endsWith(filterByFileSuffix) : true)) || [];
  console.log('Files in path', files);
  return files;
}

export async function downloadAndDecompressFile(key: string): Promise<string> {
  console.log('Downloading and decompressing file', key);
  const bytes = await downloadBytes(key);
  return bytes ? (await ungzip(Buffer.from(bytes))).toString() : '';
}

async function downloadFileAsString(key: string): Promise<string> {
  const bytes = await downloadBytes(key);
  if (!bytes) {
    throw new Error('File not found');
  }
  return Buffer.from(bytes).toString('utf8');
}

export async function downloadFileJsonlParsedLines(key: string): Promise<any[]> {
  const file = await downloadFileAsString(key);
  return file.split('\n').filter(Boolean).map(parseLine);
}
