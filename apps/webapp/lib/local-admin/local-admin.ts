/**
 * Local administration of a Neuronpedia database: users and API keys, models with their raw-neuron
 * source set, and source-set settings.
 *
 * Each of these is a row the webapp normally gets from sign-up, from Neuronpedia's own dataset
 * bucket, or from a production admin. On a local instance none of those exist, so these write the
 * rows directly, the way `scripts/compute-host.ts` does for compute hosts. `scripts/local-admin.ts`
 * is the command line over them, and the Makefile wraps that.
 *
 * Imported by relative path from ts-node, so this file must not use the `@/` alias.
 */
import { PrismaClient, UserSecretType, Visibility } from '@prisma/client';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateNeuronpediaApiKey } from '../utils/api-key';

/** The seeded admin user (`prisma/seed.ts`), the default creator of local rows. */
export const DEFAULT_CREATOR_NAME = 'bot';

/** The source set that holds a model's raw MLP neurons, one Source per layer named by its number. */
export const NEURONS_SET_NAME = 'neurons';

const USERNAME_PATTERN = /^[a-z0-9-.]{1,39}$/;
// Real ids carry dots (`qwen3-0.6b`), so this is looser than the zod rule in schema.prisma.
const MODEL_ID_PATTERN = /^[a-z0-9-_.]{1,128}$/;

export type Db = Pick<PrismaClient, 'user' | 'userSecret' | 'model' | 'sourceSet' | 'source' | '$transaction'>;

export function parseVisibility(raw: string): Visibility {
  const value = raw.toUpperCase() as Visibility;
  if (!(value in Visibility)) {
    throw new Error(`Unknown visibility "${raw}". One of: ${Object.keys(Visibility).join(', ')}`);
  }
  return value;
}

/** Where `user-key` writes a user's key unless told otherwise. */
export function defaultKeyPath(username: string): string {
  return path.join(os.homedir(), '.config', 'neuronpedia', `${username}.key`);
}

/**
 * Write a secret to a file only its owner can read, creating the directory if needed. The secret
 * never goes to stdout, so it can't end up in a terminal log or an agent's transcript.
 */
export function writeSecretFile(filePath: string, secret: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${secret}\n`, { mode: 0o600 });
  // writeFileSync keeps an existing file's mode, so set it explicitly.
  fs.chmodSync(filePath, 0o600);
}

async function findUserIdByName(db: Db, name: string): Promise<string> {
  const user = await db.user.findUnique({ where: { name }, select: { id: true } });
  if (!user) {
    throw new Error(`No user named "${name}". Create one with: make user-key NAME=${name}`);
  }
  return user.id;
}

export type UserKeyResult = { username: string; admin: boolean; createdUser: boolean; createdKey: boolean };

/**
 * Make sure a user exists and has a Neuronpedia API key, and return that key.
 *
 * Reuses an existing key unless `rotate` is set, so running this twice hands back the same key.
 * Admin is only ever granted here, never taken away, so pointing this at the seeded `bot` user
 * cannot demote it.
 */
export async function ensureUserKey(
  db: Db,
  opts: { username: string; admin?: boolean; rotate?: boolean },
): Promise<UserKeyResult & { key: string }> {
  const username = opts.username.toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error(`"${opts.username}" is not a valid username: use letters, numbers, dashes and periods.`);
  }

  const existing = await db.user.findUnique({ where: { name: username }, select: { id: true, admin: true } });
  let admin = existing?.admin ?? false;
  if (!existing) {
    admin = Boolean(opts.admin);
    await db.user.create({ data: { name: username, admin, emailNewsletterNotification: false } });
  } else if (opts.admin && !existing.admin) {
    admin = true;
    await db.user.update({ where: { name: username }, data: { admin: true } });
  }

  const where = { username_type: { username, type: UserSecretType.NEURONPEDIA } };
  const secret = await db.userSecret.findUnique({ where });
  if (secret && !opts.rotate) {
    return { username, admin, createdUser: !existing, createdKey: false, key: secret.value };
  }

  const key = generateNeuronpediaApiKey();
  await db.userSecret.upsert({
    where,
    update: { value: key },
    create: { username, type: UserSecretType.NEURONPEDIA, value: key },
  });
  return { username, admin, createdUser: !existing, createdKey: true, key };
}

export type ModelAddOptions = {
  id: string;
  layers: number;
  neuronsPerLayer: number;
  // Width of the residual stream (hidden size). Vectors must have exactly this many floats per layer.
  dimension?: number;
  displayName?: string;
  owner?: string;
  hfRepoId?: string;
  creatorName?: string;
  visibility?: Visibility;
  dashboardsUrl?: string;
  inference?: boolean;
};

/**
 * Create a model and its raw-neuron source set: the `Model` row, a `neurons` SourceSet, and one
 * Source per layer (`0` .. `layers - 1`), with the set as the model's default unless it already has one.
 *
 * Idempotent: a second run adds any missing layers and changes only the options it was given.
 */
export async function addModelWithNeurons(db: Db, opts: ModelAddOptions) {
  const id = opts.id.toLowerCase();
  if (!MODEL_ID_PATTERN.test(id)) {
    throw new Error(`"${opts.id}" is not a valid model id: use letters, numbers, dashes, underscores and dots.`);
  }
  const creatorName = opts.creatorName ?? DEFAULT_CREATOR_NAME;
  const creatorId = await findUserIdByName(db, creatorName);
  const displayName = opts.displayName ?? id;

  // On a second run, only what was passed changes: leaving out --inference must not turn
  // inference off, and leaving out --hf-repo must not clear the repo id.
  const given = <T extends object>(fields: T) =>
    Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Partial<T>;
  const modelChanges = given({
    displayName: opts.displayName,
    displayNameShort: opts.displayName,
    owner: opts.owner,
    hfRepoId: opts.hfRepoId,
    dimension: opts.dimension,
    visibility: opts.visibility,
    inferenceEnabled: opts.inference,
  });
  const setChanges = given({
    visibility: opts.visibility,
    allowInferenceSearch: opts.inference,
    externalDashboardsUrl: opts.dashboardsUrl === undefined ? undefined : opts.dashboardsUrl || null,
  });
  const sourceChanges = given({ visibility: opts.visibility, inferenceEnabled: opts.inference });
  const visibility = opts.visibility ?? Visibility.PUBLIC;
  const inference = opts.inference ?? false;
  const layerIds = Array.from({ length: opts.layers }, (_, i) => String(i));

  // The default-set columns point at the set, which needs the model first, so the model is
  // written, then the set and sources, then the defaults.
  return db.$transaction(async (tx) => {
    const model = await tx.model.upsert({
      where: { id },
      update: { layers: opts.layers, neuronsPerLayer: opts.neuronsPerLayer, ...modelChanges },
      create: {
        id,
        creatorId,
        displayName,
        displayNameShort: displayName,
        layers: opts.layers,
        neuronsPerLayer: opts.neuronsPerLayer,
        owner: opts.owner ?? 'local',
        hfRepoId: opts.hfRepoId ?? null,
        dimension: opts.dimension ?? null,
        visibility,
        inferenceEnabled: inference,
      },
    });
    const set = await tx.sourceSet.upsert({
      where: { modelId_name: { modelId: id, name: NEURONS_SET_NAME } },
      update: setChanges,
      create: {
        modelId: id,
        name: NEURONS_SET_NAME,
        description: `MLP neurons of ${displayName}`,
        type: 'neurons',
        creatorId,
        creatorName,
        urls: [],
        visibility,
        hasDashboards: true,
        allowInferenceSearch: inference,
        externalDashboardsUrl: opts.dashboardsUrl || null,
      },
    });
    // Layers added on a re-run take the set's settings as they now stand, not the defaults.
    await tx.source.createMany({
      data: layerIds.map((layer) => ({
        id: layer,
        modelId: id,
        setName: NEURONS_SET_NAME,
        creatorId,
        visibility: set.visibility,
        inferenceEnabled: set.allowInferenceSearch,
        hasDashboards: true,
      })),
      skipDuplicates: true,
    });
    if (Object.keys(sourceChanges).length > 0) {
      await tx.source.updateMany({ where: { modelId: id, setName: NEURONS_SET_NAME }, data: sourceChanges });
    }
    // A model that already has a default (say, an SAE set imported from the bucket) keeps it.
    if (model.defaultSourceSetName) return model;
    return tx.model.update({
      where: { id },
      data: { defaultSourceSetName: NEURONS_SET_NAME, defaultSourceId: layerIds[0] ?? null },
    });
  });
}

export type SourceSetUpdate = {
  modelId: string;
  setName: string;
  /** A URL to set it, `null` to clear it, absent to leave it alone. */
  dashboardsUrl?: string | null;
  inference?: boolean;
  visibility?: Visibility;
};

/**
 * Change an existing source set: its dashboard-files URL, whether its sources take live inference
 * (the Test and Steer boxes), and its visibility, which also applies to its sources.
 */
export async function updateSourceSet(db: Db, update: SourceSetUpdate) {
  const where = { modelId_name: { modelId: update.modelId, name: update.setName } };
  const set = await db.sourceSet.findUnique({ where, select: { name: true } });
  if (!set) {
    throw new Error(`Model "${update.modelId}" has no source set "${update.setName}".`);
  }
  if (update.dashboardsUrl === undefined && update.inference === undefined && update.visibility === undefined) {
    throw new Error('Nothing to change: pass at least one of --dashboards-url, --inference, --visibility.');
  }

  return db.$transaction(async (tx) => {
    const updated = await tx.sourceSet.update({
      where,
      data: {
        ...(update.dashboardsUrl !== undefined ? { externalDashboardsUrl: update.dashboardsUrl } : {}),
        ...(update.inference !== undefined ? { allowInferenceSearch: update.inference } : {}),
        ...(update.visibility !== undefined ? { visibility: update.visibility } : {}),
      },
    });
    const sourceData = {
      ...(update.inference !== undefined ? { inferenceEnabled: update.inference } : {}),
      ...(update.visibility !== undefined ? { visibility: update.visibility } : {}),
    };
    if (Object.keys(sourceData).length > 0) {
      await tx.source.updateMany({ where: { modelId: update.modelId, setName: update.setName }, data: sourceData });
    }
    // A model only offers live inference when the model itself is enabled too.
    if (update.inference) {
      await tx.model.update({ where: { id: update.modelId }, data: { inferenceEnabled: true } });
    }
    return updated;
  });
}
